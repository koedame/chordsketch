/**
 * Auto-update driver for the ChordSketch desktop app (#2076).
 *
 * Calls `@tauri-apps/plugin-updater`'s `check()` on launch and on a
 * 24-hour interval; if an update is available and the user hasn't
 * opted out, prompts the user with the version + release notes and
 * performs a signed download + install + relaunch via
 * `@tauri-apps/plugin-process`.
 *
 * Key facts about the security model:
 *
 * - The manifest URL (configured in `tauri.conf.json`'s
 *   `plugins.updater.endpoints`) points at a GitHub Releases asset
 *   which we control. A MITM on that endpoint cannot push rogue
 *   updates because every binary referenced by the manifest is
 *   signed with the Ed25519 key whose public half is baked into the
 *   app. The updater rejects anything that fails signature
 *   verification.
 *
 * - The 24-hour interval is best-effort — if the app sleeps it
 *   picks up on resume, and a failed check (offline, CDN blip)
 *   never blocks the user; subsequent checks retry.
 *
 * - Opt-out is stored in `localStorage` under a versioned key so a
 *   future "always update" forced-policy change can invalidate
 *   stale opt-outs without a migration.
 */
import { invoke } from '@tauri-apps/api/core';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OPT_OUT_KEY = 'chordsketch-desktop-auto-update-opt-out/v1';

let selfUpdateEnabled: Promise<boolean> | null = null;

/**
 * Does this installation update itself? `false` inside Flatpak, where
 * the store delivers new versions and the Rust side does not register
 * the updater plugin at all (`self_update_enabled` in `main.rs`). Asked
 * once: the answer cannot change while the app runs.
 */
export function isSelfUpdateEnabled(): Promise<boolean> {
  selfUpdateEnabled ??= invoke<boolean>('self_update_enabled');
  return selfUpdateEnabled;
}

/** Is the user opted out of automatic update checks? */
export function isAutoUpdateOptedOut(): boolean {
  try {
    return window.localStorage.getItem(OPT_OUT_KEY) === 'true';
  } catch (err) {
    // Safari private mode / sandboxed iframe — treat as not
    // opted out so the default behaviour is "check for updates".
    // Log so the failure is observable rather than swallowed.
    // eslint-disable-next-line no-console
    console.warn('Failed to read auto-update opt-out preference:', err);
    return false;
  }
}

/**
 * Persist the user's opt-out preference. Returns `true` on success,
 * `false` if the write fails (e.g. private mode, quota exceeded).
 * {@link toggleAutoUpdate} reacts to the `false` return by leaving
 * the running session's check loop exactly as it was and surfacing
 * a dialog — changing in-session behaviour that the stored
 * preference (and the Help-menu checkbox that reads it) disagrees
 * with would desync what the user sees from what actually happens.
 */
export function setAutoUpdateOptOut(optOut: boolean): boolean {
  try {
    if (optOut) {
      window.localStorage.setItem(OPT_OUT_KEY, 'true');
    } else {
      window.localStorage.removeItem(OPT_OUT_KEY);
    }
    return true;
  } catch (err) {
    // Persistence failure is a convenience loss, not a
    // correctness failure — the check/no-check decision falls
    // back to "check" on next launch. Log so the failure is
    // observable; callers can surface a dialog warning the user
    // their preference will need to be reapplied next launch.
    // eslint-disable-next-line no-console
    console.warn('Failed to persist auto-update opt-out preference:', err);
    return false;
  }
}

/**
 * Check for a pending update once. If one is available, prompt the
 * user and (on accept) download + install + relaunch.
 *
 * The `silent` mode is used for the 24-hour background re-check —
 * no dialog shown if the check itself fails, no "you're up to
 * date" confirmation. The `silent: false` mode is used for a
 * menu-driven "Check for updates now" action: it bypasses the
 * opt-out preference so the user always gets feedback on an
 * explicit click even if auto-checking is disabled. The Help menu
 * ("Check for Updates Now") calls this path.
 */
export async function checkForUpdates(
  options: { silent?: boolean } = {},
): Promise<void> {
  const silent = options.silent ?? true;

  if (!(await isSelfUpdateEnabled())) {
    if (!silent) {
      await message(
        'Updates for this installation come from the software store it was installed from.',
        { title: 'ChordSketch', kind: 'info' },
      );
    }
    return;
  }

  // Respect opt-out for background auto-checks (silent: true).
  // An explicit user-triggered check (silent: false) bypasses this
  // so "Check for updates now" works even when auto-update is off.
  if (isAutoUpdateOptedOut() && silent) {
    return;
  }

  let update: Awaited<ReturnType<typeof check>>;
  try {
    update = await check();
  } catch (err) {
    if (!silent) {
      await message(
        err instanceof Error ? err.message : String(err),
        { title: 'Update check failed', kind: 'error' },
      );
    }
    return;
  }

  if (!update) {
    if (!silent) {
      await message('ChordSketch is up to date.', {
        title: 'ChordSketch',
        kind: 'info',
      });
    }
    return;
  }

  // Re-check the opt-out preference between `check()` resolving
  // and the user-facing dialog: a background check that started
  // while the user was still opted-in can race against a subsequent
  // toggle (`check()` takes ~1 s on a cold network). Without this
  // guard, a user who opts out mid-check would still see the
  // "Update available" prompt a beat later.
  //
  // The `&& silent` mirrors the first guard: a manual
  // "Check for updates now" (silent: false) bypasses opt-out even
  // here, so an explicit user action always produces feedback.
  if (isAutoUpdateOptedOut() && silent) {
    return;
  }

  // `update.body` is empty when the GitHub release has no description
  // (e.g. a hotfix tag that skipped --generate-notes, or a release where
  // the body was manually cleared). `formatReleaseNotes('')` returns ''
  // and the dialog then renders two consecutive blank lines between
  // the version line and the "Install now?" question, which reads as
  // a broken prompt. Substitute a neutral fallback before formatting.
  const rawBody = update.body?.trim()
    ? update.body
    : 'See the GitHub release page for details.';
  const summary = formatReleaseNotes(rawBody);
  const confirmed = await ask(
    `ChordSketch ${update.version} is available.\n\n${summary}\n\nInstall now?`,
    {
      title: 'Update available',
      kind: 'info',
      okLabel: 'Install now',
      cancelLabel: 'Later',
    },
  );
  if (!confirmed) return;

  try {
    // `downloadAndInstall` verifies the Ed25519 signature from the
    // manifest against the pubkey embedded in `tauri.conf.json`.
    // A bad signature causes this call to throw before any bytes
    // hit disk — no rogue installer can land even if the release
    // CDN is compromised.
    await update.downloadAndInstall();
    // Installation replaces the on-disk binary; relaunch picks up
    // the new version. On macOS the relaunch returns control to
    // the user after the app quits; the new process starts
    // automatically.
    await relaunch();
  } catch (err) {
    await message(
      err instanceof Error ? err.message : String(err),
      { title: 'Update install failed', kind: 'error' },
    );
  }
}

/**
 * Trim the release-notes body to the first handful of lines so the
 * `ask()` dialog stays compact. Dialogs with 30+ lines of body
 * text are hard to skim and push the Install/Later buttons off
 * screen on small laptops. Users can still read the full notes
 * via the GitHub release page linked from the About menu (to land
 * with #2199).
 */
const RELEASE_NOTES_LINE_LIMIT = 12;
function formatReleaseNotes(body: string): string {
  const lines = body.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length <= RELEASE_NOTES_LINE_LIMIT) return lines.join('\n');
  const kept = lines.slice(0, RELEASE_NOTES_LINE_LIMIT);
  return `${kept.join('\n')}\n…`;
}

/**
 * Start the auto-update loop. Fires an immediate check, then
 * re-checks every {@link CHECK_INTERVAL_MS}. Returns a cancel
 * function so a future settings-change or test-harness teardown
 * can stop the loop cleanly.
 */
export function startAutoUpdateLoop(): () => void {
  // Fire-and-forget; each call handles its own errors.
  void checkForUpdates();
  const timer = window.setInterval(() => {
    void checkForUpdates();
  }, CHECK_INTERVAL_MS);
  return () => window.clearInterval(timer);
}

/**
 * Cancel handle for the running loop, or `null` while opted out.
 * Module-scoped so {@link toggleAutoUpdate} can stop/restart the
 * same loop {@link armAutoUpdateLoop} started at boot.
 */
let autoUpdateCancel: (() => void) | null = null;

/**
 * Start the boot-time update loop. Call once during startup; the
 * loop itself already re-checks `isAutoUpdateOptedOut()` on every
 * tick, so it is safe — and intentional — to arm it unconditionally
 * even for an opted-out user (`checkForUpdates` no-ops for them).
 */
export function armAutoUpdateLoop(): void {
  autoUpdateCancel = startAutoUpdateLoop();
}

/**
 * Toggle the "Check for updates automatically" preference. Stops
 * the running loop when the user opts out, and restarts it on the
 * way back in so the next tick isn't a day away.
 *
 * The loop is only started or stopped once the new preference is
 * actually persisted. If `setAutoUpdateOptOut` cannot save it (e.g.
 * full disk), the running session's behaviour must stay exactly
 * what the stored preference says it is — `checkForUpdates` reads
 * that same stored flag on every tick, and the Help-menu checkbox
 * (`isAutoUpdateOptedOut`) reads it too. Changing the loop's
 * running state on an unsaved toggle would desync "what the
 * checkbox shows" from "whether checks actually still happen" for
 * the rest of the session. Instead we surface a dialog so the user
 * knows their click did not take effect and will need to be
 * reapplied next launch.
 */
export async function toggleAutoUpdate(): Promise<void> {
  const nextOptedOut = !isAutoUpdateOptedOut();
  const persisted = setAutoUpdateOptOut(nextOptedOut);
  if (!persisted) {
    await message(
      'Your auto-update preference could not be saved and will need to ' +
        'be reapplied on the next launch.',
      { title: 'Could not save preference', kind: 'warning' },
    );
    return;
  }
  if (nextOptedOut) {
    autoUpdateCancel?.();
    autoUpdateCancel = null;
  } else if (!autoUpdateCancel) {
    autoUpdateCancel = startAutoUpdateLoop();
  }
}

/**
 * One-shot "Check for updates now" action — always runs, even if
 * auto-update is opted out, and shows the "up to date" dialog so
 * the user gets feedback on the explicit click.
 */
export async function checkForUpdatesNow(): Promise<void> {
  await checkForUpdates({ silent: false });
}

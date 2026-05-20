/**
 * Imperative bridge between the React `<App />` tree and the Tauri
 * menu / dialog / updater layer that lives outside React.
 *
 * The Tauri menu items, native dialogs, and window-close guard are
 * created once at boot in `main.tsx` and persist for the lifetime
 * of the process; they cannot consume React state directly. The
 * bridge is the seam: `<App />` calls {@link attach} on mount to
 * publish the current set of state mutators + accessors, and the
 * Tauri-facing handlers read/write through the bridge.
 *
 * Only one consumer ({@link DesktopBridgeListener}) is attached at a
 * time — the bridge is a singleton, not an event bus, because the
 * desktop window only hosts a single React root. Attaching a
 * second listener replaces the first.
 *
 * Design rationale: React owns state and publishes a handle outward
 * via this singleton. Tauri-side menu handlers stay imperative
 * (calling `bridge.setSource(value)` / `bridge.focusEditor()` etc.)
 * while React handles rendering, controlled inputs, and component
 * lifecycles cleanly.
 */

/**
 * Editor mode shared by `<App />` and the View menu radio pair.
 * Kept in lockstep with the matching type in `App.tsx`.
 */
export type EditorMode = 'chordpro' | 'irealb-grid' | 'irealb-text';

/**
 * The state surface React `<App />` exposes to the Tauri layer.
 * Every method is synchronous from React's perspective — internal
 * state updates batch normally; callers should treat them as
 * fire-and-forget. The read-side accessors return the most recent
 * committed React state value at call time — see the bridge-attach
 * `useEffect` in `App.tsx` for the synchronous-read contract.
 */
export interface DesktopBridgeListener {
  /** Read the current editor buffer. */
  getSource(): string;
  /** Replace the editor buffer. Bypasses dirty-tracking onChange. */
  setSource(value: string): void;
  /** Read the current editor mode. */
  getMode(): EditorMode;
  /** Swap the editor mode. */
  setMode(mode: EditorMode): void;
  /** Read the current transpose offset. */
  getTranspose(): number;
  /** Bump the transpose offset by a signed delta. */
  stepTranspose(delta: number): void;
  /** Reset the transpose offset to 0. */
  resetTranspose(): void;
  /** Move keyboard focus into the editor pane. */
  focusEditor(): void;
  /** Move keyboard focus into the preview pane. */
  focusPreview(): void;
}

/**
 * Internal listener storage. `null` while no React root is mounted
 * (between hot-reloads, during test setup). Every accessor on the
 * exported bridge guards on this value and throws a descriptive
 * error if the React tree has not registered yet — the alternative
 * is silent no-ops, which would make a missing `attach()` call hard
 * to diagnose.
 */
let listener: DesktopBridgeListener | null = null;

/** Side-channel for change-notification subscribers (see {@link onSourceChange}). */
type SourceChangeHandler = (value: string) => void;
const sourceChangeHandlers = new Set<SourceChangeHandler>();

/**
 * True when running under a Vite dev server (HMR is active). Used
 * by `attach()` to gate the "replacing existing listener" warning
 * so production builds stay quiet. `import.meta.env.DEV` is
 * Vite-injected and inlined at build time; the optional-chain
 * guards a vitest / jest / non-Vite test runner where
 * `import.meta.env` may be absent.
 */
function isDevelopmentBuild(): boolean {
  try {
    return Boolean(
      (import.meta as { env?: { DEV?: boolean } }).env?.DEV,
    );
  } catch {
    return false;
  }
}

function requireListener(): DesktopBridgeListener {
  if (listener === null) {
    throw new Error(
      'desktopBridge: no React listener is attached. ' +
        'This usually means a Tauri menu handler ran before <App /> mounted.',
    );
  }
  return listener;
}

/**
 * Bridge surface consumed by Tauri menu / dialog / updater code.
 * The shape is intentionally narrow — only state mutation + a tiny
 * change-notification side channel. File I/O lives in `main.tsx`
 * because it depends on the Tauri APIs directly.
 */
export const desktopBridge = {
  /**
   * Register the React-side listener. Returns a detach function
   * that should be called from React on unmount. Replacing an
   * existing listener is allowed (HMR re-renders); the previous
   * listener is dropped.
   *
   * In development builds we log a warning when an existing
   * listener is replaced — typically this is HMR-driven and
   * harmless, but seeing it outside of HMR is a signal that a
   * second `<App />` was accidentally mounted into the same
   * window. Production builds skip the warning to avoid noise in
   * shipped consoles.
   */
  attach(next: DesktopBridgeListener): () => void {
    if (listener !== null && isDevelopmentBuild()) {
      // eslint-disable-next-line no-console
      console.warn(
        'desktopBridge.attach: replacing an existing listener. ' +
          'If this is not an HMR reload, a second <App /> may have been ' +
          'mounted into the same window.',
      );
    }
    listener = next;
    return () => {
      if (listener === next) listener = null;
    };
  },

  /** True when a React listener is attached. */
  isAttached(): boolean {
    return listener !== null;
  },

  getSource(): string {
    return requireListener().getSource();
  },
  setSource(value: string): void {
    requireListener().setSource(value);
  },
  getMode(): EditorMode {
    return requireListener().getMode();
  },
  setMode(mode: EditorMode): void {
    requireListener().setMode(mode);
  },
  getTranspose(): number {
    return requireListener().getTranspose();
  },
  stepTranspose(delta: number): void {
    requireListener().stepTranspose(delta);
  },
  resetTranspose(): void {
    requireListener().resetTranspose();
  },
  focusEditor(): void {
    requireListener().focusEditor();
  },
  focusPreview(): void {
    requireListener().focusPreview();
  },

  /**
   * Subscribe to source changes. Used by `main.tsx` to drive the
   * window-title dirty-marker update on every edit. Returns the
   * unsubscribe function. Multiple subscribers are supported (one
   * per registered consumer); React is NOT one of them — React
   * sees its own setState calls directly.
   */
  onSourceChange(handler: SourceChangeHandler): () => void {
    sourceChangeHandlers.add(handler);
    return () => {
      sourceChangeHandlers.delete(handler);
    };
  },

  /**
   * Fire the source-change side channel. Called by `<App />` after
   * every user edit. Internal — not part of the public Tauri-facing
   * surface; exposed so the React state-update path can drive the
   * subscribers without a layer of indirection.
   *
   * Named with a leading underscore to flag that this method is
   * not part of the documented Tauri-facing surface; only
   * `<App />` should call it. Renaming from `notifySourceChange`
   * (no underscore) made the access-control intent visible to
   * future consumers reading the bridge surface alphabetically.
   *
   * @internal
   */
  _notifySourceChange(value: string): void {
    for (const handler of sourceChangeHandlers) {
      try {
        handler(value);
      } catch (err) {
        // A misbehaving subscriber must not break the next one in
        // the set — log + continue. The desktop window-title
        // update is the only known subscriber and it does not
        // throw, but defensive iteration is cheap.
        // eslint-disable-next-line no-console
        console.error('desktopBridge.onSourceChange handler threw', err);
      }
    }
  },
};

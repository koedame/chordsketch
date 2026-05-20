// Default section-label prompt + delete-confirm hooks used by
// `<IrealBarGrid>`'s structural editing. Sister-site to
// `packages/ui-irealb-editor/src/index.ts`'s
// `defaultPromptSectionLabel` / `defaultConfirmDeleteSection` /
// `parseSectionLabel` (lines 685-754). Kept in their own file so
// tests can inject overrides without re-importing the main
// `<IrealBarGrid>` module.

import type { IrealSectionLabel } from './ireal-ast';
import { formatSectionLabelForPrompt } from './ireal-bar-grid-defaults';

/**
 * Parse a free-text section label into the closest
 * `IrealSectionLabel` variant. Empty input is treated as
 * cancellation (returns `null`). Single A–Z letter
 * (case-insensitive, normalised to uppercase) → `letter`; named
 * variants (`verse` / `chorus` / `intro` / `outro` / `bridge`,
 * case-insensitive) map to their dedicated variant; anything else
 * falls into `custom` so unusual labels survive the round trip.
 *
 * Sister-site: `packages/ui-irealb-editor/src/index.ts`
 * `parseSectionLabel`.
 */
export function parseIrealSectionLabel(s: string): IrealSectionLabel | null {
  const trimmed = s.trim();
  if (trimmed === '') return null;
  if (trimmed.length === 1) {
    const upper = trimmed.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') {
      return { kind: 'letter', value: upper };
    }
  }
  switch (trimmed.toLowerCase()) {
    case 'verse':
      return { kind: 'verse' };
    case 'chorus':
      return { kind: 'chorus' };
    case 'intro':
      return { kind: 'intro' };
    case 'outro':
      return { kind: 'outro' };
    case 'bridge':
      return { kind: 'bridge' };
    default:
      return { kind: 'custom', value: trimmed };
  }
}

/**
 * Default `promptSectionLabel`: ask via `window.prompt`, parse the
 * reply through `parseIrealSectionLabel`. Empty / cancelled returns
 * `null`. Sister-site: `packages/ui-irealb-editor/src/index.ts`
 * `defaultPromptSectionLabel`.
 *
 * Hosts that need a styled prompt (e.g. a custom modal dialog) can
 * override via `<IrealBarGrid>`'s `promptSectionLabel` prop. The
 * default is `window.prompt` to keep the package's runtime
 * dependency footprint at zero — adding a styled prompt would
 * require a dialog primitive every host would have to opt into.
 */
export function defaultPromptSectionLabel(
  current: IrealSectionLabel | null,
): IrealSectionLabel | null {
  const seed = current !== null ? formatSectionLabelForPrompt(current) : 'A';
  const reply = window.prompt(
    'Section label (A–Z, Verse, Chorus, Intro, Outro, Bridge, or any text):',
    seed,
  );
  if (reply === null) return null;
  return parseIrealSectionLabel(reply);
}

/**
 * Default delete-section confirmation. Sister-site:
 * `packages/ui-irealb-editor/src/index.ts`
 * `defaultConfirmDeleteSection`.
 */
export function defaultConfirmDeleteSection(label: IrealSectionLabel): boolean {
  return window.confirm(`Delete section "${formatSectionLabelForPrompt(label)}"?`);
}

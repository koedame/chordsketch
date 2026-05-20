// Default-value constructors + structural-equality helpers for
// `<IrealBarGrid>`'s bar grid + structural editing. Sister-site to
// `packages/ui-irealb-editor/src/index.ts` (the `makeDefaultBar`,
// `makeDefaultSection`, `sectionLabelEquals`, and
// `formatSectionLabelForPrompt` helpers there); kept in their own
// file so tests can mock the prompt path without leaking into the
// main `<IrealBarGrid>` module.

import type {
  IrealBar,
  IrealSection,
  IrealSectionLabel,
} from './ireal-ast';

/** Default new bar — single barlines, no chords, no ending, no
 * symbol. Used by `addBar` and by `addSection` (which seeds the
 * new section with one starter bar so the user can immediately
 * click to open the popover when it lands). Sister-site:
 * `packages/ui-irealb-editor/src/index.ts` `makeDefaultBar`. */
export function makeDefaultBar(): IrealBar {
  return {
    start: 'single',
    end: 'single',
    chords: [],
    ending: null,
    symbol: null,
  };
}

/** Default new section: the supplied label + one default bar.
 * Sister-site: `packages/ui-irealb-editor/src/index.ts`
 * `makeDefaultSection`. */
export function makeDefaultSection(label: IrealSectionLabel): IrealSection {
  return { label, bars: [makeDefaultBar()] };
}

/** Structural equality on `IrealSectionLabel`. Used by `renameSection`
 * to suppress a no-op edit (which would otherwise dispatch a
 * duplicate-URL `onChange` that subscribers cannot distinguish
 * from a real edit). Sister-site:
 * `packages/ui-irealb-editor/src/index.ts` `sectionLabelEquals`. */
export function sectionLabelEquals(
  a: IrealSectionLabel | null,
  b: IrealSectionLabel | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'letter' && b.kind === 'letter') return a.value === b.value;
  if (a.kind === 'custom' && b.kind === 'custom') return a.value === b.value;
  // The remaining kinds (`verse` / `chorus` / `intro` / `outro` /
  // `bridge`) carry no payload, so kind equality is sufficient.
  return true;
}

/** Map a `IrealSectionLabel` to the string form
 * `defaultPromptSectionLabel` round-trips through. Sister-site:
 * `packages/ui-irealb-editor/src/index.ts`
 * `formatSectionLabelForPrompt`. */
export function formatSectionLabelForPrompt(label: IrealSectionLabel): string {
  switch (label.kind) {
    case 'letter':
      return label.value;
    case 'verse':
      return 'Verse';
    case 'chorus':
      return 'Chorus';
    case 'intro':
      return 'Intro';
    case 'outro':
      return 'Outro';
    case 'bridge':
      return 'Bridge';
    case 'custom':
      return label.value;
  }
}

// GENERATED FILE - DO NOT EDIT.
//
// Source of truth: `BARE_DIRECTIVE_NAMES` in
// `crates/chordpro/src/directive_catalog.rs`. Regenerate with:
//
//     python3 scripts/generate-bare-directives.py --apply
//
// The `directive-catalog-sync` job in `.github/workflows/ci.yml` fails
// when this file and the catalog disagree, so a directive added to the
// catalog cannot leave this surface behind.

/**
 * ChordPro directive names that are legal with no value at all - the
 * complete set a bare `{name}` occurrence can be (`{soc}`, `{eoc}`,
 * `{new_page}`, ...), canonical spellings and short aliases alike.
 *
 * Used by `detectFormat` to tell a real value-less directive from an
 * arbitrary braced word such as `{username}` or a JSON fragment. A
 * directive that carries a value (`{title: ...}`) is recognised by its
 * colon instead and is deliberately absent here.
 */
export const BARE_DIRECTIVES: readonly string[] = [
  'chorus',
  'colb',
  'column_break',
  'end_of_abc',
  'end_of_bridge',
  'end_of_chorus',
  'end_of_grid',
  'end_of_ly',
  'end_of_musicxml',
  'end_of_svg',
  'end_of_tab',
  'end_of_textblock',
  'end_of_verse',
  'eob',
  'eoc',
  'eog',
  'eot',
  'eov',
  'new_page',
  'new_physical_page',
  'new_song',
  'no_diagrams',
  'nodiagrams',
  'np',
  'npp',
  'ns',
  'sob',
  'soc',
  'sog',
  'sot',
  'sov',
  'start_of_abc',
  'start_of_bridge',
  'start_of_chorus',
  'start_of_grid',
  'start_of_ly',
  'start_of_musicxml',
  'start_of_svg',
  'start_of_tab',
  'start_of_textblock',
  'start_of_verse',
];

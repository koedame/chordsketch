// @chordsketch/react — React component library for ChordPro rendering
// backed by @chordsketch/wasm.
//
// This is the scaffolding commit (#2040). Components land in
// subsequent PRs:
//   - #2041: <PdfExport>
//   - #2042: <ChordSheet>
//   - #2043: <ChordEditor>
//   - #2044: <Transpose> + useTranspose
//   - #2045: <ChordDiagram>
//
// The only export at this point is `version()`, a minimal symbol so
// the build pipeline produces a non-empty module and downstream
// consumers can pin against a stable entry point before the
// component surface lands.

import packageJson from '../package.json' with { type: 'json' };

/**
 * The running version of `@chordsketch/react`. Returns the string
 * declared in this package's `package.json` so consumers can verify
 * at runtime which release they are executing against.
 */
export function version(): string {
  return packageJson.version;
}

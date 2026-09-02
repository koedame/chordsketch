// Ambient augmentation for the one HTML attribute `<ChordTextarea>`
// sets that Svelte's element typings do not know about.
//
// `autocorrect` is a WHATWG-standard content attribute (HTML
// standard §"The autocorrect attribute") that Svelte's generated
// `svelte/elements` surface has not picked up yet. The editor sets
// it — alongside `spellcheck` / `autocapitalize` / `autocomplete` —
// because almost every token in a ChordPro file is a chord shorthand
// or a directive name that browser text assistance mangles.
//
// Kept at the package root rather than under `src/` so it stays a
// build-time-only file: `svelte-package` copies everything in `src/`
// into `dist/`, and a global namespace augmentation is not something
// this package should ship to consumers.
declare namespace svelteHTML {
  interface HTMLAttributes<T> {
    autocorrect?: 'on' | 'off';
  }
}

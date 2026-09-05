# 0060. Dependency-free ChordPro text helpers ship as `@chordsketch/chordpro-lite`, with its directive list generated from the catalog

- **Status**: Accepted
- **Date**: 2026-09-06

## Context

Some ChordPro questions are answered before anything is parsed:

- **Which format is this?** A store, an importer, or an editor holding a
  blob of user-supplied text has to route it to the ChordPro pipeline,
  the iReal Pro pipeline, or neither — and that decision is what
  determines whether an engine gets loaded at all.
- **Which words are the lyrics?** Full-text indexing, word counts and
  plain-text export want the sung words with the chord and directive
  scaffolding removed. Not a rendering.
- **What do the opening lines look like?** A listing thumbnail, a
  search-result snippet or a terminal preview wants the first couple of
  chord rows and their lyric, capped.

All three are string work over the ChordPro grammar. None of them needs
the AST, and their callers are frequently in places where the engine is
inconvenient or unavailable: a server or edge runtime that would rather
not instantiate WebAssembly on a write path, a build script, a bundler
plugin, a CLI wrapper, an editor extension deciding which mode to open.

Today ChordSketch offers such a caller nothing. Every published surface —
`@chordsketch/wasm`, `@chordsketch/wasm-export`, `@chordsketch/node`, and
the framework packages that consume them — reaches the format knowledge
through the Rust engine. The result is predictable: consumers write their
own sniffers and strippers, each with a private, hand-maintained list of
ChordPro directive names. That is not a hypothetical failure mode; it is
[ADR-0028](0028-shared-directive-catalog.md)'s failure mode, one process
boundary further out. A hand-written list drifts in both directions —
it accumulates names the parser never recognised, and it silently misses
the ones added since it was written.

There is precedent for the shape of the answer.
[ADR-0029](0029-react-ui-primitives-package.md) established that a
published package may deliberately carry **no** dependency on
`@chordsketch/wasm*` when what it offers does not need the engine, and
that the absence is a policy worth asserting in a test rather than a
coincidence of the current dependency graph.

## Decision

Publish **`@chordsketch/chordpro-lite`** (`packages/chordpro-lite`): a
TypeScript package with no dependencies at all, exporting exactly three
helpers plus their types —

- `detectFormat(input)` → `'chordpro' | 'irealb' | null`
- `extractLyrics(source)` → the lyric words, lines rejoined
- `extractPreview(source, options?)` → the opening chord / lyric lines,
  capped by `maxLines` / `maxChordsPerLine` / `maxLyricChars`

with the same distribution shape as the other scoped packages: dual
ESM + CJS via tsup, its own CI workflow, manual `npm publish` per
[ADR-0008](0008-npm-publishing-is-local.md), independently versioned.
`tests/no-wasm-dep.test.ts` asserts the wasm-free policy at the manifest
level, as ADR-0029's twin does.

**The directive knowledge is generated, not copied.** The catalog in
`crates/chordpro/src/directive_catalog.rs` gains one item —
`BARE_DIRECTIVE_NAMES`, the names a bare `{name}` occurrence can legally
be — and `scripts/generate-bare-directives.py` renders it into
`packages/chordpro-lite/src/bare-directives.ts`. The Rust side stays
authoritative in both directions:

- Four unit tests in `directive_catalog` keep the list honest against the
  catalog and the parser: every `DirectiveValueKind::None` directive
  (name and aliases) must appear in it, every name in it must resolve
  through `DirectiveKind::from_name`, no `Enum`-valued directive may
  appear, and the list must stay sorted and duplicate-free.
- The `directive-catalog-sync` job in `ci.yml` runs the generator with
  `--check` on every pull request and fails on drift.

That job lives in `ci.yml` rather than in the package's own workflow on
purpose: `chordpro-lite.yml` is path-filtered on the package, so a
catalog-only change — precisely the drift direction that matters — would
not trigger it.

The package is a **pre-flight** surface, not a second implementation of
the engine. It does not parse, transpose, render, or grow toward doing
so; `chordsketch_chordpro::heuristic::detect_format` remains the richer
classifier once the engine is loaded, and the READMEs say so.

## Rationale

- **Right layer.** Recognising ChordPro is ChordPro knowledge, and this
  project owns the format. Leaving each consumer to re-derive it is how
  the ecosystem accumulates subtly different answers to "is this a chord
  sheet?" — and how a directive added here silently fails to be
  recognised out there.
- **Root-cause fix, not another copy.** A fourth hand-maintained
  directive list — this time in TypeScript, in a different repository
  from the parser — is exactly the band-aid `root-cause-fixes.md`
  prohibits and ADR-0028 removed once already. Generating from the
  catalog means adding a directive to the parser propagates by
  construction, and forgetting to regenerate fails CI rather than
  degrading a sniffer nobody is watching.
- **`BARE_DIRECTIVE_NAMES` states something the catalog could not.**
  `DirectiveValueKind` records the *shape* a directive's value takes, not
  whether one is *required*. `{soc}`, `{sov}`, `{sog}` and `{chorus}` are
  `FreeForm` because the label they may carry is free text, yet all four
  are valid with no value at all. Deriving the bare list from
  `value == None` alone would quietly drop them; the new const is where
  that distinction is written down, once.
- **Wasm-free is a promise, not an accident.** The reason to reach for
  this package is that it costs nothing to load. A dependency on
  `@chordsketch/wasm` would remove the only reason it exists, so the
  policy is asserted by test, as in ADR-0029.
- **Three functions is the whole scope.** The package is attractive
  precisely because it is small and total. Growing it toward parsing
  would recreate the engine in TypeScript — worse, a divergent one.

## Consequences

- A consumer that only needs to classify, index or preview charts can do
  so with a dependency-free package and no WebAssembly instantiation,
  and pull the engine in only on the paths that render.
- The published npm surface grows by one package to keep at release time:
  `docs/releasing.md` step 7i and its verification line.
- `crates/chordpro` gains a public const. It is `&'static` data in the
  zero-dependency core, so the dependency policy is untouched, but it is
  a public API item and therefore subject to the usual compatibility
  expectations.
- Adding a directive to the catalog now has one more obligation:
  regenerate `bare-directives.ts` (one command) when the new directive is
  value-less. CI names the command in its failure message.
- The generated file is committed rather than built on demand, so the
  npm package builds with `npm ci && npm run build` on a machine with no
  Rust toolchain — the same property that lets `chordpro-lite.yml` skip
  the Rust setup entirely.
- `detectFormat` is intentionally weaker than the engine's classifier: it
  reports `null` for a plain chord-over-lyric sheet, which
  `heuristic::detect_format` recognises as `PlainChordLyrics`. Callers
  that need that distinction must load the engine. Both READMEs state
  this so the weaker answer is not mistaken for a bug.

## Alternatives considered

- **Leave it to consumers.** Rejected: it is what produces the drifting
  private copies described above, and the knowledge being copied is this
  project's own.
- **Export the helpers from `@chordsketch/wasm`.** Rejected: that package
  *is* the WebAssembly runtime. Putting a "use me before you load wasm"
  helper inside the wasm package defeats the purpose for every consumer
  that would benefit.
- **Add the helpers to `@chordsketch/react-ui`.** Rejected: that package
  is the design-system binding and carries a React peer dependency. The
  shared trait is "no wasm", which is not a reason to merge two unrelated
  surfaces.
- **Hand-write the directive list in TypeScript and cross-check it in a
  test.** Rejected: a test that compares two hand-maintained lists still
  requires both to be edited, and the failure mode ADR-0028 documents is
  precisely that one of them is forgotten. Generation removes the second
  list rather than watching it.
- **Add a `DirectiveValueKind::Optional` variant instead of a separate
  const.** Rejected: `listDirectives()` serialises the value kind across
  the wasm boundary, so a new variant changes a published API's output
  shape for six directives, and every consumer's exhaustive match, to
  express something only the sniffer needs. A `&'static` list guarded by
  tests carries the same information at a fraction of the blast radius.
- **Generate `bare-directives.ts` at build time from the Rust source.**
  Rejected: it would put a Rust checkout (and a parser for it) on the
  npm build path. Committing the generated file with a CI drift guard
  keeps the package buildable anywhere, which is what `--check` in
  `directive-catalog-sync` exists to make safe.
- **Reimplement the engine's plain-text heuristic too.** Rejected: it is
  threshold-based chord-token classification, not string scaffolding.
  Duplicating it in TypeScript would create the renderer-parity problem
  this package is designed to avoid.

## References

- [ADR-0028](0028-shared-directive-catalog.md) — the directive catalog as
  the single source of truth; this ADR extends it across the language
  boundary.
- [ADR-0029](0029-react-ui-primitives-package.md) — the precedent for a
  published, wasm-free package whose policy is asserted by test.
- [ADR-0008](0008-npm-publishing-is-local.md) — manual npm publishing.
- `crates/chordpro/src/directive_catalog.rs` — `BARE_DIRECTIVE_NAMES`
  and its consistency tests.
- `scripts/generate-bare-directives.py`,
  `scripts/test_generate_bare_directives.py` — the generator and its
  unit tests.
- `.claude/rules/root-cause-fixes.md`, `.claude/rules/fix-propagation.md`
  — the rules the generated-not-copied decision follows.

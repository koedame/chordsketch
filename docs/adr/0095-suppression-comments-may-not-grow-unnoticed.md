# 0095. Suppression comments may not grow unnoticed

- **Status**: Accepted
- **Date**: 2026-11-20

## Context

`.claude/rules/root-cause-fixes.md` forbids silencing a finding without a
reason, and says what to do when a suppression is unavoidable. Nothing
enforces it: a pull request that adds an `eslint-disable`, a
`@ts-expect-error`, a skipped test or a Rust `#[allow(...)]` looks like any
other change, and a reviewer has to spot the line in the diff. Since
[ADR-0094](0094-eslint-runs-a-minimal-rule-set-so-eslint-disable-comments-mean-something.md)
a TypeScript directive that suppresses nothing fails CI, but one that
suppresses a real finding still passes.

## Decision

1. `scripts/check-suppressions.py` counts suppressions in the tracked files
   (`git ls-files`) and compares the counts with `ci/suppression-baseline.json`.
   The key is `<kind>:<package>`, the package being the first two directory
   levels of the path (`packages/react`, `crates/ffi`).
2. Counted kinds: in TypeScript, JavaScript, Svelte and Vue sources, a
   comment that *starts with* `@ts-ignore`, `@ts-expect-error`,
   `@ts-nocheck`, `eslint-disable` (also `-next-line`, `-line`),
   `biome-ignore` or `svelte-ignore`, and the test markers `.skip`, `.todo`,
   `.fixme`, `.only`, `xit`; in Rust sources, a line that starts with
   `#[allow(`, `#![allow(`, `#[expect(` or `#[ignore` (also inside `#[cfg_attr(...)]`), and a `// WORKAROUND`
   comment. A sentence that mentions a directive is not counted, nor is a
   `///` doc comment.
3. A count above the baseline fails and lists every site of that
   `kind:package` as `path:line`. A count below it fails too, so the change
   that removes a suppression lowers the baseline (`--update`). Raising the
   baseline takes `--update --allow-increase`, which leaves a diff in
   `ci/suppression-baseline.json` for the reviewer.
4. The script's own unit tests assert that the live tree equals the
   baseline. `packages/chordpro-lite/src/bare-directives.ts`, the one
   committed file a generator writes, is not counted; the run fails if that
   path stops being tracked.

## Rationale

- A ratchet needs no judgement about whether a given suppression is
  justified; it makes every addition deliberate and visible, and every
  removal permanent.
- Counting by package keeps a diff to the baseline local: the reviewer sees
  which package grew.
- Counting a directive only at the start of a comment avoids the false
  positives that a text search for `eslint-disable` gives on prose and on
  documentation of the rule itself.

## Consequences

- A change that removes a suppression has to touch the baseline too; the
  failure message says which command to run.
- Python `# noqa`, `# type: ignore` and YAML-level suppressions are not
  counted. They can be added when they become a problem.
- `.svelte` directives are counted but, with no Svelte parser in
  `tools/lint`, not verified by ESLint.

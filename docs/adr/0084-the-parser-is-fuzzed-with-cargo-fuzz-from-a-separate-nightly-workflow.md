# 0084. The parser is fuzzed with cargo-fuzz, from its own nightly workflow

- **Status**: Accepted
- **Date**: 2026-09-24

## Context

`chordsketch-chordpro` parses `.cho` files that come from strangers: the
playground, the CLI, the editor extensions and the bindings all hand it
untrusted text. The parser had unit and golden tests but no fuzzing, so an
input that panics, exhausts memory or never finishes could only be found by
a user hitting it.

Two constraints shape the choice:

- `chordsketch-chordpro` is a zero-dependency crate in every dependency
  table, dev included, enforced by `scripts/check-zero-deps.py`. `proptest`
  and `arbitrary` are dependencies, so the property-testing route means
  either breaking that contract or moving the tests to another crate.
- Coverage-guided fuzzing needs sanitizer instrumentation, which is
  nightly-only. Every other job in this repository builds on stable and the
  MSRV.

## Decision

1. The parser is fuzzed with **cargo-fuzz** (libFuzzer). The harness is
   `crates/chordpro/fuzz/`, an independent workspace root, so
   `libfuzzer-sys` never reaches the SDK workspace, its lockfile, or the
   zero-dependency check, which reads only `crates/chordpro/Cargo.toml`.
2. The target `parse` feeds each input to `parse`, `parse_lenient`,
   `parse_multi` and `parse_multi_lenient`. A crash is a panic, an
   out-of-memory abort (2 GiB) or an input that runs longer than 10 s.
3. It runs from `.github/workflows/fuzz.yml`: **nightly for 15 minutes**,
   and for 30 seconds on a pull request that changes the harness or the
   workflow, so the harness cannot rot unnoticed. A pull request that
   changes only parser code does not run it; the next nightly run does.
4. The corpus is seeded from the golden fixtures on every run and is not
   carried between runs.
5. A crash fails the workflow and uploads the crashing input as an
   artifact. Fixing it comes with a regression test in the crate's own
   suite, which stays stable-only and zero-dependency.

## Rationale

- Keeping `proptest` out keeps the crate's contract, and a
  coverage-guided fuzzer finds inputs a hand-written generator does not:
  an 8-minute local run from the fixtures (about 900,000 inputs) reached
  3,380 coverage points with no crash on the parser at this commit.
- A nightly schedule matches how the risk arrives. A parser regression is
  found the next morning whether or not the PR that introduced it ran the
  fuzzer, and it does not add a nightly compile to every parser PR.
- Not carrying a corpus removes a cache entry and a source of run-to-run
  state; the fixtures reach the parser's states within seconds.

## Consequences

- A parser regression that only fuzzing finds is reported after merge, not
  on the PR. It fails the next nightly run instead of blocking the change.
- The fuzz crate's `Cargo.lock` is not committed, so `libfuzzer-sys` is
  resolved fresh each run. The job has read-only permissions and no
  secrets.
- The nightly toolchain floats. A nightly regression can fail the job
  without a parser bug; the failure message says which.
- Fuzzing covers the parser only. The renderers, the converters and the
  config reader are not fuzzed; add a target beside `parse` if one of them
  becomes a concern.

## Alternatives considered

- **`proptest` in `crates/chordpro`**: rejected, it breaks the
  zero-dependency contract. Hand-rolled random generators in the crate's
  tests would keep it, but they are not coverage-guided and would need the
  grammar re-encoded.
- **Fuzzing on every pull request that touches the parser**: rejected for
  the compile cost and because 30-60 s of fuzzing finds little that the
  nightly run misses.
- **Persisting the corpus between nights**: deferred. It deepens coverage
  over time but adds cache state; revisit if nightly runs stop finding new
  coverage from the fixtures alone.

## References

- `.github/workflows/fuzz.yml`, `crates/chordpro/fuzz/`
- [ADR-0006](0006-desktop-webview-trust-boundary.md) for the other
  untrusted-input boundary the security checks pin.

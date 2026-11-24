# Development Setup

## Rust Toolchain

Minimum supported Rust version: **1.89**

```bash
cargo build          # Build all crates
cargo test           # Run all tests
cargo clippy         # Lint (CI uses -D warnings)
cargo fmt --check    # Check formatting (CI enforced)
```

## WASM and npm Package Development

Required only when working on `crates/wasm` or the `@chordsketch/wasm` npm
package (`packages/npm`). Not needed for core/CLI/renderer development.

```bash
# wasm-pack: builds the WASM package via wasm-bindgen.
# CI pins this exact version in one place —
# .github/actions/install-wasm-pack/action.yml, the composite every
# workflow consumes. Install the same version locally to avoid
# build-output drift between local dev and CI:
cargo install wasm-pack --version 0.15.0
```

Node.js ≥ **22** is required to run the npm package smoke tests. This is
what `.github/workflows/readme-smoke.yml` uses on the `npm-wasm` job.

```bash
# Build both browser and Node targets locally:
cd packages/npm
npm run build              # produces packages/npm/{web,node}/* (gitignored)

# Pack the package for local install testing:
npm pack --dry-run
```

See `docs/releasing.md` "Trusted publishing" for how the packages are published.

## External Tools (Optional)

These tools are **not required** for normal development or CI. They are only
needed for delegate environment rendering (ABC, Lilypond) and compatibility
testing against the Perl reference implementation.

### abc2svg

Converts ABC music notation to SVG. Used by `{start_of_abc}` rendering.

| Platform | Install |
|----------|---------|
| Ubuntu/Debian | `sudo apt install nodejs npm && npm install -g abc2svg` |
| macOS | `brew install node && npm install -g abc2svg` |
| Windows | Install [Node.js](https://nodejs.org/), then `npm install -g abc2svg` |

Verify: `abc2svg --version`

### Lilypond

Converts Lilypond notation to SVG/PNG. Used by `{start_of_ly}` rendering.

| Platform | Install |
|----------|---------|
| Ubuntu/Debian | `sudo apt install lilypond` |
| macOS | `brew install lilypond` |
| Windows | Download from [lilypond.org](https://lilypond.org/download.html) |

Verify: `lilypond --version`

### Perl ChordPro (reference implementation)

Used to refresh the saved Perl output that the compatibility test compares
against (see "Refreshing the saved Perl output" below). Install the release
recorded in `.github/upstream-version`; the refresh script refuses any other.

| Platform | Install |
|----------|---------|
| Ubuntu/Debian | `sudo apt install cpanminus && cpanm App::Music::ChordPro@<version>` |
| macOS | `brew install cpanminus && cpanm App::Music::ChordPro@<version>` |
| Windows | Install [Strawberry Perl](https://strawberryperl.com/), then `cpanm App::Music::ChordPro@<version>` |

For R6.101.0 that is `cpanm App::Music::ChordPro@6.101`. To keep the install
out of the system Perl, add `--notest -l <dir>` and put `<dir>/bin` on `PATH`
and `<dir>/lib/perl5` on `PERL5LIB`.

Verify: `chordpro --version`

## Running Extended Tests

Tests that require external tools are marked with `#[ignore]` and skipped
by default during `cargo test`.

**CI does not run them.** External-tool integration is deliberately not
covered by CI — see
[ADR-0040](adr/0040-external-tool-tests-are-not-run-in-ci.md). If you change
`crates/chordpro/src/external_tool.rs` or the ABC / Lilypond render paths, run
the commands below locally; nothing else will.

```bash
# Run only external-tool tests
cargo test --workspace -- --ignored

# Compare the text and HTML output with a locally installed Perl ChordPro
./scripts/compare-with-perl.sh
```

### Perl comparison in CI

The text output of every file in `tests/corpus/` is compared with saved Perl
output by `cargo test -p chordsketch --test perl_comparison`, which CI runs
with the rest of the workspace. It needs no Perl. When it fails, the message
says whether a file got worse, a listed difference is gone, or the saved
output is stale; `tests/perl-baseline/accepted-differences.txt` and
`docs/known-deviations.md` explain the rest.

### Refreshing the saved Perl output

Needed when `.github/upstream-version` changes or `tests/corpus/` changes.
With Perl ChordPro installed at the release in `.github/upstream-version`:

```bash
./scripts/update-perl-baseline.sh
```

It rewrites `tests/perl-baseline/` and the generated sections of
`docs/known-deviations.md`. Then run `cargo test -p chordsketch --test
perl_comparison`: new differences have to be fixed or added to
`accepted-differences.txt` with a reason.
```

## Tool Detection

The `chordsketch_chordpro::external_tool` module provides runtime detection:

```rust
use chordsketch_chordpro::external_tool;

if external_tool::has_abc2svg() {
    // abc2svg is available, proceed with conversion
}
```

Renderers use these checks to gracefully fall back when tools are missing.

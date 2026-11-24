# Fuzzing the ChordPro parser

cargo-fuzz targets for `chordsketch-chordpro`. This directory is its own
workspace root, so `libfuzzer-sys` never reaches the main workspace or its
lockfile, and it needs a nightly toolchain for the sanitizer instrumentation.

```bash
cargo install cargo-fuzz --version 0.13.2 --locked
# from the repository root, seeding the corpus from the golden fixtures
mkdir -p crates/chordpro/fuzz/corpus/parse
find crates/chordpro/tests -name '*.cho' -type f | while read -r f; do
  cp "$f" "crates/chordpro/fuzz/corpus/parse/$(printf '%s' "$f" | tr '/' '_')"
done
cargo +nightly fuzz run parse --fuzz-dir crates/chordpro/fuzz --target-dir target/fuzz \
  -- -dict=crates/chordpro/fuzz/chordpro.dict -max_total_time=300 -timeout=10 -rss_limit_mb=2048
```

A crash is written to `crates/chordpro/fuzz/artifacts/parse/`. Reproduce it with
`cargo +nightly fuzz run parse --fuzz-dir crates/chordpro/fuzz <file>`, then fix the
parser and add a regression test to `crates/chordpro/tests/`.

#!/usr/bin/env bash
# update-perl-baseline.sh — regenerate the saved Perl ChordPro text output
# that `cargo test -p chordsketch --test perl_comparison` compares against.
#
# Usage:
#   ./scripts/update-perl-baseline.sh
#
# Requirements:
#   - Perl ChordPro on PATH as `chordpro`, at the release recorded in
#     `.github/upstream-version` (`cpanm App::Music::ChordPro@<version>`).
#
# Run it when `.github/upstream-version` changes or a file is added to,
# removed from or edited in `tests/corpus/`. It rewrites
# `tests/perl-baseline/` and then refreshes the generated sections of
# `docs/known-deviations.md`. CI never runs Perl; it only reads the saved
# files.
#
# A corpus file counts as "Perl failed" when `chordpro` exits non-zero or
# prints nothing for it. Those files get no saved output and are listed in
# `tests/perl-baseline/perl-failed.txt`.

set -euo pipefail

cd "$(dirname "$0")/.."

PERL_BIN="${PERL_BIN:-chordpro}"
CORPUS_DIR="tests/corpus"
BASELINE_DIR="tests/perl-baseline"
TEXT_DIR="$BASELINE_DIR/text"

if ! command -v "$PERL_BIN" &>/dev/null; then
    echo "error: '$PERL_BIN' not found in PATH." >&2
    echo "Install the Perl ChordPro release named in .github/upstream-version (cpanm App::Music::ChordPro@<version>)." >&2
    exit 1
fi

expected="$(tr -d '[:space:]' < .github/upstream-version)"
reported="$("$PERL_BIN" --version 2>&1 | sed -n 's/^This is ChordPro core \([0-9][0-9.]*\).*/\1/p' | head -n 1)"
if [[ "R$reported" != "$expected" ]]; then
    echo "error: installed Perl ChordPro is '${reported:-unknown}', but .github/upstream-version says '$expected'." >&2
    exit 1
fi

rm -rf "$TEXT_DIR"
mkdir -p "$TEXT_DIR"
failed_list="$BASELINE_DIR/perl-failed.txt"
: > "$failed_list"

ok=0
failed=0
while read -r cho_file; do
    relative="${cho_file#"$CORPUS_DIR"/}"
    out="$TEXT_DIR/${relative%.cho}.txt"
    mkdir -p "$(dirname "$out")"
    if "$PERL_BIN" --generate Text "$cho_file" > "$out" 2>/dev/null && [[ -s "$out" ]]; then
        ok=$((ok + 1))
    else
        rm -f "$out"
        echo "$relative" >> "$failed_list"
        failed=$((failed + 1))
    fi
done < <(find "$CORPUS_DIR" -name '*.cho' -type f | LC_ALL=C sort)

echo "R$reported" > "$BASELINE_DIR/perl-version"

echo "Saved $ok Perl outputs, $failed Perl failures (Perl ChordPro $reported)."

UPDATE_KNOWN_DEVIATIONS=1 cargo test -p chordsketch --test perl_comparison \
    known_deviations_sections_match_the_baseline

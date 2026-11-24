#!/usr/bin/env bash
# Report a failed fuzzer run without printing what crashed it.
#
# Usage: fuzz-crash-report.sh <step> <status> <log-file>
#
# <step> names the step for the error line, <status> is the exit status to
# report and <log-file> holds everything libFuzzer and cargo-fuzz printed for
# that step. Environment: FUZZ_DIR (the fuzz crate), RUNNER_TEMP.
#
# A failing run prints the crashing input as hex, as Base64 and in Debug form,
# and this repository's workflow logs are public. So nothing from the log is
# echoed here: the output carries only the kind, size and SHA-256 of each
# input libFuzzer wrote under `artifacts/parse/`. The inputs and the log are
# packed into one archive, encrypted with the age public key in
# `.github/fuzz-crash-recipient.txt` and left at
# `$RUNNER_TEMP/fuzz-parse-crash.tar.gz.age` for the upload step. It also sets
# the step output `crashed=true`, which the workflow hands to the job that
# opens the tracking issue.
set -uo pipefail

step="${1:?step name}"
status="${2:?exit status}"
log="${3:?log file}"
artifacts="$FUZZ_DIR/artifacts/parse"

echo "crashed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "::error::$step failed with status $status; the crashing input and the fuzzer output are in the encrypted artifact fuzz-parse-crash"
found=0
if [ -d "$artifacts" ]; then
  for f in "$artifacts"/*; do
    [ -f "$f" ] || continue
    found=1
    name=$(basename "$f")
    # File names are `<kind>-<sha1>`: crash, timeout, oom, leak, slow-unit.
    echo "kind=${name%-*} bytes=$(wc -c < "$f" | tr -d ' ') sha256=$(sha256sum "$f" | cut -d' ' -f1)"
  done
fi
[ "$found" -eq 1 ] || echo "no crashing input was written; the fuzzer output is in the encrypted artifact"

if ! command -v age > /dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq age
fi
pack="$RUNNER_TEMP/fuzz-parse-crash"
rm -rf "$pack"
mkdir -p "$pack"
if [ -d "$artifacts" ]; then
  cp -R "$artifacts" "$pack/artifacts"
fi
cp "$log" "$pack/$(basename "$log")"
tar -czf - -C "$pack" . \
  | age -R .github/fuzz-crash-recipient.txt \
  > "$RUNNER_TEMP/fuzz-parse-crash.tar.gz.age"
echo "encrypted $(wc -c < "$RUNNER_TEMP/fuzz-parse-crash.tar.gz.age" | tr -d ' ') bytes for upload"

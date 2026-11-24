#!/usr/bin/env bash
# Leave a trace of a fuzzer crash that outlives the workflow run.
#
# When the fuzz job found a crash, opens an issue titled "$TITLE", or adds a
# comment to the open one with that exact title. It never closes the issue: a
# night without a crash does not mean the input was fixed. The pull request
# that fixes the crash closes it (`Closes #N`), or a maintainer does.
#
# When it found none, only says in the log whether such an issue is open. The
# line `No fuzz crash issue is open.` is printed only when the fuzz job also
# finished successfully, so a night where the fuzzer never ran does not look
# clean.
#
# Environment: GH_TOKEN, RUN_URL (this run), CRASHED (`true` when the fuzz job
# found a crash), PARSE_RESULT (the fuzz job's result). The issue
# carries the link to the run and the name of the encrypted artifact and
# nothing taken from the crashing input: this repository is public, and an
# input that crashes the parser is a denial of service until it is fixed.
set -euo pipefail

: "${RUN_URL:?link to the run}"
CRASHED="${CRASHED:-false}"
PARSE_RESULT="${PARSE_RESULT:-}"
TITLE="${TITLE:-Fuzzing found a crash in the ChordPro parser}"

body=$(cat <<BODY
The scheduled fuzzer found an input that crashes the ChordPro parser (a panic, an out-of-memory abort or an input that never finishes): [run]($RUN_URL).

The input and the fuzzer output are not published. They are in the artifact \`fuzz-parse-crash\` of that run, encrypted with the age public key in \`.github/fuzz-crash-recipient.txt\`; only the holder of the private key can read it. The log shows the kind, size and SHA-256 of each input. Actions keeps the artifact only for the repository's retention period, so fetch it before it expires.

This issue is not closed automatically: a later run that does not crash does not mean the input was fixed. The pull request that fixes the crash closes it (\`Closes #N\`) and adds a regression test; a later crash is added here as a comment.
BODY
)

number=$(gh issue list --state open --search "in:title \"$TITLE\"" \
  --json number,title \
  | jq -r --arg t "$TITLE" 'map(select(.title == $t)) | first | .number // empty')

if [ "$CRASHED" != "true" ]; then
  if [ -n "$number" ]; then
    echo "A fuzz crash issue is still open: #$number"
  elif [ "$PARSE_RESULT" = "success" ]; then
    echo "No fuzz crash issue is open."
  else
    echo "The fuzz job ended with '$PARSE_RESULT' and found no crash; nothing to report."
  fi
  exit 0
fi

if [ -z "$number" ]; then
  gh issue create --title "$TITLE" --body "$body" \
    --label type:bug --label priority:high
  exit 0
fi

gh issue comment "$number" --body "The fuzzer crashed again: [run]($RUN_URL)."
echo "Commented on #$number"

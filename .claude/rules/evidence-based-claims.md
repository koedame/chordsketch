# Evidence-Based Claims

This project prohibits quantitative estimates, duration predictions,
and unilateral judgments that are not grounded in verifiable data.
"I think", "probably", "should be around X" are signals to stop and
measure, not to ship the number as a fact.

## Prohibited behaviors

- **Fabricated durations** — "CI takes 15-20 minutes", "this should
  build in a minute", "the deploy usually takes a while". If the
  number is not backed by `gh run list`, `time` output, a profiling
  result, or similar, do not state it.
- **Invented probabilities and likelihoods** — "this is likely to
  conflict", "this will probably pass CI", "most of the time this
  works". Either verify (rebase locally, run the tool, check the
  history) or explicitly say "I don't know; let me check."
- **Unilateral decisions based on assumed constraints** — deciding
  to skip a step, reorder work, escalate to `--force`, or recommend an
  approach because of a constraint that was never verified. The
  constraint itself must be checked first.
- **Quantitative spec claims not pinned to the source** — "the limit
  is 32 columns", "the crate has no dependencies", "this function
  panics on empty input". If the claim is load-bearing for a decision
  or a PR body, cite a file path + line, an issue number, or an
  upstream doc URL.

## Required practice

Whenever a quantitative or decision-relevant claim is about to land in
a PR body, a code comment, a commit message, or a user-facing
explanation, the author MUST:

1. **Cite the source.** Command output, `file_path:line_number`, issue
   number, upstream doc link, measurement result. A claim without a
   source is not a fact.
2. **Measure if cheap.** Even a crude approximation from
   `gh run list --limit N --branch main`, `wc -l`, `grep -c`, or a
   local `time cargo test` is better than a guess. Numbers do not
   need to be perfect; they need to be grounded.
3. **Otherwise say "I don't know."** Do not round a missing
   measurement up to "probably X". Ask the user, pause the decision,
   or restructure the plan so it does not depend on the unknown value.

## Worked examples

- **"How long will CI take on this PR?"**
  - ✗ "Probably 15-20 minutes, let me just wait."
  - ✓ `gh run list --branch main --limit 100 --json name,createdAt,updatedAt,conclusion`,
    compute the max per-workflow duration from successful runs, cite
    it: "the slowest workflow in the last 91 main runs was napi-rs at
    10.5 min, so I expect this PR's wall-clock to be ~8-10 min."

- **"Will this rebase conflict with open PRs?"**
  - ✗ "The changes are in different files, so probably no conflicts."
  - ✓ Actually rebase locally (`git rebase origin/main`), or
    `git log --name-only origin/main..HEAD` vs the other PR's files,
    then state the answer.

- **"Is this dependency safe to remove?"**
  - ✗ "I don't think anything still uses it."
  - ✓ `grep -r '<dep_name>' --include='*.rs'`, paste the result.

## Scope

This rule applies to:
- PR descriptions and commit messages
- Review comments and auto-review verdicts
- User-facing chat replies during a session
- Code comments that assert a quantitative or temporal fact
- Sub-agent prompts that pass along estimates as if they were facts

It does not apply to:
- Rough orders-of-magnitude clearly marked as such ("this is O(n) in
  the input size", "this is one of dozens of fixtures") — these are
  qualitative framings, not numeric claims being used as input to a
  decision.
- Direct quotes of an upstream spec or datasheet where the source is
  already named in the surrounding prose.

## Why

Unverified claims compound. A single casual "probably ~15 min"
offered as fact seeds follow-on decisions — waiting strategies,
priority ordering, time estimates presented to the user — that all
silently inherit the original error. The cost of a wrong number is
not local to the sentence it appears in.

Measurement is almost always cheap compared to the cost of a
downstream decision that turns out to be based on a fabrication.
Grounding even small claims in data keeps the project's reasoning
defensible across reviewers, sessions, and future maintainers who
cannot interview the original author.

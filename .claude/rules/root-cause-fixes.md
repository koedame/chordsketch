# Root Cause Fixes

**Symptomatic / band-aid fixes are prohibited in this project.**

When encountering a problem — whether a bug, test failure, build error, or unexpected
behavior — stop, investigate, and fix the **root cause**. Patching the symptom while
leaving the underlying defect intact is not acceptable.

## Rules

- **No workarounds without justification.** Do not suppress warnings, skip tests, add
  special-case patches, or apply band-aid fixes. If a workaround is truly unavoidable
  (e.g., upstream bug with no released fix), you MUST:
  1. Add a `// WORKAROUND: <reason>` comment at every affected site.
  2. Open a GitHub Issue for the proper fix and link it from the comment.
  3. Keep the workaround isolated — do not let it spread across the codebase.
- **Diagnose before fixing.** Read the error, trace the cause, and understand *why* the
  problem occurs before writing any fix. A fix you don't understand is not a fix.
- **Fix at the right layer.** If the bug is in the parser, fix the parser — don't add
  compensating logic in the renderer. If the issue is in the data model, fix the data
  model — don't patch every call site.
- **Avoid `#[allow(...)]` or `// nolint` to silence legitimate warnings.** These hide
  real problems. Fix the code that triggers the warning instead.
- **Tests must validate the root cause.** When adding a regression test, ensure it
  covers the actual root cause, not just the surface-level symptom. The test should fail
  if the root cause is reintroduced.
- **Do not change the test to match broken behavior.** If a test fails, the test is
  probably right. Fix the code, not the test (unless the spec itself changed).

## Symptomatic Fix Patterns to Reject

The following patterns are symptomatic fixes and MUST NOT be merged:

| Pattern | Root-cause alternative |
|---------|----------------------|
| `unwrap_or_default()` / `unwrap_or("")` to silence a missing-value error | Fix the upstream code that should always produce the value |
| Catching a panic with `catch_unwind` instead of eliminating the panic | Remove the condition that causes the panic |
| `#[allow(clippy::...)]` / `#[allow(unused_...)]` on legitimate warnings | Fix the code the lint is flagging |
| Returning early with `Ok(())` to skip a failing step | Handle the failure correctly |
| Deleting or `#[ignore]`-ing a failing test | Fix the code so the test passes |
| Adding a special-case `if` to avoid triggering a known bug | Fix the known bug |
| Bumping a timeout / retry count to mask intermittent failures | Eliminate the source of intermittency |
| Adjusting expected output in a golden test to hide a regression | Fix the regression |

## Process When Root Cause Is Unknown

If you cannot identify the root cause within the current scope:

1. State this explicitly — do not silently apply a workaround.
2. Open a GitHub Issue describing the unresolved root cause.
3. Discuss with the maintainer before landing any interim patch.

## Why

Symptomatic fixes compound over time. Each one hides a defect, increases the
distance between code and spec, and makes the next bug harder to diagnose.
This project enforces root-cause discipline to keep the codebase tractable.

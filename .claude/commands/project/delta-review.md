# Delta Review

You are performing a **delta review** — reviewing only new changes since a previous
review. The argument is a base commit hash or PR number: `$ARGUMENTS`

## Steps

1. **Determine the diff scope**:
   - If the argument is a commit hash: `git log --oneline <hash>..HEAD` and
     `git diff <hash>..HEAD`.
   - If the argument is a PR number: `gh pr diff <number>`.
   - If the argument is empty: ask the user for a base commit or PR number.

2. **Review only the diff** — do NOT review code outside the diff. Previously-reviewed
   code that was not flagged is considered accepted.

3. **Perform both code review and security review** on the diff.

   **Additionally, check for symptomatic / band-aid fixes** (per `.claude/rules/root-cause-fixes.md`):
   - Does the fix address the root cause, or does it only mask the symptom?
   - Are there `#[allow(...)]`, deleted tests, silenced errors, bumped timeouts, or
     adjusted expected outputs that hide the real defect?
   - Any symptomatic fix is at minimum **Medium** severity (spec violation / incorrect behavior preserved).

   **Additionally, run a fix-propagation audit** (per `.claude/rules/fix-propagation.md`):
   - If the diff fixes a bug in one renderer, check the other two renderers for the same bug.
   - If the diff fixes a bug in one binding (FFI/WASM/NAPI), check the other two bindings.
   - If the diff changes validation or clamping logic in one renderer, verify parity in all three.
   - If the diff adds/changes an entry in a URI scheme denylist, tag blocklist, or attribute
     allowlist, verify all sibling lists are consistent (see `.claude/rules/sanitizer-security.md`).
   - If the diff fixes a security or resource-management property in one external-tool
     invocation (`invoke_abc2svg`, `invoke_lilypond`, `invoke_musescore`), check all three.
   - An unfixed sister site carrying the same defect is at minimum **Medium** severity.
   - The PR description MUST include a sentence confirming the sister-site audit was done.

4. **Classify every finding by severity**:

   | Severity | Blocks | Definition |
   |----------|--------|------------|
   | High     | Yes    | Security vulnerabilities, data corruption, crashes |
   | Medium   | Yes    | Spec violations, logic bugs, incorrect output |
   | Low      | No     | Defense-in-depth gaps, minor inconsistencies, portability |
   | Nit      | No     | Style, naming, test coverage suggestions |

5. **Output a structured report** with findings grouped by severity.

6. **Create GitHub issues** for non-blocking findings (Low, Nit).

7. **Verdict**:
   - If no blocking findings: the changes are approved.
   - If blocking findings exist: report them for fixing. After fixes, run
     `/project:delta-review` again with the new base commit.

## Important

- This is a delta review. Do NOT flag issues in code that was not changed in this diff.
- If a previously-accepted pattern is reused in new code, do not flag the pattern
  itself — only flag if the new usage introduces a new bug.
- Classify findings strictly. When in doubt between Medium and Low, prefer Low.

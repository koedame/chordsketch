# Defensive Input Handling

## Public API Validation

Every public function or method that accepts caller-supplied values MUST
validate them at the boundary before use. Do not rely on downstream code
to catch bad inputs — validate at the entry point and return `Result` or
document preconditions with `# Panics`.

### Required practices

- **Range checks**: If a parameter has a valid range, check it and return
  `Err` on violation. Document the range in the `///` doc comment.
- **`#[must_use]`**: Functions returning `Result` or `Option` must have
  `#[must_use]` so callers cannot silently discard errors.
- **Non-empty checks**: If an empty slice or string is invalid, check and
  return `Err` rather than relying on loop-exit or sentinel values.

### TOCTOU races

- Never check a resource then act on it in separate steps (check-then-use).
  Use atomic operations: `File::create_new`, `rename`, `compare-and-swap`.
- Prefer passing already-opened handles instead of file paths across API
  boundaries.

### Temporary resource cleanup

- Use RAII guards to clean up temp files and directories. Never rely on caller
  discipline or process-exit cleanup.
  - **Non-core crates**: prefer the `scopeguard` crate or `tempfile::TempDir`
    (both are external dependencies).
  - **`chordsketch-chordpro`**: must use `Drop` impls or other stdlib-only RAII
    patterns — external crates are prohibited in core.
- Do not manually call `fs::remove_dir_all` in `Ok` paths and forget the `Err`
  path; use an RAII type that runs cleanup unconditionally.

## Why

82 public API input validation issues and 14 TOCTOU issues were filed against
this codebase. The majority were caused by trusting that callers would supply
valid inputs, or by relying on sequential check-then-act patterns.

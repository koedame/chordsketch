# Code Style Rules

- Follow standard Rust conventions (rustfmt defaults, Clippy lints).
- All public items must have doc comments (`///` or `//!`).
- No unnecessary external dependencies. Justify any new dependency in the PR description.
- `chordsketch-core` must have zero external dependencies — no exceptions.
- Prefer returning `Result` over panicking. Reserve `unwrap()` / `expect()` for cases
  where failure is provably impossible, and add a comment explaining why.
- Use `#[must_use]` on functions whose return values should not be silently discarded.
- Tests go in `#[cfg(test)] mod tests` inside the same file, or in a `tests/` directory
  for integration tests.
- Keep modules small and focused. Prefer many small files over few large ones.

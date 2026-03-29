# Pull Request Workflow

1. All changes enter `main` via pull request — no direct pushes.
2. Every PR must pass CI (cargo fmt --check, cargo clippy -- -D warnings, cargo test).
3. Every PR must receive a `/review` approval.
4. Every PR must receive a `/security-review` approval.
5. When all three conditions above are met, the PR is auto-merged to `main`.
6. PR titles should be concise and written in imperative mood (e.g., "Add chord
   transposition support").
7. PR descriptions must include What, Why, Test results, and Review summary sections.

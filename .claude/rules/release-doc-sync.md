# Release-Time Documentation Sync

Documentation that cross-references workspace state — crate count,
dependency graph, public feature list, published API surface — MUST
match reality at the release-cut commit. This is a hard pre-release
gate, not a best-effort review.

[`doc-maintenance.md`](doc-maintenance.md) defines event-driven
triggers (per-PR), but those rely on every PR author remembering to
update CLAUDE.md / CHANGELOG / etc. as part of their feature PR. This
rule is the forcing function: even when individual PRs omit a row,
the next release-cut commit catches the drift.

## Required cross-reference checks

Before changing `## [X.Y.Z] - Unreleased` to
`## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md` (Step 2 of
`docs/releasing.md`), the release maintainer MUST verify each of the
following. Any drift found MUST be fixed in the same release PR;
deferring drift to a later release window is prohibited and reproduces
this rule's documented failure mode.

All commands assume the workspace root as the current working
directory (the repository's top level — the directory containing
`Cargo.toml`, `crates/`, and `docs/`).

### 1. CHANGELOG completeness

- `[Unreleased]` is non-empty.
- Every commit on `main` since the previous release tag whose subject
  matches `^(feat|fix)\(` has either a corresponding bullet or a
  deliberate exclusion reason recorded in the release PR body.
- Verify (`<release-cut-ref>` is the commit that will become the
  release tag — typically `HEAD` of the release-cut branch, or
  `origin/main` if the release is being cut directly from main):
  ```bash
  git log <previous-tag>..<release-cut-ref> --pretty='%s' \
    | grep -E '^(feat|fix)\('
  ```
- Internal-only commits (`ci`, `chore`, `test`, `refactor`, `docs`)
  do not need bullets unless they introduce a user-visible behaviour
  change.

### 2. `docs/releasing.md` crate references

- `## Versioning Policy` crate count matches `ls -d crates/*/ | wc -l`.
- Step 1 manifest list lists every `crates/*/Cargo.toml`.
- Step 6 `cargo publish` bash snippet covers every published crate in
  a topological order valid against each crate's `[dependencies]`
  block (NOT `[dev-dependencies]` — those do not gate `cargo publish`).
- `## crates.io Publishing Order` numbered list and Step 6 bash
  snippet agree on the same crate set, in the same order.
- `## Distribution Channels` table's "N lib crates" / "N bin crates"
  counts match the workspace.

### 3. `CLAUDE.md` Architecture table

- One row exists for every `crates/*/` directory.
- Each row's Dependencies column lists every `chordsketch-*` entry
  declared in that crate's `[dependencies]` block in `Cargo.toml`.
  `[dev-dependencies]` are not in scope; if a row mentions a dev-dep
  it MUST flag it explicitly (e.g., `(... is a [dev-dependencies]
  entry)`).
- The "all renderers" / "all foundations" shorthand, where used,
  expands to the full set currently in the workspace.
- Verify per crate (scoped to `[dependencies]` only — excludes
  `[dev-dependencies]` and `[build-dependencies]`):
  ```bash
  awk '/^\[dependencies\]/{p=1;next} /^\[/{p=0} p && /^chordsketch-/' \
    crates/<NAME>/Cargo.toml
  ```

### 4. `README.md` Features section

- Every public-facing feature shipping in this release is mentioned by
  at least one bullet, OR is explicitly out of scope (e.g.,
  LSP-only features may go in `docs/editors.md` instead).
- The CLI README (`crates/cli/README.md`), if it lists features that
  the root README does not, has a deliberate reason — otherwise the
  root README is out of sync.

### 5. Binding READMEs

- Every binding crate listed in `CLAUDE.md`'s Architecture table that
  exposes a public surface (any `cdylib` / `staticlib`, plus the CLI
  bin crate's `crates/cli/README.md`) has its `README.md` API list
  matching the actual exported functions.
- Every consumer-facing language package listed in `CLAUDE.md`'s
  Additionally-these-non-Rust-packages table that ships its own README
  (`packages/<lang>/README.md`) has its API list matching the surface
  the binding generator publishes (UniFFI for swift / kotlin / ruby /
  python, napi-rs for `@chordsketch/node`, wasm-bindgen for
  `@chordsketch/wasm`).
- The current set at the time of writing is `crates/{wasm,napi,ffi}/`
  and `packages/{npm,swift,kotlin,ruby}/`. New bindings added later
  inherit the rule automatically — derive the check set from the
  CLAUDE.md table at verification time, not from this list.
- Pay special attention to functions added inside the release window
  (every `feat(bindings):` commit since the previous tag).

### 6. Release-time security ADR alignment

Release-time is when stale signing-/credential-handling docs would
mislead an on-call maintainer the most. Before the release-cut, verify
that every release-process ADR still matches its referent workflow on
disk:

- ADR-0007 (Tauri updater key with password) ↔
  `.github/workflows/desktop-release.yml` updater-bundle signing step
  + `apps/desktop/src-tauri/tauri.conf.json` updater public-key field.
- ADR-0008 (npm publishing is local) ↔ no `npm publish` invocation in
  any `.github/workflows/*.yml`. Verify with
  `grep -RnE 'npm[[:space:]]+publish' .github/workflows/`.
- ADR-0009 (release-event cascade credential) ↔ `release.yml` and
  `desktop-release.yml` use `secrets.RELEASE_DISPATCH_TOKEN` (NOT
  `secrets.GITHUB_TOKEN`) on every `gh release create` step.

A drift here is a §6 finding regardless of CHANGELOG / Cargo.toml
state and blocks the release-cut commit identically.

## Verification procedure

Today this is a manual checklist. The intent is to migrate to a
scripted check (`scripts/check-release-doc-sync.py`) that asserts the
crate-graph invariants automatically; until that script ships, the
release maintainer SHOULD:

1. Enumerate the commit set:
   ```bash
   git log <previous-tag>..<release-cut-ref> --pretty=oneline
   ```
2. Run through §§1–6 above against that commit set.
3. Open a single docs PR fixing every drift found before the
   release-cut commit lands.
4. In the release-cut commit message, cite the verification:
   `release-doc-sync.md §§1–6 verified against <verification-SHA>`,
   where `<verification-SHA>` is the workspace tip at the moment the
   checklist was run (typically the parent of the release-cut commit
   itself).

A drift discovered AFTER the release-cut commit MUST be fixed by a
follow-up docs PR before the next release window opens. Do not
silently absorb the drift into the next release window — that is
how this rule's failure mode (the v0.3.0 → next-release drift)
reproduces.

## Why

In the window between v0.3.0 (2026-04-25) and the audit that produced
this rule, 39 user-visible commits landed and four documentation
cross-references drifted silently:

- `CHANGELOG.md` `[Unreleased]` was empty despite the 39 commits
  (`git log v0.3.0..origin/main --pretty='%s' | grep -cE '^(feat|fix)\('`
  returns 39).
- `docs/releasing.md` claimed "ten Rust crates" while the workspace
  had thirteen. The Step 6 publish list omitted three crates that the
  CLI depends on, which would have broken `cargo publish -p chordsketch`
  at release time with `no matching package named "chordsketch-ireal"
  found`.
- `README.md` Features list omitted iReal Pro support even though
  `crates/cli/README.md` already documented it.
- `CLAUDE.md` Architecture table's Dependencies column lagged behind
  the actual `Cargo.toml` declarations on five of thirteen rows
  (`chordsketch-convert`, CLI, wasm, ffi, napi).

The drift was caught only because an unrelated audit session
triggered #2353 / PR #2354. Without this rule, the next release
would have either shipped docs that lie about the product, or burned
~30 minutes at release-cut time reconstructing what shipped from
`git log` — at the worst possible moment.

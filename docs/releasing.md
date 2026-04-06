# Versioning and Release Process

## Versioning Policy

All five crates in the workspace share the same version number and are bumped
in lockstep. This project follows [Semantic Versioning](https://semver.org/):

- **Major** (1.0.0) — breaking API changes
- **Minor** (0.2.0) — new features, backward compatible
- **Patch** (0.1.1) — bug fixes, backward compatible

While the version is below 1.0.0, minor version bumps may include breaking
changes.

## Release Checklist

1. **Update version** in all `Cargo.toml` files:
   - `crates/core/Cargo.toml`
   - `crates/render-text/Cargo.toml`
   - `crates/render-html/Cargo.toml`
   - `crates/render-pdf/Cargo.toml`
   - `crates/cli/Cargo.toml`
   - Update inter-crate dependency versions to match

2. **Update CHANGELOG.md**: change `## [X.Y.Z] - Unreleased` to
   `## [X.Y.Z] - YYYY-MM-DD` and add a new `## [Unreleased]` section above.

3. **Commit** with message: `Release vX.Y.Z`

4. **Create and push tag**:
   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

5. **Wait for the release workflow**: pushing the tag triggers
   `.github/workflows/release.yml`, which builds binaries for all targets and
   creates a GitHub Release with archives attached.

6. **Publish to crates.io** in dependency order:
   ```bash
   cargo publish -p chordsketch-core
   # Wait ~30 seconds for the crates.io index to update
   cargo publish -p chordsketch-render-text
   cargo publish -p chordsketch-render-html
   cargo publish -p chordsketch-render-pdf
   # Wait ~30 seconds for renderer crates to propagate
   cargo publish -p chordsketch
   ```

## crates.io Publishing Order

Crates must be published in dependency order because crates.io resolves
versions from the registry, not the local workspace. The inter-crate
dependencies specify both `path` (for local development) and `version` (for
crates.io).

After publishing each crate, wait for the crates.io index to update before
publishing dependents. This typically takes 10-30 seconds.

Publishing order:
1. `chordsketch-core` (no internal dependencies)
2. `chordsketch-render-text` (depends on `chordsketch-core`)
3. `chordsketch-render-html` (depends on `chordsketch-core`)
4. `chordsketch-render-pdf` (depends on `chordsketch-core`)
5. `chordsketch` (depends on all four above)

Steps 2-4 can be published in any order among themselves, but all must complete
before step 5.

## Post-Release

After the release workflow completes and the GitHub Release is published:

1. **Automatic updates** — the `post-release.yml` workflow triggers on release
   publication and automatically:
   - Updates the Homebrew formula in `koedame/homebrew-tap`
   - Updates the Scoop manifest in `koedame/scoop-bucket`

2. **Docker image** — the `docker.yml` workflow triggers on release publication
   and builds a multi-arch Docker image (linux/amd64, linux/arm64) pushed to
   `ghcr.io/koedame/chordsketch`.

3. **winget** — submit a PR to `microsoft/winget-pkgs` using the manifest
   templates in `packaging/winget/`. Update the version and hash values before
   submission.

4. **Manual verification**:
   - Verify the GitHub Release page has all binary archives
   - Verify each crate appears on crates.io
   - Verify `cargo install chordsketch` works
   - Verify `brew install koedame/tap/chordsketch` works
   - Verify `docker run ghcr.io/koedame/chordsketch --version` works

## Required Secrets

| Secret | Scope | Purpose |
|--------|-------|---------|
| `TAP_GITHUB_TOKEN` | `contents:write` on `koedame/homebrew-tap` and `koedame/scoop-bucket` | Push updated formulae/manifests after release |

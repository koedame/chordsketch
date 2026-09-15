# 0072. The CLI is not published to Flathub

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

`post-release.yml` carried an `update-flatpak` job that filled
`packaging/flatpak/me.koeda.chordsketch.yml.template` with the release's
checksums and would have opened a pull request on
`flathub/me.koeda.chordsketch`. That repository does not exist: the
application was never submitted to Flathub, `FLATHUB_TOKEN` was never set,
and every release skipped the push. The channel was not in
`ci/release-channels.toml`.

ADR-0070's `Publishable` check ran the manifest through
`flatpak-builder-lint`, which reports `finish-args-home-filesystem-access`
and an outdated runtime, so the check could not be made required. Fixing the
manifest would not have been enough. The
[Flathub requirements](https://docs.flathub.org/docs/for-app-authors/requirements)
say:

- "Console softwares will not be accepted."
- "All source available submissions must be built entirely from source
  code." The manifest installed the prebuilt release archive.
- "All submissions must provide a Metainfo file that passes validation."
  There was none.

The first rule rules out the CLI however the manifest is written.

## Decision

1. **The CLI is not submitted to Flathub.** The `update-flatpak` job, its
   template and the `flathub` channel of `scripts/check-publishable.py` are
   removed.
2. **A Flathub listing, if there is one, is the desktop app.** It is a
   graphical application, which the console rule does not exclude. Submitting
   it is separate work: a manifest that builds the Rust, npm and wasm parts
   from vendored sources without network access, AppStream metainfo,
   `finish-args` scoped to what the app needs, and a first submission to
   `flathub/flathub`.

## Rationale

The job had never published anything, and the one thing it would publish is
excluded by Flathub's rules. Keeping it would leave a manifest that looks like
a channel, a check that cannot pass, and a job every release runs for nothing.
Linux users get the CLI from Snap, the AUR, Nix, the release archives and
`cargo install`.

The desktop app's manifest shares nothing with the removed one: a different
application ID (`me.koeda.chordsketch.desktop`), a source build instead of a
downloaded archive, and a toolchain that includes Node. Adapting the old
template would not shorten that work.

## Consequences

- `docs/publishing-requirements.md` records Flathub as not a channel, so the
  CLI manifest is not proposed again.
- `scripts/test_release_checksum_guards.py` expects three checksum-extracting
  steps in `post-release.yml` (Homebrew, Scoop, AUR) instead of four.

## Alternatives considered

- **Fix the CLI manifest** (source build, metainfo, narrower permissions) and
  submit it. Flathub does not accept console software.
- **Keep the dormant job** until the desktop app is submitted. It would be
  replaced rather than reused, and meanwhile it runs on every release and
  keeps a check that fails on `main`.

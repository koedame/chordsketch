# 0005. Tauri updater key management (Ed25519, no password)

- **Status**: Accepted
- **Date**: 2026-04-24

## Context

#2076 enables in-app auto-updates for the Tauri desktop app via the
Tauri updater plugin. The updater's security model is:

- Each release is signed with an Ed25519 private key and the release
  manifest (`latest.json`) references the `.sig` file next to each
  installer.
- The app bundles the matching Ed25519 public key in
  `tauri.conf.json`. Before installing any downloaded update, the
  client verifies the signature against that baked-in pubkey.
- The signature scheme uses `minisign`; Tauri's CLI wraps it and
  optionally password-protects the private key with an additional
  scrypt-derived key.

The key-management question is not *whether* to sign (we must — an
unsigned updater would let a compromised GitHub Release CDN push
rogue binaries), but how the private key is generated, stored, and
rotated.

## Decision

1. **Generate a single Ed25519 updater keypair with no password.**
2. **Commit the public key** to `apps/desktop/src-tauri/tauri.conf.json`
   under `plugins.updater.pubkey`.
3. **Store the private key** in repo secrets as
   `TAURI_SIGNING_PRIVATE_KEY`. The corresponding
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret is **intentionally
   unset**.
4. **Never persist the private key to disk in CI.** The release
   workflow passes the secret directly to `cargo tauri build` via
   `env:` and does not write it to a file.
5. **Rotation**: if the private key is compromised (or suspected
   compromised), generate a new keypair, ship an updated
   `tauri.conf.json` with the new pubkey in the next release, and
   invalidate the old secret. Because auto-update is signature-based
   (not time-based), users still on the old version with the old
   pubkey will reject the rotated-signature updates and must
   manually reinstall from a GitHub Release. This is an accepted
   trade-off for the simpler single-key design.

## Rationale

### Why no password?

The `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` adds defense-in-depth only
when the private key material **leaks outside of GitHub Secrets**.
Threat paths and their outcomes:

| Threat | No password | With password |
|---|---|---|
| GitHub Actions `secrets:` read by a compromised workflow step | Attacker gets private key, can forge updates | Attacker gets password-protected key + env-passed password → same outcome |
| Key material exfiltrated via workflow artefact upload or copy to `$GITHUB_WORKSPACE` and then leaked | Key is immediately usable | Attacker still needs the separate password secret; password adds real defense here |
| Maintainer laptop compromise | N/A (key lives only in GitHub) | N/A (same) |

(Note: GitHub Actions automatically scrubs secret values from public log output, so the "secret printed to log" threat is mitigated by the platform. The realistic residual path is an artefact or file-system write that copies the raw secret into a reviewable location, which is what the password would guard against.)

In practice, GitHub Secrets are the actual trust boundary. Both
`TAURI_SIGNING_PRIVATE_KEY` and the password secret ride the same
`env:` channel into `cargo tauri build`; a workflow step that could
exfiltrate one could exfiltrate the other. The password only adds
meaningful protection when the encrypted private-key file leaves
the GitHub Secrets store and lands somewhere the password has not,
which is not a threat we have.

The cost of password-protecting, on the other hand, is real:

- Two secrets to manage instead of one (rotation doubled).
- A missed password-env-var setup on a future self-hosted runner
  silently produces unsigned releases.
- CI log noise — `cargo tauri build` with a password prompts, and
  non-interactive flows need explicit password env-var routing.

Dropping the password keeps the operational surface minimal at no
measurable security cost.

### Why a single key, not per-release or per-environment keys?

Per-release keys complicate rollback (the new release's key isn't
valid for the old release's signature chain). Per-environment keys
(staging vs production) would need a staging-release channel, which
the project does not have. A single long-lived key tracks industry
practice for desktop updater signing (Sparkle, Tauri docs, Electron
Squirrel all use single-key flows by default).

### Why commit the pubkey to the repo?

The pubkey is not secret — it is literally the public half of the
keypair. Embedding it in `tauri.conf.json` means:

- Every compiled binary carries the exact pubkey it will verify
  against. No runtime pubkey distribution needed.
- Auditing "does my installed app actually check signatures?" is
  a grep, not a binary inspection.
- Rotating the pubkey is a normal source-code change that goes
  through review like any other security-sensitive edit.

## Consequences

**Accepted:**

- If `TAURI_SIGNING_PRIVATE_KEY` is ever exposed (e.g. a future
  Actions security incident), the attacker can forge updates for
  every installed ChordSketch desktop app until a new release with
  a rotated pubkey reaches every user. The mitigation is the
  rotation path described in Decision step 5.
- The lack of a password means a single leak of the private-key
  file (unlike a password-protected file) is immediately usable by
  an attacker — no additional password guessing required.

**Gained:**

- Simple one-secret operational model; new maintainers can set up
  signing with a single `gh secret set`.
- No secondary-secret-forgotten failure modes silently producing
  unsigned releases.
- Build-time clarity: the `desktop-release.yml` workflow passes a
  single env var and Tauri either signs (secret present) or ships
  unsigned (secret absent). No partial/bad-signature state.

**Mitigations:**

- `publish-updater-manifest` in `desktop-release.yml` fails the
  build if the `.sig` files are missing from the release, making a
  "private key was unset" misconfiguration impossible to ship
  silently.
- The pubkey in `tauri.conf.json` is reviewed like any other
  source change, so an accidental pubkey swap (either honest or
  malicious) would be visible in PR diffs.

## Alternatives considered

1. **Password-protected key** (see "Why no password?" above).
   Rejected as a cost-without-benefit operational tax.

2. **No key rotation story.** Rejected: a real-world compromise
   requires a pre-planned rotation path; Decision step 5 is the
   minimum viable plan.

3. **Per-platform keys** (separate macOS / Windows / Linux
   updater keys). Rejected: no threat model requires per-platform
   isolation, and `latest.json` would need a compat shim to
   dispatch to different pubkeys per platform.

4. **Skip updater entirely** and rely on the package-manager
   install paths (Homebrew Cask, AUR, Scoop, winget) for version
   refresh. Rejected by #2076's AC — the user expectation is
   in-app update prompts, and Homebrew updates require a user-
   initiated `brew upgrade` that most users never run.

## References

- PR #2076 implementation — introduces this signing key and the
  manifest-publication pipeline.
- `apps/desktop/src-tauri/tauri.conf.json` — bundled pubkey.
- `.github/workflows/desktop-release.yml` — `publish-updater-manifest`
  job that signs-and-manifests each release.
- `apps/desktop/src/updater.ts` — frontend driver calling `check()`
  + `downloadAndInstall()`.
- Tauri updater plugin docs: <https://v2.tauri.app/plugin/updater/>
- Minisign signature format: <https://jedisct1.github.io/minisign/>

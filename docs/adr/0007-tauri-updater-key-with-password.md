# 0007. Tauri updater key requires a non-empty password

- **Status**: Accepted
- **Date**: 2026-04-25
- **Supersedes**: [ADR-0005](0005-tauri-updater-key-management.md)

## Context

[ADR-0005](0005-tauri-updater-key-management.md) declared that the Tauri
updater keypair would be generated and used with an **empty-string
password**, with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` intentionally unset
in repo secrets. The reasoning was that the password adds defense-in-depth
only if the encrypted private-key file leaks outside GitHub Secrets, which
was not a threat we modelled, and that omitting it kept the operational
surface minimal.

Implementing the auto-update pipeline against `desktop-v0.3.0` exposed two
failure modes that make the empty-password path unimplementable on the
current Tauri 2.x toolchain:

1. **Unset env var is not equivalent to empty string.** The composite
   action in `.github/actions/tauri-build` previously unset
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` whenever its value was empty, to
   prevent empty signing-related env vars from triggering downstream
   tooling against phantom credentials. When that loop also unset the
   updater password, `cargo tauri build` failed with `Error failed to
   decode secret key: incorrect updater private key password: Wrong
   password for that key` on three of four matrix cells. PR #2258 fixed
   the env-var preservation but treated "empty string flows through" as
   a sufficient condition.

2. **Empty-password keys cannot be decrypted with an empty password.**
   PR #2259 reproduced the failure locally: a key generated with `cargo
   tauri signer generate --ci --password ""` cannot subsequently be used
   for signing by passing `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`. The
   underlying `rsign2` library treats empty-string at sign time as an
   absent password rather than as the actual password the key was
   encrypted with, even when the key's metadata records that it was
   generated under empty-string. Regenerating the same logical key with
   a 32-character random password and signing with that exact password
   produced a valid 388-byte signature in the same local harness.

The empty-password design in ADR-0005 is therefore not realisable in the
current Tauri / `rsign2` stack. The release tag `desktop-v0.3.0` failed
to publish a working `latest.json` partly because of this, and was
shipped with auto-update disabled (see release notes).

## Decision

1. **Generate the Ed25519 updater keypair with a non-empty random
   password** (32 ASCII characters, generated via a CSPRNG at the same
   time as the keypair).
2. **Commit the public key** to
   `apps/desktop/src-tauri/tauri.conf.json` under
   `plugins.updater.pubkey` (unchanged from ADR-0005).
3. **Store both halves of the credential** in repo secrets:
   - `TAURI_SIGNING_PRIVATE_KEY` — the encrypted private-key file
     contents.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the matching non-empty
     password.
4. **Pair-verify before pushing the keypair to repo secrets.** Any
   future rotation MUST sign a test payload locally with the exact
   password before the secrets are uploaded, to avoid another
   `Wrong password for that key` regression in CI.
5. **Never persist the private key or its password to disk in CI.**
   Both ride the `env:` channel into `cargo tauri build` directly
   (unchanged from ADR-0005).
6. **Rotation procedure unchanged in spirit, updated in detail:**
   regenerate keypair + password, ship a new `tauri.conf.json` with the
   new pubkey in the next release, invalidate both old secrets, and
   pair-verify locally before the rotation PR merges.

## Rationale

### Why not keep insisting on the empty-password path?

The decision in ADR-0005 was not wrong on threat-model grounds — the
threat-model table in §"Why no password?" still holds. The decision was
wrong on **toolchain feasibility** grounds: the chain `tauri-cli →
rsign2 → key file` does not actually support empty-string passwords
end-to-end despite accepting `--password ""` at generation. Re-litigating
the threat model does not produce signed bundles; using a non-empty
password does.

Two sessions of attempted fixes (PR #2258 fixing the env-var path,
PR #2259 rotating the keypair) confirm that small adjustments do not
make the empty-password path work. A third attempt would burn release
cycles on a path the upstream library does not support.

### What is the threat-model delta?

ADR-0005's table compared "no password" vs "with password" across three
threat paths. The relevant rows:

| Threat | No password (now unimplementable) | With password (current design) |
|---|---|---|
| GitHub Actions secret read by compromised step | Attacker gets key, can forge | Attacker gets password-protected key + env-passed password → same outcome |
| Key material exfiltrated via artefact upload or copy to `$GITHUB_WORKSPACE` | Key immediately usable | Attacker still needs the separate password secret |
| Maintainer laptop compromise | N/A | N/A |

The middle row is the meaningful delta: with a password, a build step that
inadvertently writes the encrypted private-key file to a workflow artefact
(or to a path readable by a later step) does not on its own grant the
attacker forge capability — the password secret has to leak from a
separate secret store. This is a small but non-negative defense-in-depth
gain over the empty-password path.

The other rows are unchanged. The cost of password management — two
secrets to rotate, a missing-password env var that silently produces
unsigned releases — is now real, but the rotation procedure (Decision
step 6) and the build-time fail-closed guard from ADR-0005's
"Mitigations" both still apply. Specifically,
`publish-updater-manifest` already fails the build if `.sig` files are
missing from the release, so a "password env var was unset" misconfig
cannot ship silently.

### Why a 32-character random password specifically?

`rsign2`'s scrypt-derived KDF uses default parameters; the password's
entropy is the lower bound on key-recovery cost given the encrypted file.
32 ASCII characters of CSPRNG output gives ~190 bits of entropy, well
above the Ed25519 key's own 128-bit security floor, so the password is
not the weakest link. The exact length is not load-bearing — anything
≥20 random characters from a CSPRNG is equivalent in practice — but
fixing a specific length in this ADR removes a future ambiguity at
rotation time.

## Consequences

**Accepted:**

- Two secrets to manage instead of one, doubling the rotation surface.
  Mitigation: rotation always touches both secrets together; a
  single-secret rotation is a procedural error.
- A future maintainer setting up a self-hosted runner who forgets to
  copy the password secret will produce builds that fail at `cargo
  tauri build` (loud failure, not a silent unsigned release). This is
  the desired failure mode.
- The "no second secret to forget" simplicity argument from ADR-0005
  is lost. Mitigation: the `tauri-build` composite action validates
  password presence on the signed path (PR #2258) and the
  `publish-updater-manifest` job fails closed if `.sig` files are
  absent (unchanged from ADR-0005).

**Gained:**

- The signing pipeline actually works. Before this decision, the
  empty-password path produced bundles without `.sig` files (or
  failed entirely), and the auto-updater was inert.
- A small defense-in-depth improvement against artefact-leak threats
  (see threat table above).

**Mitigations:**

- Decision step 4 (pair-verify before secret upload) catches the
  generation/signing-asymmetry class of failure that PR #2259 hit.
- Existing build-time guards in `desktop-release.yml` still fail the
  build if signatures are missing.

## Alternatives considered

1. **Continue debugging the empty-password path** in Tauri / rsign2.
   Rejected: two PRs already burned on this, the upstream library's
   behaviour is the issue, and the cost of a third attempt exceeds
   the marginal gain of one fewer secret to manage.

2. **Switch to a different updater plugin** (e.g. roll our own
   minisign-based updater, or vendor `rsign2` with a patch).
   Rejected: scope is far beyond what the empty-password convenience
   was worth. The Tauri updater plugin is otherwise fit for purpose.

3. **Skip signing entirely** and ship unsigned bundles, relying on
   the GitHub Release HTTPS chain for integrity. Rejected: ADR-0005's
   §Alternatives.4 already rejected this on grounds that an unsigned
   updater would let a compromised CDN push rogue binaries, and that
   reasoning still applies.

4. **Per-platform passwords** (separate password per macOS / Windows
   / Linux signing). Rejected: no threat model requires per-platform
   isolation, and `latest.json` carries one signature per platform
   already — the password protects the private-key file, which is
   shared across platforms.

## References

- ADR-0005 — original (superseded) decision.
- PR #2258 — fix(ci): keep `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env
  var on signed path. First failure mode.
- PR #2259 — fix(desktop): rotate updater pubkey to one paired with
  non-empty password. Second failure mode and the rotation that
  produced the current working keypair.
- Issue #2260 — `desktop-release` macOS `.app.tar.gz` upload collision
  (independent bug; unblocking auto-update on `desktop-v0.3.1`).
- `apps/desktop/src-tauri/tauri.conf.json` — bundled pubkey
  (current value `801B37BBD20A24F2`).
- `.github/actions/tauri-build/action.yml` — composite action that
  routes both secrets into `cargo tauri build`.
- Tauri updater plugin docs:
  <https://v2.tauri.app/plugin/updater/>
- rsign2 (the underlying signing library):
  <https://github.com/jedisct1/rsign2>

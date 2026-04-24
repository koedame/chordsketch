# 0006. Desktop WebView is trusted; custom Tauri commands do not enforce per-call capability gating

- **Status**: Accepted
- **Date**: 2026-04-24

## Context

`apps/desktop/src-tauri/src/main.rs` registers four custom Tauri
commands — `export_pdf`, `export_html`, `open_file`, `save_file` —
that perform direct filesystem access. The `capabilities/default.json`
description prior to this ADR claimed that not granting `fs:*`
"keeps untrusted WebView code unable to read or write arbitrary
paths without a user-initiated dialog".

This claim is **false** in the literal Tauri v2 sense. Custom
commands registered via `invoke_handler!` are **not** guarded by the
capability system; the capability allowlist only restricts plugin
commands. The distinction surfaced in #2209 during review of #2207.

The practical threat model nonetheless remains narrow. The WebView
loads only from the local Vite build, the CSP (`default-src 'self'`,
no `unsafe-inline` for scripts) blocks arbitrary JS injection, and
there is no remote-content fetch path. Any attacker capable of
invoking `save_file('/arbitrary/path', ...)` has already executed
code inside the WebView, at which point they can also call
`process::exit` / mount the user's filesystem via the `fs:*` plugin
once anyone grants it / etc. — i.e. the capability-gate argument
would only raise the bar marginally while imposing non-trivial
implementation cost.

A proper defense-in-depth would be a **session-scoped path
allowlist**: record the `PathBuf` returned by each native `save()` /
`open()` dialog in a Rust `State<Mutex<HashSet<PathBuf>>>`, and
reject `save_file` / `open_file` calls whose path is not in the set.
Forging an entry requires executing arbitrary Rust code, not just
WebView JS. Implementing this requires:

1. Wrapping the frontend's `save()` / `open()` calls in custom Rust
   commands that invoke the dialog plugin and record the result.
2. Threading a token (path hash or sequence id) back to the
   frontend.
3. Requiring `save_file` / `open_file` to present a matching token.
4. Invalidating tokens on use (single-use semantics) so a leaked
   token cannot be replayed.

That is a non-trivial architectural shift for a v0.x desktop app
whose code-signing / notarization (#2075) has not yet landed —
unsigned local executables are a far larger attack surface than the
WebView-write-arbitrary-path vector, and closing the capability-gate
hole before code-signing closes does not materially improve the
end-to-end threat posture.

## Decision

For the current v0.x desktop release cadence:

1. **Do NOT add session-scoped path allowlisting** to the four
   custom commands. The WebView is trusted to call them with paths
   of its choosing. Document the trust boundary explicitly in the
   capability file's description and at the per-command doc
   comments.
2. **Correct the misleading claim** in
   `apps/desktop/src-tauri/capabilities/default.json`'s
   `description` field. Remove the sentence that attributes
   filesystem-write restriction to the capability system; replace
   with the actual trust-model rationale.
3. **Revisit when any of the following triggers**:
   - The WebView starts loading remote content (would invalidate the
     "local-only" premise and require real capability gating).
   - A plugin is added that grants `fs:*`, `shell:*`, or any other
     namespace that would let WebView JS bypass the custom-command
     boundary.
   - A security finding exploits the custom-command boundary in a
     way that bypasses the code-signing integrity guarantee once
     #2075 lands.

## Rationale

The misleading description in `capabilities/default.json` was the
load-bearing defect identified in #2209. The mitigation it describes
(capability-based filesystem restriction) does not exist for custom
commands; a reader auditing the threat model would reach a false
conclusion about the blast radius of a hypothetical WebView
compromise.

Fixing only the documentation (and NOT the code) is defensible
because:

- The real trust boundary is **the WebView content source + CSP**,
  which together prevent attacker-controlled JS from running in the
  first place. Code-signing (#2075) extends this to the binary
  layer.
- The proposed mitigation (session path allowlist) adds a
  defense-in-depth layer, but that layer is only load-bearing
  against an attacker who *already* has script execution inside the
  WebView — a condition that implies prior compromise of the trust
  boundary.
- Implementation cost is non-trivial (four commands × token
  plumbing × frontend dialog-wrap rewrites) for a change that, on a
  threat-model reading, is one layer past where the actual line
  sits.

The explicit documentation of the trust boundary ensures that any
future maintainer proposing new custom commands knows which
constraints apply ("never trust a path that is not first validated
against the dialog result" is good practice regardless of the
capability-gate question).

## Consequences

**Accepted negatives:**

- A WebView compromise (XSS via a future dependency supply-chain
  attack, local-DNS attack on dev-build hot-reload) could call
  `save_file('/arbitrary/path', ...)` and `open_file('/any/readable/path')`
  without user consent.
  - *Mitigation*: the CSP and local-only content source are the
    primary defenses; #2075's code signing closes the integrity
    gap.

- Any future "only paths under `~/Documents`" or similar policy
  cannot be enforced purely in Rust; would require re-architecting
  per this ADR's "Alternatives considered" section.

**Accepted positives:**

- Zero code change in `main.rs`; zero new state management or
  frontend plumbing.
- Clear documentation of the actual trust model in the capability
  file and per-command doc comments, so a reader is not misled
  about which layer enforces the restriction.
- Token/allowlist mechanism can be layered on later without an
  incompatible API break — the `save_file` / `open_file` signatures
  stay `(path: String, ...)`.

## Alternatives considered

### Session-scoped path allowlist (proper defense-in-depth)

Record dialog-returned paths in a
`State<Mutex<HashMap<Token, PathBuf>>>`; require custom commands to
present a matching token. Rejected for the v0.x cadence on cost-vs-
threat-gain grounds (see Context). The design remains on the table
for a future release that either lands this ADR's "Revisit when any
of the following triggers" signals or that wants a higher integrity
bar before GA.

### Blanket path filter (e.g. only under `~/Documents`)

Rejected: users routinely export ChordPro files to arbitrary
directories (iCloud, Google Drive, iPod libraries). Forcing a single
base path degrades the primary workflow without closing the
WebView-compromise hole.

### Rely on Tauri's `scope` mechanism

The `scope` mechanism is **plugin-specific** (e.g. `fs:scope`). It
does not apply to custom commands registered via `invoke_handler!`.
Rejected as factually inapplicable.

## References

- Issue: [#2209](https://github.com/koedame/chordsketch/issues/2209)
  ("security: save_file Tauri command lacks capability gating")
- Related: [#2207](https://github.com/koedame/chordsketch/issues/2207)
  (desktop File → Save surface); [#2075](https://github.com/koedame/chordsketch/issues/2075)
  (code signing, the broader integrity mitigation)
- Tauri v2 docs: [Capabilities](https://v2.tauri.app/security/capabilities/)
  — note the capability system applies to plugin commands, not
  `invoke_handler!` registrations
- Rule: [`.claude/rules/adr-discipline.md`](../../.claude/rules/adr-discipline.md)
  — "Locking in a security trade-off" trigger

# 0010. Image path resolution stays strict

- **Status**: Accepted
- **Date**: 2026-04-28

## Context

ChordPro upstream R6.100.0 (release notes
[`R6.100.0`](https://github.com/ChordPro/chordpro/releases/tag/R6.100.0))
extended the `{image}` directive's path resolution in two ways:

1. **Folder next to the song** — `{image: foo.png}` in `mysong.cho`
   resolves to `mysong/foo.png` if a folder named after the song exists
   alongside the source file.
2. **Leading `~` expansion** — `{image: ~/Pictures/foo.png}` expands
   `~` to the user's home directory, with `$HOME` (Unix) /
   `$USERPROFILE` (Windows) semantics.

Both are convenience features for end users authoring `.cho` files in a
trusted local environment.

chordsketch's image-path validator
(`crates/chordpro/src/image_path.rs::is_safe_image_src`) is the
single source of truth for which `src` strings the renderers accept. As
of R6.090.1, the policy is **deny by default**:

- Reject Unix absolute paths (`/...`).
- Reject Windows absolute paths (drive letter, UNC).
- Reject every URI scheme except `http:` / `https:` (so `javascript:`,
  `data:`, `file:`, `blob:`, `vbscript:`, etc. are blocked).
- Reject paths containing `..` directory-traversal components.

`.claude/rules/sanitizer-security.md` and the prior security audit
(#1538, #1545) make this denylist part of the chordsketch security
contract. The renderers exist behind multiple binding surfaces (CLI,
WASM, FFI, NAPI, VS Code extension, desktop app) — many of which run
on untrusted `.cho` input from the network or from third-party sources.

#2291.7 and #2291.8 (sub-issues of the R6.100.0 tracking umbrella
[#2291](https://github.com/koedame/chordsketch/issues/2291)) proposed
following upstream and adopting both new resolution paths verbatim.
Doing so would punch holes in the strict policy:

- **Folder-relative resolution** requires a "base directory" context
  (the directory of the parsed `.cho`). The CLI has it; WASM and the
  library API do not. Threading a base-dir parameter through the
  render entry points is feasible, but the validator must then also
  decide whether `mysong/foo.png` is *truly* relative to the .cho or
  is being smuggled in via a crafted song name. The denial-of-traversal
  invariant (`has_traversal`) survives only if the base-dir is known
  to be inside an allowlisted root, which is a per-host concern (CLI
  knows, library doesn't).
- **`~` expansion** is strictly more permissive than the current Unix
  absolute-path rejection: any `.cho` could read
  `~/.ssh/id_rsa`, `~/.aws/credentials`, etc. once expanded — exactly
  the threat model the original strict policy was designed to keep out.

## Decision

chordsketch declines both R6.100.0 image-resolution extensions.
`is_safe_image_src` and the renderers continue to reject:

- Absolute paths (Unix, Windows, UNC) and URI schemes other than
  `http:` / `https:`.
- The leading `~` token in image `src` values is treated as a regular
  character with no special meaning. It is not stripped, not expanded,
  and the resulting path is then evaluated by the existing rules — so
  `~/foo.png` becomes a relative path token whose validator behaviour
  is unchanged from R6.090.1.
- Folder-next-to-song lookup is not added. The renderers only see what
  the validator accepts: relative filenames whose interpretation is
  the host's responsibility.

Sub-issues #2291.7 and #2291.8 are closed as `not planned`, both
referencing this ADR.

## Rationale

The strict image-path policy is load-bearing for the parts of the
project that surface user-supplied `.cho` to untrusted runtimes — most
visibly the playground and the WebAssembly binding. The cost of a
single read-of-arbitrary-files vector via `~/...` or
`mysong/../../etc/passwd` is high, and it is paid by every consumer of
the chordsketch library, not only by the CLI.

The benefit of matching upstream is real but small: `.cho` files
authored before R6.100.0 do not use `~` or folder-relative `mysong/`
references (the syntax is brand new), and authors of new files can
work around the denial by:

- Placing assets next to the `.cho` and using bare relative names
  (`{image: foo.png}` — already supported).
- Hosting assets at `https://...` URLs.
- Inlining via the `{image}` directive's existing relative-path
  semantics.

The asymmetry with upstream is documented (this ADR + the
`sanitizer-security.md` rule) so a future contributor reading the
codebase does not silently re-implement the upstream paths and
accidentally weaken the policy.

## Consequences

**Positive**

- Renderers and validators stay byte-for-byte compatible with the
  R6.090.1 security contract. No new attack surface in WASM, FFI,
  NAPI, or the desktop WebView (`docs/adr/0006-desktop-webview-trust-boundary.md`).
- `is_safe_image_src` retains a single, easy-to-audit denylist. The
  validator does not need a `base_dir` parameter, so its callers (3
  renderers + bindings) need no churn.
- The `~` token, if it appears in a `.cho`, surfaces as a literal path
  segment that fails the existing relative-path checks predictably —
  no surprising "succeeds with home directory expanded" behaviour.

**Negative**

- A `.cho` that uses `{image: ~/photo.png}` or
  `{image: foo.png}` with a sibling `mysong/` folder will render
  *differently* under chordsketch vs upstream. Specifically the image
  is silently dropped (or warning-rejected) in chordsketch.
- A user porting a song from upstream to chordsketch must rewrite the
  `{image:}` paths to the supported relative form.

**Mitigations**

- The chordsketch CLI emits a warning for rejected image paths
  (per `is_safe_image_src` + the renderer's image-attribute warning
  path); the upstream-vs-chordsketch divergence is therefore observable
  to the author at render time, not silently discarded.
- This ADR is referenced from the `is_safe_image_src` doc comment so
  the reasoning is co-located with the validator.

## Alternatives considered

- **Implement folder-next-to-song only (decline `~` expansion)**.
  Rejected. Folder-next-to-song still requires the validator to
  acquire a `base_dir` it cannot get on the WASM / library path, so
  the divergence between hosts becomes worse: CLI accepts the path,
  WASM rejects it. That asymmetry is harder to reason about than the
  uniform "strict" stance.
- **Implement both, gated by a config knob (`paths.allow-tilde`,
  `paths.song-folder`) defaulting to `false`**. Rejected. A config
  knob does not address the threat — any `.cho` shipped with
  `{+config.paths.allow-tilde: true}` would re-open the file-read
  vector. Per `crates/chordpro/src/config.rs::ALLOWED_PREFIXES`,
  `paths.*` would have to be explicitly added to the song-override
  allowlist; doing so would itself need an ADR.
- **Match upstream verbatim**. Rejected. Inherits a security profile
  that the upstream Perl implementation accepts because its primary
  deployment is a desktop app with a trusted local file system; the
  chordsketch deployment surface is broader (browser WASM + library
  use-cases) and cannot make the same assumption.

## References

- Tracking umbrella: koedame/chordsketch#2291
- Sub-issues closed by this ADR:
  - koedame/chordsketch#2291.7 (image folder next to song)
  - koedame/chordsketch#2291.8 (leading `~` HOME expansion)
- Validator: `crates/chordpro/src/image_path.rs`
- Repo rule: `.claude/rules/sanitizer-security.md`
- Prior security audits citing the strict denylist: #1538, #1545
- Upstream release notes: ChordPro `R6.100.0`
- Upstream patch (release-notes only — the resolution change spans
  multiple files in `Song.pm` / `dir_image`): the R6.100.0 milestone

**Watch signals — re-open the question when any of these flip**

1. The chordsketch deployment surface narrows to trusted local-only
   contexts (e.g. desktop app becomes the sole consumer and WASM is
   removed). The strict denylist is then over-conservative.
2. A future ADR introduces a sandboxed file-resolution layer that lets
   the validator accept `~/...` or `<basename>/...` only when the
   resolved path stays inside a per-host allowlisted root.
3. Upstream introduces an explicit security model (e.g. an
   `untrusted-input` flag) for these resolution paths.

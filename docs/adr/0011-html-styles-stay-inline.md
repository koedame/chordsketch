# 0011. HTML styles stay inline-per-element

- **Status**: Accepted
- **Date**: 2026-04-28

## Context

ChordPro upstream R6.100.0 reworked the HTML output's CSS handling
([upstream commit `019ac5d4`](https://github.com/ChordPro/chordpro/commit/019ac5d4),
"(HTML) Allow embedding of styles; Normalize style names."). The new
upstream model is:

- Configuration (`html.styles.*`) names **CSS stylesheet files**, not
  individual property values. The defaults are
  `default = "chordpro.css"`, `screen = ""`, `print = "chordpro_print.css"`.
- Output emits one `<link rel="stylesheet" href="...">` per
  configured stylesheet. The `default` stylesheet has no `media`
  attribute; the others use `media="screen"` / `media="print"`.
- A new `html.style.embed: false` knob, when flipped to `true`,
  inlines the file contents into a `<style media="...">` block via
  `File::LoadLines` + the `CP->findres` resource resolver.
- Renaming: the old `display` slot was renamed to `screen`.

`chordsketch-render-html` is built on a **fundamentally different**
shape:

- `html.styles.*` in
  `crates/chordpro/src/config.rs::DEFAULT_CONFIG` is
  `body / chord / comment` — each value is a CSS *property string*
  (e.g. `"color: red; font-weight: bold;"`) that the renderer pastes
  into a `style="..."` attribute on the corresponding element. There
  are no stylesheet files to reference.
- The shared CSS template lives entirely inside the renderer crate as
  the `CSS_TEMPLATE` static (see `crates/render-html/src/lib.rs`,
  populated by `css_for_wraplines` introduced in #2296). It is always
  emitted inline within `<style>...</style>` and is never read from
  disk.
- There is no resource-resolver (no `CP->findres` analogue), no
  filesystem path under which `chordpro.css` would live, and no
  precedent for the WASM / FFI bindings opening files at render time.

#2291.4 and #2291.5 (sub-issues of the R6.100.0 tracking umbrella
[#2291](https://github.com/koedame/chordsketch/issues/2291)) proposed
adopting the upstream three-stylesheet + embed-knob model. Doing so
requires:

1. Replacing the `body / chord / comment` per-element-style schema
   with `default / screen / print` filename references.
2. Adding a resource-resolution layer (filesystem read or HTTP fetch
   for WASM) for the linked stylesheets.
3. Re-routing every existing CSS consumer (`render_song` /
   `render_html_css` / `render_html_css_with_config` / VS Code
   webview / playground) onto the new file-based pipeline.

The aggregate change is large and structurally different from the
existing inline architecture. It is also security-sensitive on the
filesystem-read side: chordsketch's image-path policy
(`docs/adr/0010-image-path-resolution-stays-strict.md`) just declined
the analogous "let `.cho` resolve files from disk" model for the
`{image}` directive. Mirroring upstream's stylesheet model would
re-introduce that vector through `html.styles.default = "/etc/passwd"`
or similar.

## Decision

chordsketch declines the R6.100.0 HTML-stylesheet rework. The HTML
renderer continues to:

- Accept inline per-element style strings under `html.styles.body`,
  `html.styles.chord`, `html.styles.comment` (and any future
  per-element entries added in this same shape).
- Emit a single `<style>...</style>` block whose body is the in-source
  `CSS_TEMPLATE`. The `wraplines` knob (#2296) drives the only
  template substitution; no file I/O is performed.
- Provide `render_html_css()` / `render_html_css_with_config(&Config)`
  for body-only consumers that want the same CSS as a separate
  string. Consumers may write that string to disk and link it with
  `<link rel="stylesheet">` themselves.

Sub-issues #2291.4 (style names `default / screen / print`) and
#2291.5 (`html.style.embed`) are closed as `not planned`, both
referencing this ADR.

## Rationale

The two CSS models address different deployment shapes:

- Upstream targets a **desktop-first** workflow where the user has a
  local filesystem layout (`chordpro.css` next to the binary), edits
  the stylesheet directly, and `embed: false` lets the rendered HTML
  pick up changes without re-rendering.
- chordsketch targets the **library + browser** shape: the
  `@chordsketch/wasm` package, the playground, and the React /
  ui-web components consume the HTML output programmatically. They
  have no filesystem to read `chordpro.css` from, and any host that
  *does* have one (the CLI) can already supply its own stylesheet via
  `render_html_css()` and the body-only render path.

Following upstream verbatim therefore delivers a feature that is
inert for most consumers (no filesystem) while requiring all
consumers to absorb the schema change (`body / chord / comment`
removed, `default / screen / print` added). The cost-benefit is
inverted compared to upstream's setting.

The asymmetry is documented (this ADR + the in-source comment on
`html.styles` in `DEFAULT_CONFIG`) so a future contributor reading
the codebase does not silently re-implement the upstream model and
accidentally remove the inline-styles affordance that downstream
consumers (vscode-extension, react package, ui-web) are built on.

## Consequences

**Positive**

- The `html.styles.{body,chord,comment}` schema, the static
  `CSS_TEMPLATE`, and the `render_html_css*` API are stable for
  every existing chordsketch consumer (CLI, WASM, FFI, NAPI,
  vscode-extension, playground, react package, ui-web).
- No new filesystem-read code path on the rendering hot loop. The WASM
  binding's "no syscalls" property is preserved.
- The body-only consumer (vscode-extension webview, ui-web) already
  has the API affordances it needs (`render_html_css_with_config`)
  and gains nothing from the upstream rename.

**Negative**

- A user copying a `.cho` file with
  `{+config.html.styles.default: "my.css"}` from an upstream
  environment will see their override ignored: chordsketch will not
  fetch `my.css`. The key `html.styles.default` matches the `html.`
  override prefix so it passes the allowlist check in
  `Config::with_song_overrides` and is silently added to the merged
  config (no warning emitted). The override is inert because the
  HTML renderer reads only `html.styles.body`, `html.styles.chord`,
  and `html.styles.comment` — unknown `html.styles.*` keys are never
  queried by the renderer.
- The HTML output's `<style>` block content cannot be customised
  per-page beyond the `wraplines` knob without first re-deriving the
  CSS via `render_html_css_with_config` and editing the resulting
  string out-of-band.

**Mitigations**

- The body-only render path (`render_song_body*` /
  `render_html_css*`) lets a host fully bypass the embedded
  `<style>` block and ship its own stylesheet. Hosts that want the
  upstream three-file model can implement it on top of the body-only
  API at the host layer.
- This ADR is referenced from the `html.styles` block in
  `DEFAULT_CONFIG` so the reasoning is co-located with the schema.

## Alternatives considered

- **Adopt upstream's schema verbatim and add a filesystem resolver**.
  Rejected. Re-introduces the file-read vector that ADR-0010 just
  declined for `{image}` paths, and requires a resolver on every
  binding (WASM has no syscalls, FFI / NAPI consumers expect pure
  computation).
- **Add `html.styles.default` / `screen` / `print` alongside the
  existing per-element keys** (additive). Rejected. The upstream model
  is fundamentally about referencing external files; introducing the
  *names* without the file-read semantics would create a
  hollow-shim configuration surface that diverges from upstream while
  also failing to deliver the upstream feature.
- **Implement only `html.style.embed` as a no-op knob, deferring file
  resolution**. Rejected. The flag means nothing if there is no
  external file to embed in the first place; the chordsketch
  pipeline already always-embeds (the only place CSS lives is inside
  the renderer crate), so the toggle would have no observable effect.
- **Match upstream verbatim**. Rejected. Inherits a security profile
  and a deployment assumption (trusted local filesystem) that
  chordsketch's WASM / library deployment surface cannot honour
  uniformly.

## References

- Tracking umbrella: koedame/chordsketch#2291
- Sub-issues closed by this ADR:
  - koedame/chordsketch#2291.4 (HTML styles `default / screen / print`)
  - koedame/chordsketch#2291.5 (`html.style.embed`)
- Renderer: `crates/render-html/src/lib.rs::CSS_TEMPLATE` and
  `render_html_css*`.
- Configuration schema: `crates/chordpro/src/config.rs::DEFAULT_CONFIG`
  (`html.styles.*` block).
- Sister ADRs:
  - `docs/adr/0010-image-path-resolution-stays-strict.md` — analogous
    decline for `{image}` path resolution.
  - `docs/adr/0006-desktop-webview-trust-boundary.md` — defines the
    desktop trust model that this ADR builds on.
- Upstream release notes: ChordPro `R6.100.0`
- Upstream patch:
  https://github.com/ChordPro/chordpro/commit/019ac5d4

**Watch signals — re-open the question when any of these flip**

1. chordsketch grows a sandboxed resource-resolution layer (analogous
   to a virtual filesystem with an allowlisted root) that satisfies
   the safety bar of ADR-0010 *and* gives WASM consumers a way to
   provide stylesheet bytes without syscalls.
2. The upstream three-stylesheet model becomes a hard dependency for
   another integration (e.g. an editor that reads `html.styles.print`
   to drive a print-preview button) and the integration cost outweighs
   the structural mismatch.
3. The chordsketch deployment surface narrows to trusted local-only
   contexts (no WASM, no library API) and the inline-style affordance
   loses its consumers.

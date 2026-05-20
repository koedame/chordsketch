# 0022. React as the canonical preview surface; `@chordsketch/ui-web` retired

- **Status**: Accepted
- **Date**: 2026-05-20

## Context

ADR-0017 (landed via #2475) split ChordPro HTML rendering into two
surfaces: the React surface rendered AST → JSX directly via
`@chordsketch/react`'s `chordpro-jsx` walker (no iframe), and every
other consumer continued to consume `chordsketch-render-html`'s
string output. That split placed the VS Code extension's iframe
preview and the Tauri desktop app in the "non-React consumers"
bucket alongside the CLI, FFI bindings, and GitHub Action — every
host that was modelled at the time as not owning a JS / React
runtime.

Two follow-on observations made that classification obsolete:

1. The playground's #2475 migration from `@chordsketch/ui-web`'s
   iframe-srcdoc model to `@chordsketch/react` direct demonstrated
   that the React-native surface is also the right answer for hosts
   that already own a JS runtime — which both VS Code's WebView and
   Tauri's WebView do. The "no JS runtime" framing in ADR-0017
   collapsed the wrong way: VS Code preview WAS running JS the whole
   time; what it lacked was a React entry point, not a runtime.
2. The previous attempt to unify the three preview hosts (#2279)
   targeted `@chordsketch/ui-web` as the unifier. Its closing PR
   (#2285) explicitly deferred "full sister-site consolidation
   until `@chordsketch/ui-web` grows the host-injection points
   compatible with VS Code's WebView contract." After ADR-0017, the
   canonical React-surface API moved into `@chordsketch/react` and
   `@chordsketch/ui-web` became a private helper retained only for
   the Tauri desktop app — the playground had already migrated
   away. Reviving #2279's `ui-web`-centred plan would mean dragging
   the playground back to a model it already rejected.

## Decision

Consolidate every JS-runtime preview host on `@chordsketch/react`:

- The VS Code WebView preview uses `<ChordProPreview>` — a new Tier
  2 component in `@chordsketch/react` providing a source-less
  preview with a format toggle and transpose control.
- The Tauri desktop app uses `<ChordProEditor>` — the Tier 3
  composed editor component (source pane + preview pane + shared
  toolbar).
- The playground's ChordPro page uses `<ChordProEditor>`.

Retire `@chordsketch/ui-web` entirely. The `packages/ui-web/`
directory is deleted; its only remaining consumer (the Tauri
desktop app) migrates to `@chordsketch/react` in the same window.

Replace the bespoke `packages/vscode-extension/webview/preview.ts`
script (and the host-side HTML envelope that builds the WebView
document) with a React entry point that mounts `<ChordProPreview>`.

ADR-0017's "non-React consumers" list contracts accordingly: only
the CLI, FFI bindings, and GitHub Action remain. VS Code preview
moves out of that bucket.

## Rationale

- **Eliminates sister-site drift between preview hosts.** Any
  improvement to the JSX walker (caret synchronisation between
  source and preview, chord drag-and-drop, line highlighting on
  hover, IME composition under JP lyrics) now lands on every
  preview host automatically because every host renders through the
  same `@chordsketch/react` surface. Under the pre-#2527 layout,
  the same improvement would have to be re-implemented in
  `@chordsketch/ui-web`'s vanilla-TS code path and in the bespoke
  VS Code WebView script — and as the playground/desktop pair
  evolves, those re-implementations consistently lag.
- **Single source of truth for the React-surface DOM.** The
  `chordpro-jsx` walker in `@chordsketch/react` is the canonical
  React DOM contract; no parallel implementation has the standing
  to drift from it.
- **Removes ~1,000 lines of bespoke VS Code WebView code.** The
  WebView-side script at `packages/vscode-extension/webview/preview.ts`
  (~487 lines) plus the host-side HTML-envelope code in
  `packages/vscode-extension/src/preview.ts` (~200 lines) both
  disappear. The remaining VS Code-side glue is a thin React
  bootstrap.
- **Removes the `@chordsketch/ui-web` private package and its
  iframe-srcdoc legacy.** ADR-0017 retired the iframe inside the
  React surface; this ADR retires the package that still embodied
  the iframe-srcdoc mental model for any non-playground consumer.
- **WebView bundle size cost is acceptable.** React + ReactDOM +
  the walker add a one-time install-time payload for a
  desktop-only extension; the architectural simplification (one
  preview implementation across every JS host) outweighs the
  bundle delta. Concrete bundle numbers are recorded in the
  migration PR per `.claude/rules/evidence-based-claims.md`.

## Consequences

**Positive**

- One implementation path for HTML preview across every JS
  runtime host (playground, VS Code WebView, Tauri desktop).
- ADR-0017's consumer classification simplifies: React surface =
  `@chordsketch/react`, non-React surface = `chordsketch-render-html`
  (CLI / FFI / GitHub Action). The "and the VS Code extension's
  iframe preview" qualifier in ADR-0017's Decision section is
  removed (see ADR-0017 §"Subsequent ADRs").
- The renderer-parity discipline already covering the React JSX
  walker (per `.claude/rules/renderer-parity.md`) now governs
  every preview host by construction.

**Negative + mitigation**

- **VS Code WebView bundle size grows** (React + ReactDOM +
  walker). Mitigation: one-time install-time cost for a desktop
  extension that the user explicitly chose to install; the
  migration PR records the measured bundle delta in line with
  `.claude/rules/evidence-based-claims.md` so the trade-off is
  auditable.
- **VS-Code-specific concerns move from the bespoke WebView
  script onto the React side** — `vscode.setState` /
  `vscode.getState` persistence, the `vscode.postMessage`
  transpose channel, and VS Code theme tokens delivered as CSS
  custom properties. Mitigation: each becomes a standard React
  effect hook or prop on `<ChordProPreview>`; the surface area is
  smaller than the previous bespoke script and lives next to the
  rest of the React preview code.
- **Loss of iframe sandbox CSS isolation.** The WebView previously
  ran the preview inside an iframe-srcdoc; styles were physically
  prevented from leaking. Mitigation: `@chordsketch/react`'s
  `styles.css` is already proven safe inline (the playground
  consumes it without an iframe), so the failure mode the iframe
  was guarding against no longer applies.

## Alternatives considered

1. **Status quo — keep #2279's deferred state with three
   divergent preview implementations** (playground on
   `@chordsketch/react`, VS Code on its bespoke WebView script,
   desktop on `@chordsketch/ui-web`). Rejected because sister-site
   drift between the three hosts is now the dominant maintenance
   pressure: every walker improvement lands on the playground
   first and then has to be ported twice. The cost of porting
   keeps the VS Code and desktop previews permanently behind the
   playground.
2. **Re-attempt #2279's `@chordsketch/ui-web` consolidation.**
   Rejected because after ADR-0017 the playground migrated *away*
   from `@chordsketch/ui-web` to consume `@chordsketch/react`
   directly. Reversing that to bring the playground back into
   `ui-web` compatibility would force `ui-web` to grow an internal
   React bootstrap layer, making it a "React wrapper masquerading
   as a framework-agnostic package." Consolidating on
   `@chordsketch/react` directly is the cleaner expression of the
   same intent and avoids re-introducing a private intermediate
   package between the React surface and its consumers.
3. **Hybrid: `@chordsketch/ui-web` becomes a thin React wrapper
   for non-React hosts; `@chordsketch/react` stays the
   React-native surface.** Rejected because the only remaining
   `ui-web` consumer is the Tauri desktop app, and Tauri's
   WebView is itself a React-capable host — there is no remaining
   non-React JS-runtime consumer that needs the vanilla-TS
   `mount(el, opts)` shape. Keeping `ui-web` alive solely to
   wrap a React component on behalf of a host that runs React
   natively is gratuitous.

## References

- #2527 — parent tracking issue for the React-consolidation work.
- #2533 — `@chordsketch/react` component layout refactor that
  introduces `<ChordProPreview>`, `<ChordProEditor>`, and
  `<IrealProEditor>`.
- #2279 (closed) and #2285 — predecessor consolidation attempt
  targeting `@chordsketch/ui-web`; this ADR records why that
  approach is no longer the right answer post-ADR-0017.
- #2475, ADR-0017 — established the React surface as an
  AST-walker rather than an iframe-srcdoc consumer of the Rust
  HTML renderer. ADR-0022 extends that decision to every
  JS-runtime preview host.
- `.claude/rules/renderer-parity.md` — sister-site discipline that
  now applies uniformly across every preview host once they all
  consume the same React surface.

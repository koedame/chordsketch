# 0004. `'unsafe-eval'` in the desktop CSP for `web-tree-sitter`

- **Status**: Accepted
- **Date**: 2026-04-24

## Context

The desktop app (#2068) gains CodeMirror-based ChordPro syntax highlighting
in #2072 by loading `web-tree-sitter@0.26.x` alongside the
`packages/tree-sitter-chordpro` grammar wasm inside the Tauri WebView.
`web-tree-sitter` is Emscripten-compiled. Two call sites in
`node_modules/web-tree-sitter/web-tree-sitter.js` (around lines 2343 and
2366 of the 0.26.8 release) use JavaScript `eval()` to synthesize helper
functions from `EM_ASM` / `EM_JS` markers in the compiled module's exports:

```js
var func = `(${args}) => { ${body} };`;
ASM_CONSTS[start] = eval(func);
// …
var func = `(${jsArgs}) => ${body};`;
moduleExports[name] = eval(func);
```

The pre-#2072 desktop CSP (established in #2185 and tightened in #2187) is:

```text
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self' ipc: http://ipc.localhost;
frame-src 'self'
```

`'wasm-unsafe-eval'` specifically covers `WebAssembly.Module` /
`WebAssembly.instantiate` from byte sources and does NOT cover the JS
`eval()` builtin. Running `web-tree-sitter` under the pre-#2072 CSP
therefore fails to initialise the grammar; the editor falls back to a
plain text view with no highlighting and no inline diagnostics.

## Decision

Add `'unsafe-eval'` to `script-src` in
`apps/desktop/src-tauri/tauri.conf.json`:

```diff
- "script-src 'self' 'wasm-unsafe-eval'"
+ "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'"
```

All other CSP directives stay unchanged.

## Rationale

The practical attack surface for `'unsafe-eval'` in this specific WebView
is bounded:

- The desktop WebView loads only the local Vite bundle served from the
  Tauri-owned origin (`tauri://` / `http://tauri.localhost`). There is no
  remote script include path — `connect-src 'self' ipc:
  http://ipc.localhost` blocks anything else.
- User-supplied ChordPro content flows through the Rust parser in
  `@chordsketch/wasm` (via the preview), and through the Rust renderers
  `chordsketch-render-html` / `chordsketch-render-pdf` (via the export
  commands registered in #2074). Neither path routes user text into
  `eval()`.
- The JS code that *does* call `eval()` is `web-tree-sitter`'s Emscripten
  bootstrap, shipped as a pinned npm dependency (`^0.26.8`,
  integrity-hashed in `apps/desktop/package-lock.json`). The strings
  passed to `eval` are synthesised from the tree-sitter-chordpro
  grammar's compiled exports, not from user input.

Widening CSP is still a real cost — any future contributor who adds a
third-party JS dep that ends up inside `eval()` now has a quieter
failure mode than they would under the stricter policy. The mitigation
is the existing review discipline: `desktop-smoke` builds in CI on every
PR, the PR-review loop catches dep additions, and this ADR exists so
anyone touching the CSP sees the rationale before narrowing it.

## Consequences

**Accepted:**

- The CSP is weaker than it was pre-#2072.
- Emscripten-generated code in any future npm dep would silently benefit
  from the relaxation unless spotted in review.

**Gained:**

- Real tree-sitter-driven syntax highlighting (not a `StreamLanguage`
  approximation) in the desktop editor.
- Incremental parsing (tree-sitter's `parse(doc, oldTree)`) keeps
  keystroke cost linear in the edit size instead of the document size,
  which was the #2072 performance AC.
- Inline diagnostics via real parse-tree `ERROR` / `MISSING` nodes, not
  a separate re-parse.

**Mitigations:**

- `'unsafe-eval'` is the only directive added. `'unsafe-inline'` in
  `script-src` (the much weaker relaxation) stays absent.
- This ADR is the single source of truth for removing the directive
  later. The watch signal is documented in References below.

## Alternatives considered

1. **Reimplement highlighting via CodeMirror `StreamLanguage`.**
   Dropped: does not satisfy #2072's "`+ tree-sitter-chordpro`" AC, and
   would duplicate the grammar's tokenization logic in a second place
   with no enforcement keeping them in sync.

2. **Fork / patch `web-tree-sitter` to strip the `EM_ASM` / `EM_JS`
   calls.** Dropped: unbounded maintenance burden, and the `eval()`
   paths do real work — stripping them would reduce the runtime to a
   subset that may not load every grammar.

3. **Switch to a different tree-sitter web binding.** There is no
   widely-used alternative. Tree-sitter's own WASM build is
   `web-tree-sitter`; it is the canonical path documented on
   <https://tree-sitter.github.io/tree-sitter/>.

4. **Use Web Workers to isolate the `eval` surface.** A worker still
   runs under the same CSP; isolating the thread does not let it run
   `eval` without the directive.

## References

- PR #2212 — the change that introduces this directive.
- Issue #2072 — the syntax-highlighting feature this unblocks.
- `apps/desktop/src/codemirror-editor.ts` — the call site that depends
  on the directive.
- **Watch signal for revisiting**: a `web-tree-sitter` release that
  ships ESM-only Emscripten output would drop the `EM_ASM` `eval()`
  usage. At the time this ADR was written, no upstream issue has been
  identified that tracks this migration specifically; the signal is the
  release notes on <https://www.npmjs.com/package/web-tree-sitter>.
  When a contributor upgrades `web-tree-sitter`, they should verify
  the new release still contains the two `eval()` calls in
  `web-tree-sitter.js`; if it does not, remove `'unsafe-eval'` from the
  CSP and supersede this ADR.

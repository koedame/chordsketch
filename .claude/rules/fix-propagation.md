# Fix Propagation

**When a bug is fixed in one location, every equivalent location must receive the same fix
in the same PR.**

This is the single most common recurring defect pattern in this codebase: a fix is applied
to the most visible code path while equivalent "sister sites" are overlooked. The result is
an asymmetric codebase where one binding is secure, one renderer is correct, or one function
is safe — while its siblings are not.

## Sister-Site Groups

Before closing any PR that fixes a bug, run a sister-site audit against the following
known sibling groups:

### Renderers (text / HTML / PDF)
`crates/render-text/src/lib.rs`, `crates/render-html/src/lib.rs`, `crates/render-pdf/src/lib.rs`

Any fix to one renderer MUST be audited across all three:
- Input validation / clamping (e.g., `{columns}` upper bound)
- Directive match arms and fallback behavior
- Error handling and warning paths

### Bindings (FFI / WASM / NAPI)
`crates/ffi/src/lib.rs`, `crates/wasm/src/lib.rs`, `crates/napi/src/lib.rs`

Any fix to one binding's public API surface MUST be audited across all three:
- Warning routing (e.g., WASM had `render_songs_with_warnings` while NAPI only had
  `render_songs_with_transpose`, leaving NAPI without structured warning capture; see #1541)
- Input validation and error return paths
- API shape consistency (options structs, return types)

### External tool invocations
`invoke_abc2svg`, `invoke_lilypond`, `invoke_musescore` in `crates/chordpro/src/external_tool.rs`

Any security or resource-management fix applied to one invocation function MUST be
applied to all (e.g., `O_EXCL` temp file creation, RAII cleanup, JavaScript/script
stripping for user-supplied notation content).

### Sanitizer functions and blocklists
`has_dangerous_uri_scheme`, `is_uri_attr`, `DANGEROUS_TAGS`, `is_safe_image_src`
in `crates/render-html/src/lib.rs`; `sanitize_directive_token` in `crates/chordpro/`

Any addition to one URI-scheme denylist, tag blocklist, or attribute allowlist MUST be
cross-checked against all sibling lists for the same class of risk.

## Audit Procedure

For every PR that fixes a bug (not just a feature addition):

1. **Identify the fix pattern** — what class of defect is being corrected?
   (e.g., missing bounds check, wrong function used, incomplete blocklist, non-RAII cleanup)

2. **Ask: where else does this pattern occur?** — Search the codebase for the same
   construct (`grep`/`Glob` for the same function name, struct, or idiom).

3. **Check each sister site** — does it have the same defect? If yes, fix it in the same PR.
   If the sister site is intentionally different, document why with a comment.

4. **PR description must state the audit was done**, e.g.:
   > Sister-site audit: checked `invoke_lilypond` and `invoke_musescore` — both updated.
   > No equivalent issue in the FFI and NAPI bindings (different code path).

## Severity

A PR that fixes a bug in one sister site but leaves an equivalent defect in another is:
- **High** if the unfixed site has a security impact
- **Medium** if it causes incorrect output or violates a spec
- **Low** if it is a defense-in-depth or quality gap

## Coverage Floors

Each sister-site group carries a numeric coverage floor enforced by
`codecov.yml`. These floors are derived from the tracker in #1846
§Strategy.3:

| Group | Group floor | Max intra-group skew |
|---|---|---|
| Renderers (`render-text`, `render-html`, `render-pdf`) | 80% | 5 pp |
| Bindings (`chordsketch-ffi`, `chordsketch-napi`, `chordsketch-wasm`) | 70% | 10 pp |
| `chordsketch-chordpro` (standalone) | 85% | — |
| Patch (new lines in any PR) | 70% | — |

Intra-group skew is not enforced natively by Codecov; it is verified by
the auto-review step by reading the per-crate percentages from the
Codecov PR comment. A PR that pushes a group's min-to-max spread over
the skew threshold is a fix-propagation defect by the same definition
as a missing match arm: one binding or renderer is diverging from its
siblings. Severity defaults to Medium, raised to High if the drop is
in a security-relevant function.

Binding floors are intentionally lower because the lines `llvm-cov` sees
are mostly marshalling glue; the public API surface is exercised via
language-runtime integration tests (jest, wasm_bindgen_test, Python
smoke) that llvm-cov does not observe. Raising the floors requires
closing that observability gap first.

## Why

6 of the 14 findings in the 2026-04-12 main-branch review were caused by fix locality bias:
- WASM got `render_songs_with_warnings`; NAPI did not (#1541)
- HTML renderer clamps `{columns}`; PDF did not (#1540)
- `invoke_abc2svg` uses `O_EXCL`; `invoke_lilypond` did not (#1546)
- `is_safe_image_src` blocks `file:`; `has_dangerous_uri_scheme` did not (#1538)
- Some SVG URI attributes sanitized; others were not (#1545)
- `%%javascript` stripped from ABC; `%%js` potentially not (#1551)

In every case, an earlier fix was correct and complete for the code path that was changed,
but the author did not check the equivalent code paths.

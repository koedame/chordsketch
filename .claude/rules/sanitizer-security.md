# Sanitizer and Security Rules

## Sanitizer Bypass Chains

Any string that will be embedded in structured output (ChordPro directives,
HTML, PDF annotations, JSON) MUST be sanitized before use. Apply sanitizers
at the **output boundary**, not at the parse boundary.

### Rules

- **ChordPro output**: Strip or escape `{` and `}` from all directive names
  and values. Use `sanitize_directive_token` (see `heuristic.rs`) or an
  equivalent at every call site that produces ChordPro text.
- **HTML output**: Escape `<`, `>`, `&`, `"`, and `'` in any user-supplied
  string. Never concatenate raw strings into HTML.
- **No partial sanitization**: If a sanitizer is applied to a value, it must
  also be applied to the corresponding name field and vice versa. Asymmetric
  sanitization is a common source of bypass vulnerabilities.
- **Test sanitization with adversarial inputs**: Every sanitizer must have
  at least one test containing the exact character being stripped or escaped
  in both the name and value positions.

## Security Asymmetry

When a security property (e.g. sanitization, access control, rate limiting)
is applied to one code path, audit all parallel code paths for the same
property. Asymmetric treatment is a structural vulnerability.

Example: if directive *values* are sanitized, directive *names* must be
sanitized too — they appear in the same output context.

## Blocklist and Allowlist Completeness

When maintaining a URI scheme denylist, tag blocklist, or attribute allowlist,
the list MUST be verified against the relevant specification for completeness.
A partial list gives a false sense of security.

### Raw SVG (`svg_sanitize.rs`) is an allowlist

`sanitize_svg_content` parses the markup and writes the output from scratch.
Do not add dangerous elements, attributes or schemes to a blocklist there: add
the missing SVG element or attribute to `ALLOWED_ELEMENTS` / `ALLOWED_ATTRS`
only if music notation needs it, and give it the narrowest value check.

- `href` / `xlink:href` keep only fragment references (`#id`) after character
  references are decoded; any reference that cannot be decoded cleanly drops the
  attribute. `url(...)` in paint attributes and `style` is fragment-only too.
- `style` elements, HTML elements and elements that load resources are removed
  (`SKIP_SUBTREE`); the `style` attribute is checked property by property.

### URI scheme denylists

The React walker's `isSafeHref` and the playground docs pipeline still use a
scheme denylist. Every such denylist MUST block at minimum:
`javascript:`, `vbscript:`, `data:`, `file:`, `blob:`, and MUST decode character
references (numeric, `&Tab;`, `&NewLine;`, `&colon;`) before comparing.

Whenever an entry is added to any URI scheme list:
1. Add it to `tests/fixtures/uri-scheme-corpus.txt`, which the Rust, React and
   playground tests all read, and cross-check `is_safe_image_src`.
2. Verify the list against the [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
   for completeness. (The WHATWG Fetch spec does not define a URI scheme denylist
   for HTML sanitization purposes.)

### Testing completeness

When a new entry is added to any blocklist or allowlist:
- Add a test that exercises the new entry with a malicious value.
- Add a comment citing the relevant spec section or CVE that motivated the entry.

## Why

53 sanitizer bypass issues and 18 security asymmetry issues were filed.
The most common pattern was sanitizing only one field of a multi-field
record, leaving the other fields exploitable.

A 2026-04-12 audit found two blocklist completeness gaps: `file:` not blocked in the
URI check despite being blocked in `is_safe_image_src` (#1538), and `feImage` absent
from the SVG tag blocklist despite being a known resource-loading primitive (#1545).
Both were caused by partial lists copied from one context without auditing the full
specification. The raw SVG path is therefore an allowlist rather than a blocklist.

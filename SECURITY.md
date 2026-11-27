# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in ChordSketch, please report it
responsibly by [opening a GitHub security advisory][advisory]. Do **not** file
a public issue for security-sensitive reports.

[advisory]: https://github.com/koedame/chordsketch/security/advisories/new

We aim to acknowledge reports within 72 hours and provide a fix or mitigation
plan within 30 days.

## Threat Model

ChordSketch processes **untrusted** `.cho` (ChordPro) files and renders them to
text, HTML, and PDF. The primary threat is a malicious or crafted input file
attempting to:

- Execute arbitrary code on the host.
- Read or write files outside the intended scope.
- Produce excessively large output to exhaust memory or disk.
- Inject scripts or markup into rendered HTML/SVG output.

### Trust Boundaries

| Source | Trust Level | Notes |
|--------|-------------|-------|
| CLI flags and environment variables | **Trusted** | Controlled by the invoking user |
| System and user config files | **Trusted** | Located under `/etc/` or `~/.config/` |
| Project-level config files | **Untrusted** | May come from a cloned repository |
| Song `.cho` files | **Untrusted** | Primary attack surface |
| Delegate tool output (abc2svg, Lilypond) | **Untrusted** | External process output is sanitized |

## Security Controls

### Configuration File Loading

- **Hierarchy**: defaults → system → user → project → song-level overrides.
- **Symlink rejection**: Config files are opened with `O_NOFOLLOW` on Unix to
  prevent symlink-based redirection.
- **File size limit**: Config files are capped at 10 MB (`MAX_CONFIG_FILE_SIZE`).
- **Delegate execution restriction**: Delegates are off by default and are
  never enabled just because the tool is installed. Only system-level or
  user-level config, explicit CLI flags, or the configuration a library caller
  passes can enable delegate execution. Project-level and song-level configs
  cannot enable delegates — any attempt is reset to `false` with a warning.

### RRJSON Parser

- **Nesting depth limit**: 64 levels (`MAX_NESTING_DEPTH`).
- **Entry count limit**: 10,000 entries per object or array (`MAX_ENTRIES`).
- **Non-finite number rejection**: `Infinity`, `-Infinity`, and `NaN` are
  rejected.

### Delegate Execution (abc2svg, Lilypond, MuseScore)

Delegate environments invoke external tools to convert music notation to SVG.
These tools execute code that can be embedded in the notation (abc2svg runs
JavaScript, Lilypond runs Scheme), so **the primary control is that delegates
are off unless a trusted source enables them**, and they should be enabled only
for song files you trust. The file previews (Explorer / Quick Look) and the MCP
server never run delegates, whatever the configuration. The WebAssembly build
cannot run them at all.

When a delegate is enabled, these additional layers apply:

1. **Content-level filtering** — before the external tool is invoked:
   - ABC: only stylesheet directives (`%%...` / `I:...` lines) on a fixed
     allowlist of layout, spacing, font and score-structure directives are
     passed through. Every other directive is removed, together with the body
     of any block it opens.
   - Lilypond: lines with directly-called dangerous Scheme functions are
     removed. This is a best-effort filter, not a security boundary — Lilypond
     removed its `-dsafe` sandbox mode in 2.23.12 and has no replacement, so
     Lilypond content must come from a trusted file.
   - MusicXML: XML processing instructions and `<!DOCTYPE>` declarations are
     removed.
2. **Safe command construction** — all arguments are passed via the
   `Command::arg()` API, preventing shell metacharacter injection.
3. **Output sanitization** — SVG output from delegates is run through the SVG
   sanitizer before inclusion in rendered output.
4. **Temp file safety** — temporary files use PID + atomic counter for unique
   names, are created with `O_EXCL` (exclusive create) semantics, and
   directories use `create_dir` (not `create_dir_all`) to prevent symlink
   attacks on parent paths.

### SVG Sanitization

All SVG content (from delegates or `{start_of_svg}` sections) is rewritten
through an allowlist:

- **Elements**: only SVG drawing, text, gradient and `use` elements are kept.
  `<style>`, scripts, animation elements, `<foreignobject>`, `<image>` and all
  HTML elements (forms, images, frames, ...) are removed; elements that carry
  code or load resources are removed together with their content.
- **Attributes**: only SVG geometry, presentation and accessibility attributes
  are kept. Event handlers and every other attribute are dropped.
- **References**: `href` and `xlink:href` are kept only when they point to a
  fragment of the same document (`#id`), and `url(...)` in paint attributes and
  in `style` is held to the same rule. Character references are decoded before
  the value is checked; a value with a reference that cannot be decoded cleanly
  is dropped.
- **`style` attribute**: only listed properties with plain values are kept.

### HTML Output

- All user-provided text content is escaped via `escape_xml()` before
  insertion into HTML.
- CSS values are sanitized through a whitelist filter
  (`sanitize_css_value()`).
- CSS class names are sanitized via `sanitize_css_class()`.

**Recommendation for consumers**: when serving HTML output in a browser, apply
a restrictive `Content-Security-Policy` header. A reasonable starting point:

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'
```

### Image Handling (PDF Renderer)

- **Path validation**: rejects absolute paths, Windows drive letters, UNC
  paths, null bytes, and `..` directory traversal — on all platforms.
- **Symlink rejection**: images are opened with `O_NOFOLLOW` on Unix; file
  metadata is checked on the open file descriptor to close TOCTOU gaps.
- **Size limits**:
  - `MAX_IMAGE_FILE_SIZE`: 50 MB per image file.
  - `MAX_DECOMPRESSED_SIZE`: 256 MB for PNG IDAT decompression.
  - `MAX_IMAGE_PIXELS`: 10,000 px per dimension (render clamp — images larger
    than this are scaled down for rendering, not rejected).
  - `MAX_IMAGES`: 1,000 images per document.
  - `MAX_PAGES`: 10,000 pages per document.

### Output Amplification Prevention

- **Chorus recall limit**: `{chorus}` directives are capped at 1,000 recalls
  per song across all renderers (text, HTML, PDF) to prevent output
  amplification from malicious input.

## Dependency Policy

- `chordsketch-chordpro` has **zero external dependencies**. All parsing, validation,
  and sanitization logic is implemented from scratch.
- Renderer crates use minimal, well-audited dependencies (`unicode-width`,
  `flate2`).
- The CLI uses `clap` for argument parsing.

# Parsing to JSON with `@chordsketch/wasm`

The CLI renders; it does not emit the parse tree. When the structure itself is
what is needed, use the published wasm package. It is the same Rust parser
compiled to WebAssembly, so it agrees with the CLI.

```bash
npm install @chordsketch/wasm
```

Under Node the package resolves to a **CommonJS** build. Use `require`; a named
ESM `import` fails with `Named export 'parseChordpro' not found`.

```bash
node -e 'const cs=require("@chordsketch/wasm");
const src=require("fs").readFileSync(process.argv[1],"utf8");
const ast=JSON.parse(cs.parseChordpro(src));
console.log(ast.metadata.title, "-", ast.metadata.key);' song.cho
```

## The functions worth knowing

| Function | Returns |
|---|---|
| `parseChordpro(src)` | the AST as a **JSON string** — call `JSON.parse` on it |
| `parseChordproWithOptions(src, opts)` | same, with `{ transpose: N }` applied |
| `parseChordproWithWarnings(src)` | `{ ast, warnings }` — `ast` is still a JSON string |
| `validate(src)` | array of `{ line, column, message }`; empty when the file parses |
| `renderTextWithWarnings(src)` | `{ output, warnings }` |
| `renderHtmlWithWarnings(src)` | `{ output, warnings }` — a full HTML document |
| `render_html_body(src)` / `render_html_css()` | the fragment and its stylesheet, separately |
| `parseIrealb(url)` / `renderIrealSvg(url)` | iReal Pro chart as JSON / as SVG |
| `convertIrealbToChordproText(url)` | iReal Pro to ChordPro source |
| `convertChordproToIrealb(src)` | ChordPro to an `irealb://` URL — the direction the CLI does not have |
| `chord_diagram_svg(chord, instrument)` | one chord diagram as SVG; `undefined` when the chord has no voicing |
| `version()` | the Rust crate version the wasm was built from |

Every `*WithOptions` variant takes the same options object the renderers use;
`{ transpose: N }` is the field that matters most.

The export list grows between releases. Confirm what an installed copy actually
has before relying on a name:

```bash
node -e 'console.log(Object.keys(require("@chordsketch/wasm")).join("\n"))'
```

## AST shape

`parseChordpro` returns a document with two top-level keys.

```jsonc
{
  "metadata": {
    "title": "Test Song",
    "key": "Bb",
    "keys": ["Bb"],
    "artists": [], "composers": [], "lyricists": [],
    "tempo": null, "time": null, "capo": null,
    "custom": []
  },
  "lines": [
    { "kind": "directive",
      "value": { "name": "title", "value": "Test Song",
                 "kind": { "tag": "title" }, "selector": null } },
    { "kind": "lyrics",
      "value": { "segments": [
        { "chord": { "name": "Am",
                     "detail": { "root": "A", "rootAccidental": null,
                                 "quality": "minor", "extension": null,
                                 "bassNote": null },
                     "display": null },
          "text": "Hello ", "spans": [] }
      ] } }
  ]
}
```

- `metadata` is the song header, already collected — read `title` / `key` /
  `artists` from here rather than hunting through `lines`.
- `lines` is the document in order. `kind` is `"directive"` or `"lyrics"`;
  section boundaries appear as directives (`start_of_verse`, `end_of_chorus`, …)
  so a section is the span between them.
- A lyric line is a list of `segments`; each carries the chord landing on it (or
  `null`) and the text that follows. `detail` is the chord already decomposed
  into root, accidental, quality, extension and bass note — use it instead of
  parsing `name` again.

## `validate()` versus the CLI's warnings

They answer different questions and neither replaces the other.

| | `validate(src)` | `chordsketch --warnings-json` |
|---|---|---|
| finds | syntax errors, with line and column | renderer and config warnings |
| example | `unclosed chord: expected ]` | `{transpose} value "up2" cannot be parsed as i8` |
| on a valid file | `[]` | nothing on stderr |

The CLI reports the same syntax errors as `error: … parse error at line L column
C: …` and exits 1, so for a yes/no answer the CLI alone is enough.
`validate()` is for when the positions have to be handled programmatically —
marking an editor, say.

## Which package

`@chordsketch/wasm` is the lean build (~400 KB). `@chordsketch/wasm-export` is
the same API plus PDF and PNG output, and is far larger; install it only when
those formats are needed from JavaScript. For a one-off PDF, the CLI is the
shorter road.

Full binding documentation:
<https://github.com/koedame/chordsketch/blob/main/packages/npm/README.md>

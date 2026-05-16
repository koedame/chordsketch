// Ambient type declarations for the two WASM packages the
// playground consumes (#2466 split):
//
//   - `@chordsketch/wasm`        — lean bundle (~400 KB raw / ~175
//                                   KB gzipped). Parse + transpose
//                                   + text / HTML / SVG / iReal
//                                   chord-typography. No PDF / PNG
//                                   renderer surface.
//   - `@chordsketch/wasm-export` — heavy bundle (~10 MB raw / ~6.4
//                                   MB gzipped). Adds renderPdf /
//                                   renderIrealPng / renderIrealPdf
//                                   plus everything from the lean
//                                   bundle. Loaded only when the
//                                   user triggers a PDF export.
//
// The playground aliases both names to the local builds via
// vite.config.ts so the typings here describe what's actually
// reachable at runtime, not what npm install would resolve to.

declare module '@chordsketch/wasm' {
  export function render_html(input: string): string;
  export function render_text(input: string): string;
  export function render_html_with_options(
    input: string,
    options: { transpose?: number; config?: string },
  ): string;
  export function render_text_with_options(
    input: string,
    options: { transpose?: number; config?: string },
  ): string;
  export function render_html_body(input: string): string;
  export function render_html_body_with_options(
    input: string,
    options: { transpose?: number; config?: string },
  ): string;
  export function render_html_css(): string;
  export function render_html_css_with_options(
    options: { transpose?: number; config?: string },
  ): string;
  export interface ValidationError {
    line: number;
    column: number;
    message: string;
  }
  export function validate(input: string): ValidationError[];
  export function version(): string;
  // iReal Pro bindings (#2055 / #2058 / #2335). Camel-cased on the
  // JS side via `#[wasm_bindgen(js_name = ...)]`; the snake_case
  // siblings (`render_html`, `render_text`) predate that rename
  // convention. The playground does not currently consume these
  // — iRealb support was removed during the design-system
  // migration (#2454) and will be reintroduced once the React
  // component surface for the bar-grid editor lands. The
  // declarations are kept so the future re-add does not need to
  // re-author them.
  export function renderIrealSvg(input: string): string;
  export function parseIrealb(input: string): string;
  export function serializeIrealb(input: string): string;
  export function chordTypography(chord_json: string): string;
  // ChordPro parse-to-AST binding (#2475). Returns the parsed
  // `Song` AST as a JSON string — TS shape declared in
  // `packages/react/src/chordpro-ast.ts` (`ChordproSong`).
  export function parseChordpro(input: string): string;
  export function parseChordproWithOptions(
    input: string,
    options: { transpose?: number; config?: string },
  ): string;
  // `*WithWarnings` variants surface the lenient parser's recovered
  // `ParseError` messages alongside the AST so the React preview can
  // render them (round-1 fix for PR #2455). Also carry the
  // `transposedKey` field — present only when `transpose !== 0` AND
  // the source's `{key}` directive value parses as a chord — so the
  // walker can render "Original Key X · Play Key Y". Match the
  // `ParseChordproResult` shape defined in
  // `crates/wasm/src/lib.rs`.
  export function parseChordproWithWarnings(input: string): {
    ast: string;
    warnings: string[];
    transposedKey?: string;
  };
  export function parseChordproWithWarningsAndOptions(
    input: string,
    options: { transpose?: number; config?: string },
  ): {
    ast: string;
    warnings: string[];
    transposedKey?: string;
  };
  export default function init(): Promise<void>;
}

// NOTE: `@chordsketch/wasm-export` is intentionally NOT declared
// here. It is only consumed by `@chordsketch/react`'s
// `use-pdf-export.ts` via a dynamic `import()` cast to a
// structural shape — the cast preserves the type contract without
// pulling the heavy bundle into tsc's resolution graph. Declaring
// it here would invalidate the `@ts-expect-error` directive in
// the react package source (which the playground typechecks
// because the alias points at `../react/src/index.ts`).

// @chordsketch/node — TypeScript declarations.
//
// Mirrors the public API defined by `crates/napi/src/lib.rs` #[napi] items.
// Keep in sync with the Rust source: every exported function and object
// over there must have a matching declaration here.

/**
 * Rendering options accepted by the `*WithOptions` functions.
 *
 * Matches the `RenderOptions` struct in `crates/napi/src/lib.rs`.
 */
export interface RenderOptions {
  /**
   * Semitone transposition offset. Defaults to 0.
   *
   * Must be within the i8 range (-128..=127); out-of-range values
   * throw an `Error` (the underlying napi-rs status is `InvalidArg`,
   * surfaced as `err.code === 'InvalidArg'`). The renderer reduces the
   * accepted value modulo 12.
   */
  transpose?: number;

  /**
   * Configuration preset name (e.g. "guitar", "ukulele") or an inline
   * RRJSON configuration string.
   */
  config?: string;
}

/**
 * A single validation issue reported by `validate`.
 */
export interface ValidationError {
  /** One-based line number of the issue within the input. */
  line: number;
  /** Column offset (byte) within the line, one-based. */
  column: number;
  /** Human-readable description of the issue. */
  message: string;
}

/**
 * Structured render result returned by the `*WithWarnings` and
 * `*WithWarningsAndOptions` families (string outputs).
 *
 * Mirrors the `TextRenderWithWarnings` struct in
 * `crates/napi/src/lib.rs`. Used by both the text and HTML render
 * variants — the field name is historical (the struct backed text
 * output first).
 *
 * Use these variants when you need warning-driven UI (inline
 * banners, telemetry aggregation, selective suppression). The plain
 * `renderText` / `renderHtml` entry points forward warnings to
 * `process.stderr` instead, which is fine for CLI scripts but
 * invisible to embedded use.
 */
export interface TextRenderWithWarnings {
  /** Rendered text or HTML output. */
  output: string;
  /** Renderer warnings captured during the render pass. */
  warnings: string[];
}

/**
 * Structured render result for the PDF `*WithWarnings` family.
 *
 * Mirrors the `PdfRenderWithWarnings` struct in
 * `crates/napi/src/lib.rs`. See {@link TextRenderWithWarnings} for
 * the warnings contract.
 */
export interface PdfRenderWithWarnings {
  /** PDF byte stream. */
  output: Buffer;
  /** Renderer warnings captured during the render pass. */
  warnings: string[];
}

/** Returns the version string baked into the compiled Rust crate. */
export function version(): string;

/** Renders the ChordPro source to plain text. */
export function renderText(source: string): string;

/**
 * Renders the ChordPro source to plain text with rendering options applied.
 */
export function renderTextWithOptions(source: string, options: RenderOptions): string;

/** Renders the ChordPro source to HTML. */
export function renderHtml(source: string): string;

/**
 * Renders the ChordPro source to HTML with rendering options applied.
 */
export function renderHtmlWithOptions(source: string, options: RenderOptions): string;

/** Renders the ChordPro source to a PDF document, returned as a Buffer. */
export function renderPdf(source: string): Buffer;

/**
 * Renders the ChordPro source to a PDF document with rendering options
 * applied.
 */
export function renderPdfWithOptions(source: string, options: RenderOptions): Buffer;

/**
 * Renders to plain text, returning structured warnings alongside the
 * output. Use this when you need warning-driven UI; the plain
 * `renderText` forwards warnings to `process.stderr` instead.
 */
export function renderTextWithWarnings(source: string): TextRenderWithWarnings;

/**
 * Renders to HTML, returning structured warnings alongside the
 * output. See {@link renderTextWithWarnings} for the contract.
 */
export function renderHtmlWithWarnings(source: string): TextRenderWithWarnings;

/**
 * Renders to PDF, returning structured warnings alongside the
 * Buffer output. See {@link renderTextWithWarnings} for the contract.
 */
export function renderPdfWithWarnings(source: string): PdfRenderWithWarnings;

/**
 * Renders to plain text with rendering options applied, returning
 * structured warnings alongside the output.
 */
export function renderTextWithWarningsAndOptions(
  source: string,
  options: RenderOptions,
): TextRenderWithWarnings;

/**
 * Renders to HTML with rendering options applied, returning
 * structured warnings alongside the output.
 */
export function renderHtmlWithWarningsAndOptions(
  source: string,
  options: RenderOptions,
): TextRenderWithWarnings;

/**
 * Renders to PDF with rendering options applied, returning
 * structured warnings alongside the Buffer output.
 */
export function renderPdfWithWarningsAndOptions(
  source: string,
  options: RenderOptions,
): PdfRenderWithWarnings;

/**
 * Validates a ChordPro source document and returns a list of issues. An
 * empty array indicates the document parses cleanly.
 */
export function validate(source: string): ValidationError[];

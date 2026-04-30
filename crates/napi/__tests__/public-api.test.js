"use strict";

// Public-API integration tests for the @chordsketch/node NAPI binding.
//
// Each test loads the compiled `.node` artifact (produced by `npm run build`
// or the napi CI job) and exercises one documented function. The suite
// together covers every #[napi] item declared in `crates/napi/src/lib.rs`
// and mirrored in `crates/napi/index.d.ts`.
//
// Complements `warning-routing.test.js`, which covers the
// Rust-eprintln-to-stderr path via spawned child processes.

const fs = require("fs");
const path = require("path");

function findNodeFile() {
  const dir = path.join(__dirname, "..");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".node"));
  if (files.length !== 1) {
    throw new Error(
      `Expected exactly 1 .node file in ${dir}, found ${files.length}: ${files.join(", ")}`
    );
  }
  return path.join(dir, files[0]);
}

const MINIMAL = "{title: Test}\n[C]Hello";

describe("NAPI public API surface", () => {
  let m;

  beforeAll(() => {
    m = require(findNodeFile());
  });

  test("version() returns a non-empty string", () => {
    const v = m.version();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });

  test("renderText() renders the title into plain text", () => {
    const out = m.renderText(MINIMAL);
    expect(typeof out).toBe("string");
    expect(out).toContain("Test");
    expect(out).toContain("Hello");
  });

  test("renderTextWithOptions({ transpose: 2 }) returns non-empty text", () => {
    const out = m.renderTextWithOptions(MINIMAL, { transpose: 2 });
    expect(typeof out).toBe("string");
    expect(out).toContain("Test");
  });

  test("renderTextWithOptions({ config: 'guitar' }) accepts preset names", () => {
    const out = m.renderTextWithOptions(MINIMAL, { config: "guitar" });
    expect(typeof out).toBe("string");
    expect(out).toContain("Test");
  });

  test("renderHtml() renders the title into HTML", () => {
    const out = m.renderHtml(MINIMAL);
    expect(typeof out).toBe("string");
    expect(out).toContain("Test");
    // Sanity: output should at least contain an HTML structural marker, not
    // be an arbitrary string.
    expect(out).toMatch(/<!DOCTYPE|<html|<body/i);
  });

  test("renderHtmlWithOptions({ transpose: 1 }) returns HTML", () => {
    const out = m.renderHtmlWithOptions(MINIMAL, { transpose: 1 });
    expect(typeof out).toBe("string");
    expect(out).toContain("Test");
  });

  test("renderPdf() returns a Buffer starting with the PDF magic header", () => {
    const pdf = m.renderPdf(MINIMAL);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(4);
    expect(pdf.slice(0, 4).toString("utf8")).toBe("%PDF");
  });

  test("renderPdfWithOptions({ transpose: 2 }) returns a PDF Buffer", () => {
    const pdf = m.renderPdfWithOptions(MINIMAL, { transpose: 2 });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.slice(0, 4).toString("utf8")).toBe("%PDF");
  });

  test("validate() returns an empty array for a well-formed document", () => {
    const errs = m.validate(MINIMAL);
    expect(Array.isArray(errs)).toBe(true);
    expect(errs).toHaveLength(0);
  });

  test("validate() returns at least one ValidationError for a broken document", () => {
    // Unterminated chord bracket — parser rejects this.
    const errs = m.validate("{title: T}\n[G");
    expect(Array.isArray(errs)).toBe(true);
    expect(errs.length).toBeGreaterThan(0);
    // Rust returns `Vec<ValidationError>` after #1990, matching the
    // `ValidationError[]` declaration in `crates/napi/index.d.ts`.
    for (const e of errs) {
      expect(typeof e.line).toBe("number");
      expect(typeof e.column).toBe("number");
      expect(typeof e.message).toBe("string");
      expect(e.line).toBeGreaterThanOrEqual(1);
      expect(e.column).toBeGreaterThanOrEqual(1);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  test("transpose: 0 and omitted transpose produce equal output", () => {
    // Regression guard for #1541's warning-routing ancestry: the `transpose`
    // option must be honoured even when its value is the identity. If a
    // future refactor accidentally drops the `0` branch, this test catches
    // it immediately.
    const a = m.renderText(MINIMAL);
    const b = m.renderTextWithOptions(MINIMAL, { transpose: 0 });
    expect(a).toBe(b);
  });

  // ---- iReal Pro conversion bindings (#2067 Phase 1) ----

  // Tiny irealb:// fixture from `crates/convert/tests/from_ireal.rs`.
  const TINY_IREAL_URL =
    "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33";

  test("convertChordproToIrealb returns an irealb:// URL", () => {
    const result = m.convertChordproToIrealb(MINIMAL);
    expect(typeof result.output).toBe("string");
    expect(result.output.startsWith("irealb://")).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  test("convertIrealbToChordproText preserves bar boundaries", () => {
    const result = m.convertIrealbToChordproText(TINY_IREAL_URL);
    expect(typeof result.output).toBe("string");
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output).toContain("|");
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  test("convertIrealbToChordproText throws on invalid URL", () => {
    // Sister-binding parity with the Rust unit test
    // `test_convert_irealb_to_chordpro_text_invalid_url_errors`.
    expect(() => m.convertIrealbToChordproText("not a url")).toThrow();
  });
});

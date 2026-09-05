import { describe, expect, it } from 'vitest';
import { BARE_DIRECTIVES } from '../src/bare-directives';
import { detectFormat } from '../src/detect-format';

describe('detectFormat / iReal Pro', () => {
  it("returns 'irealb' when the input starts with irealb://", () => {
    expect(detectFormat('irealb://Song%20Name=...')).toBe('irealb');
  });

  it("returns 'irealb' when the input starts with irealbook://", () => {
    expect(detectFormat('irealbook://Song=Composer=...')).toBe('irealb');
  });

  it("returns 'irealb' when the URL is padded with surrounding whitespace", () => {
    expect(detectFormat('  irealb://x  ')).toBe('irealb');
  });

  it('returns null when an iReal Pro URL appears mid-text rather than as the prefix', () => {
    expect(detectFormat('text irealb://x')).toBeNull();
  });

  it("returns 'irealb' when an iReal Pro URL also contains bracketed text", () => {
    expect(detectFormat('irealb://Song [G]inline=...')).toBe('irealb');
  });
});

describe('detectFormat / ChordPro', () => {
  it("returns 'chordpro' when a directive carries a value", () => {
    expect(detectFormat('{title: My Song}\nHello')).toBe('chordpro');
  });

  it("returns 'chordpro' when a value-less directive appears", () => {
    expect(detectFormat('{soc}\nVerse text')).toBe('chordpro');
  });

  it("returns 'chordpro' when whitespace separates the directive name from its colon", () => {
    expect(detectFormat('{title : My Song}')).toBe('chordpro');
  });

  it("returns 'chordpro' when an inline chord appears", () => {
    expect(detectFormat('[G]Hello [Am]world')).toBe('chordpro');
  });

  it("returns 'chordpro' when the inline chord carries a slash bass and extensions", () => {
    expect(detectFormat('[Cmaj7/E]complex')).toBe('chordpro');
  });

  it("returns 'chordpro' for a chart whose only marker is a directive, not a chord", () => {
    // German / Nordic `H` is outside the `[A-G]` inline-chord class, so
    // this chart is recognised through its directives alone.
    expect(detectFormat('{soc}\n[H]Hallo Welt\n{eoc}')).toBe('chordpro');
  });
});

describe('detectFormat / neither format', () => {
  it('returns null for plain lyrics with no chords', () => {
    expect(detectFormat('Just some words, no chords at all.')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(detectFormat('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(detectFormat('   \n\t  ')).toBeNull();
  });

  it('returns null for a lowercase bracketed word, which is not a chord', () => {
    expect(detectFormat('[invalid] text')).toBeNull();
  });

  it('returns null for a chord line that only uses notation outside A-G', () => {
    // Documents the boundary: widening inline-chord detection to `H`
    // means changing INLINE_CHORD_PATTERN and inverting this test.
    expect(detectFormat('[H]Hallo Welt')).toBeNull();
  });

  it('returns null for a JSON fragment, which is braced but not a directive', () => {
    expect(detectFormat('{"key":"value"}')).toBeNull();
  });

  it('returns null for a template placeholder, which is not a known directive', () => {
    expect(detectFormat('Hello {username}, welcome.')).toBeNull();
  });

  it('returns null for several braced words with no directive among them', () => {
    expect(detectFormat('config: {x} and {y}')).toBeNull();
  });
});

describe('detectFormat / robustness', () => {
  it('classifies chords the same way when the lyrics are non-Latin', () => {
    expect(detectFormat('[G]こんにちは [Am]世界 🎸')).toBe('chordpro');
  });

  it('returns null in linear time for a very long lyrics-only input', () => {
    const long = 'just a line of words '.repeat(15_000);
    expect(detectFormat(long)).toBeNull();
  });
});

describe('detectFormat / directive catalog coverage', () => {
  it('recognises every value-less directive generated from the engine catalog', () => {
    // The list is generated from `BARE_DIRECTIVE_NAMES` in
    // `crates/chordpro/src/directive_catalog.rs`; this asserts the
    // detector actually consumes all of it rather than a stale subset.
    for (const name of BARE_DIRECTIVES) {
      expect(detectFormat(`{${name}}\nsome words`), name).toBe('chordpro');
    }
  });

  it('recognises value-less directives regardless of case', () => {
    expect(detectFormat('{SOC}\nVerse text')).toBe('chordpro');
  });

  it('covers the section openers whose label is optional', () => {
    expect(BARE_DIRECTIVES).toContain('soc');
    expect(BARE_DIRECTIVES).toContain('chorus');
  });

  it('excludes directives that require a value, so a bare one is not a match', () => {
    expect(BARE_DIRECTIVES).not.toContain('title');
    expect(detectFormat('Hello {title}, welcome.')).toBeNull();
  });
});

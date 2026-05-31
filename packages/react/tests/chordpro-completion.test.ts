import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import {
  detectChordproCompletion,
  chordProCompletionSource,
  type ChordproCatalog,
  type DirectiveCatalogEntry,
} from '../src/chordpro-completion';

const CATALOG: DirectiveCatalogEntry[] = [
  {
    name: 'title',
    aliases: ['t'],
    valueKind: 'freeform',
    values: [],
    summary: 'Song title',
  },
  {
    name: 'diagrams',
    aliases: [],
    valueKind: 'enum',
    values: ['on', 'off', 'guitar', 'ukulele', 'piano', 'inline', 'hover'],
    summary: 'Chord diagram display',
  },
  {
    name: 'new_song',
    aliases: ['ns'],
    valueKind: 'none',
    values: [],
    summary: 'Start a new song',
  },
];

const stubCatalog: ChordproCatalog = {
  listDirectives: () => CATALOG,
  directiveValueOptions: (name) => {
    const directive = CATALOG.find((d) => d.name === name);
    return directive && directive.valueKind === 'enum' ? directive.values : null;
  },
};

const stubLoader = () => Promise.resolve(stubCatalog);

function complete(doc: string, pos: number = doc.length) {
  const state = EditorState.create({ doc });
  const context = new CompletionContext(state, pos, true);
  return chordProCompletionSource(stubLoader)(context);
}

describe('detectChordproCompletion', () => {
  it('detects a directive-name context inside an unclosed brace', () => {
    expect(detectChordproCompletion('{di')).toEqual({
      kind: 'directive',
      prefix: 'di',
      from: 1,
    });
  });

  it('skips leading whitespace after the opening brace', () => {
    expect(detectChordproCompletion('{ di')).toEqual({
      kind: 'directive',
      prefix: 'di',
      from: 2,
    });
  });

  it('detects a directive-value context after the colon', () => {
    expect(detectChordproCompletion('{diagrams: ')).toEqual({
      kind: 'value',
      directive: 'diagrams',
      prefix: '',
      from: 11,
    });
  });

  it('carries the typed value prefix in a value context', () => {
    expect(detectChordproCompletion('{diagrams: inl')).toEqual({
      kind: 'value',
      directive: 'diagrams',
      prefix: 'inl',
      from: 11,
    });
  });

  it('returns null when there is no opening brace', () => {
    expect(detectChordproCompletion('just lyrics')).toBeNull();
  });

  it('returns null once the directive brace is closed', () => {
    expect(detectChordproCompletion('{diagrams}')).toBeNull();
  });

  it('returns null when the value already contains a space (free text)', () => {
    expect(detectChordproCompletion('{title: My Song')).toBeNull();
  });
});

describe('chordProCompletionSource', () => {
  it('offers every catalog directive inside an unclosed brace', async () => {
    const result = await complete('{');
    expect(result).not.toBeNull();
    expect(result?.from).toBe(1);
    expect(result?.options.map((o) => o.label)).toEqual([
      'title',
      'diagrams',
      'new_song',
    ]);
  });

  it('anchors the replacement after the brace when a prefix is typed', async () => {
    const result = await complete('{dia');
    expect(result?.from).toBe(1);
    // The source returns the full set; CodeMirror filters by `validFor`.
    expect(result?.options.some((o) => o.label === 'diagrams')).toBe(true);
  });

  it('offers the enum values of an enum-valued directive after the colon', async () => {
    const result = await complete('{diagrams: ');
    expect(result?.from).toBe(11);
    expect(result?.options.map((o) => o.label)).toContain('inline');
    expect(result?.options.map((o) => o.label)).toContain('hover');
  });

  it('offers no value completion for a free-form directive', async () => {
    expect(await complete('{title: ')).toBeNull();
  });

  it('offers nothing outside a directive brace', async () => {
    expect(await complete('plain lyric line')).toBeNull();
  });
});

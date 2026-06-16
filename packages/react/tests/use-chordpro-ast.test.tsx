import { render, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { useChordproAst, type ChordproWasmLoader } from '../src/use-chordpro-ast';

// Minimal parser stub: the AST's `metadata.title` echoes the source so
// a test can assert which source the visible AST reflects. The real
// `ChordproSong` shape has many more fields, but the hook only
// `JSON.parse`s + casts, so a minimal object is sufficient at runtime.
function parserStub(opts: { throwOn?: string } = {}) {
  const make = (src: string) => {
    if (opts.throwOn !== undefined && src === opts.throwOn) {
      throw new Error('boom');
    }
    return {
      ast: JSON.stringify({ metadata: { title: src }, lines: [] }),
      warnings: [] as string[],
      transposedKey: undefined,
    };
  };
  return {
    default: vi.fn(async () => undefined),
    parseChordproWithWarnings: vi.fn(make),
    parseChordproWithWarningsAndOptions: vi.fn(make),
  };
}

function Probe({
  source,
  loader,
  skip,
}: {
  source: string;
  loader: ChordproWasmLoader;
  skip?: boolean;
}) {
  const { ast, loading, error } = useChordproAst(source, { skip }, loader);
  return (
    <div data-testid="out">
      {loading ? 'loading' : error ? `error:${ast?.metadata.title ?? 'null'}` : (ast?.metadata.title ?? 'null')}
    </div>
  );
}

describe('useChordproAst — synchronous parse (no AST lag, #2638)', () => {
  test('parses after the module loads, then re-parses SYNCHRONOUSLY on source change', async () => {
    const stub = parserStub();
    const loader: ChordproWasmLoader = vi.fn(
      async () => stub as unknown as Awaited<ReturnType<ChordproWasmLoader>>,
    );
    const { getByTestId, rerender } = render(<Probe source="A" loader={loader} />);

    // Module load is async — the first paint is `loading`.
    await waitFor(() => expect(getByTestId('out').textContent).toBe('A'));

    // The regression: changing `source` must update `ast` in the SAME
    // render, with NO async tick. Under the previous async-effect
    // implementation the AST lagged one render behind `source` (the
    // chord-inspector flicker). Asserting without `waitFor` — i.e. the
    // value is correct immediately after the synchronous rerender —
    // proves the parse is now a synchronous derivation of `source`.
    rerender(<Probe source="B" loader={loader} />);
    expect(getByTestId('out').textContent).toBe('B');

    rerender(<Probe source="C" loader={loader} />);
    expect(getByTestId('out').textContent).toBe('C');
  });

  test('keeps the last good AST and surfaces an error when a parse throws', async () => {
    const stub = parserStub({ throwOn: 'BAD' });
    const loader: ChordproWasmLoader = vi.fn(
      async () => stub as unknown as Awaited<ReturnType<ChordproWasmLoader>>,
    );
    const { getByTestId, rerender } = render(<Probe source="GOOD" loader={loader} />);
    await waitFor(() => expect(getByTestId('out').textContent).toBe('GOOD'));

    // A throwing parse must not blank the preview: the previous AST is
    // retained and `error` is set.
    rerender(<Probe source="BAD" loader={loader} />);
    expect(getByTestId('out').textContent).toBe('error:GOOD');

    // Recovering to a valid source clears the error synchronously.
    rerender(<Probe source="OK" loader={loader} />);
    expect(getByTestId('out').textContent).toBe('OK');
  });

  test('skip holds the AST null and never invokes the loader', async () => {
    const stub = parserStub();
    const loader: ChordproWasmLoader = vi.fn(
      async () => stub as unknown as Awaited<ReturnType<ChordproWasmLoader>>,
    );
    const { getByTestId } = render(<Probe source="A" loader={loader} skip />);
    // skip => not loading, ast null, loader untouched.
    await waitFor(() => expect(getByTestId('out').textContent).toBe('null'));
    expect(loader).not.toHaveBeenCalled();
  });
});

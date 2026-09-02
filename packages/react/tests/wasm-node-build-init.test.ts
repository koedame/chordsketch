import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { useChordDiagram } from '../src/use-chord-diagram';
import { useChordRender } from '../src/use-chord-render';

// Regression tests for the wasm init call.
//
// Unlike every other hook test in this package, these run against the
// REAL `@chordsketch/wasm` module through each hook's DEFAULT loader.
// The defect they pin cannot be reproduced with a stub: a stub always
// supplies a callable `default`, while the published Node build
// (`wasm-pack --target nodejs`) is CommonJS that instantiates itself
// at require time and exports no init function at all. Calling the
// namespace object the ESM interop synthesises in its place throws
// `mod.default is not a function`, which the hooks' try/catch turns
// into a permanent error state — no preview under Node, SSR, or
// jsdom.

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(here, '../src');

describe('the Node build of @chordsketch/wasm', () => {
  test('exposes no callable init, so an unconditional init call would throw', async () => {
    const mod = (await import('@chordsketch/wasm')) as unknown as {
      default?: unknown;
      render_html: unknown;
    };

    expect(typeof mod.render_html).toBe('function');
    expect(typeof mod.default).not.toBe('function');
  });
});

describe('useChordRender driven by its default loader', () => {
  test('renders the source when the loaded build has no init function', async () => {
    const { result } = renderHook(() => useChordRender('{title: T}\n[C]Hi'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.output).toContain('<span class="chord">C</span>');
  });
});

describe('useChordDiagram driven by its default loader', () => {
  test('returns a diagram when the loaded build has no init function', async () => {
    const { result } = renderHook(() => useChordDiagram('Am', 'guitar'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.svg).toContain('<svg');
  });
});

describe('every wasm call site in src/', () => {
  test('routes its init through the guarded helper, never calling default directly', () => {
    // The two hooks above cover the ChordPro preview path end to end;
    // the same unconditional call lived in ten other places
    // (`use-chordpro-ast`, `use-chord-staff`, `use-ireal-*`,
    // `use-pitch-module`, `use-pdf-export`, `chordpro-completion`,
    // `ireal-bar-grid`), several of which load `@chordsketch/wasm-export`
    // — an optional peer that is not installed here, so they cannot be
    // driven against a real module. This pins them by source instead.
    const offenders = sourceFiles(SRC_DIR)
      .filter((path) => path !== join(SRC_DIR, 'wasm-init.ts'))
      .filter((path) => /\.default\s*\(/.test(stripComments(readFileSync(path, 'utf8'))));

    expect(offenders).toEqual([]);
  });
});

/**
 * Drop comments so prose that merely mentions a call (`// … a second
 * init() invocation`) cannot register as one.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

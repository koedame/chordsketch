import { vi } from 'vitest';

import type { ChordDiagramWasmLoader } from '../src/use-chord-diagram.svelte';
import type { ChordWasmLoader } from '../src/use-chord-render.svelte';

/** Minimal renderer stub covering the exports `useChordRender` touches. */
export interface RenderStub {
  default: ReturnType<typeof vi.fn>;
  render_html_body: ReturnType<typeof vi.fn>;
  render_html_body_with_options: ReturnType<typeof vi.fn>;
  render_text: ReturnType<typeof vi.fn>;
  render_text_with_options: ReturnType<typeof vi.fn>;
  render_html_css: ReturnType<typeof vi.fn>;
  render_html_css_with_options: ReturnType<typeof vi.fn>;
}

export const STUB_CSS = 'body { margin: 0 }\n.chord { color: red }';

export function makeRenderStub(overrides: Partial<RenderStub> = {}): RenderStub {
  return {
    default: vi.fn(async () => undefined),
    render_html_body: vi.fn((input: string) => `<article class="song">${input}</article>`),
    render_html_body_with_options: vi.fn(
      (input: string, options: { transpose?: number; config?: string }) =>
        `<article class="song" data-transpose="${options.transpose ?? ''}">${input}</article>`,
    ),
    render_text: vi.fn((input: string) => `TEXT ${input}`),
    render_text_with_options: vi.fn(
      (input: string, options: { transpose?: number; config?: string }) =>
        `TEXT+${options.transpose ?? ''} ${input}`,
    ),
    render_html_css: vi.fn(() => STUB_CSS),
    render_html_css_with_options: vi.fn(() => STUB_CSS),
    ...overrides,
  };
}

/**
 * Wrap a stub in a render loader. The cast is safe because the stub
 * implements the narrow surface `useChordRender` actually touches.
 *
 * A fresh loader per test is what keeps the module cache in
 * `wasm-loader.ts` (keyed on loader identity) from leaking one
 * test's stub into the next.
 */
export function makeRenderLoader(stub: object): ChordWasmLoader {
  return vi.fn(async () => stub as Awaited<ReturnType<ChordWasmLoader>>);
}

/** Wrap a stub in a diagram loader. See {@link makeRenderLoader}. */
export function makeDiagramLoader(stub: object): ChordDiagramWasmLoader {
  return vi.fn(async () => stub as Awaited<ReturnType<ChordDiagramWasmLoader>>);
}

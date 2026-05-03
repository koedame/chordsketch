// Ambient declarations for `@chordsketch/wasm` exports used by the
// desktop app. The dual-package npm build regenerates the canonical
// `packages/npm/web/chordsketch_wasm.d.ts` via `wasm-pack`; this
// shim exists so a checkout without a fresh wasm build (the typical
// case for first-time clones) still typechecks. The declarations
// below cover only the *subset* of `packages/playground/src/wasm.d.ts`
// the desktop entry imports — when a new wasm export is added to
// `apps/desktop/src/main.ts`, add it here too. (The desktop omits
// `validate` / `ValidationError` because no menu / handler currently
// surfaces parser diagnostics; add those declarations alongside the
// import that needs them.)
declare module '@chordsketch/wasm' {
  export function render_html(input: string): string;
  export function render_text(input: string): string;
  export function render_pdf(input: string): Uint8Array;
  export function render_html_with_options(
    input: string,
    options: { transpose?: number; config?: string },
  ): string;
  export function render_text_with_options(
    input: string,
    options: { transpose?: number; config?: string },
  ): string;
  export function render_pdf_with_options(
    input: string,
    options: { transpose?: number; config?: string },
  ): Uint8Array;
  export function render_html_body(input: string): string;
  export function render_html_body_with_options(
    input: string,
    options: { transpose?: number; config?: string },
  ): string;
  export function render_html_css(): string;
  export function render_html_css_with_options(
    options: { transpose?: number; config?: string },
  ): string;
  // iReal Pro bindings — camelCased on the JS side via
  // `#[wasm_bindgen(js_name = ...)]`. `parseIrealb` / `serializeIrealb`
  // satisfy the `IrealbWasm` interface in `@chordsketch/ui-irealb-editor`
  // (#2367); the desktop entry passes them through unchanged.
  export function renderIrealSvg(input: string): string;
  export function parseIrealb(input: string): string;
  export function serializeIrealb(input: string): string;
  export function version(): string;
  export default function init(): Promise<void>;
}

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
  // convention. `parseIrealb` / `serializeIrealb` satisfy the
  // `IrealbWasm` interface in `@chordsketch/ui-irealb-editor` —
  // the playground passes these two functions through to the
  // editor factory unchanged (#2366).
  export function renderIrealSvg(input: string): string;
  export function parseIrealb(input: string): string;
  export function serializeIrealb(input: string): string;
  export default function init(): Promise<void>;
}

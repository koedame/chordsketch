// Tiny DOM helpers — keeps `render.ts` readable without pulling in a
// framework. Every function returns the created element so call sites
// can chain (`parent.appendChild(el(...))`) or hold a reference for
// later updates.

/** Element factory with optional class list, attributes, text content,
 * and children. `attrs` keys map directly to attribute names; HTML
 * boolean attributes (`disabled`, `readonly`) take any truthy value. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  init?: {
    class?: string | string[];
    attrs?: Record<string, string | number | boolean | null | undefined>;
    text?: string;
    children?: (Node | null | undefined)[];
  },
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (init?.class !== undefined) {
    // Accept either an array (`['a', 'b']`) or a single string —
    // and a single string may contain multiple whitespace-
    // separated class names (`'a b'`), the same shape as the HTML
    // `class=` attribute. Splitting on whitespace keeps call sites
    // tidy when adding modifier classes (`'foo foo--danger'`)
    // without having to allocate an array literal each time.
    // `classList.add` rejects names containing whitespace, so we
    // must split before calling it.
    const raw = Array.isArray(init.class) ? init.class : [init.class];
    for (const entry of raw) {
      if (!entry) continue;
      for (const c of entry.split(/\s+/)) {
        if (c) node.classList.add(c);
      }
    }
  }
  if (init?.attrs) {
    for (const [k, v] of Object.entries(init.attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (v === true) {
        node.setAttribute(k, '');
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  if (init?.text !== undefined) {
    node.textContent = init.text;
  }
  if (init?.children) {
    for (const child of init.children) {
      if (child) node.appendChild(child);
    }
  }
  return node;
}

/** Clear all child nodes from `parent`. Equivalent to setting
 * `innerHTML = ''` but avoids the HTML-parser side trip. */
export function clearChildren(parent: Node): void {
  while (parent.firstChild) {
    parent.removeChild(parent.firstChild);
  }
}

/** Per-editor-instance ID minter used by {@link field}. Constructed
 * once per editor mount so two coexisting editors in the same
 * document do not interleave IDs (relevant for headless test
 * harnesses that mount multiple editors in one jsdom and assert on
 * stable IDs, and for future split-pane / multi-tab desktop hosts). */
export class FieldIdMinter {
  private counter = 0;

  /** Generate a fresh ID. Format mirrors the pre-instance helper
   * so existing CSS selectors / accessibility tooling that grep
   * for `irealb-editor-field-` continue to work. */
  next(): string {
    this.counter += 1;
    return `irealb-editor-field-${this.counter}`;
  }
}

/** Helper for grouping a `<label>` + `<input>` pair so the form
 * layout stays declarative. Returns the wrapper `<div>`; assigns
 * `input.id` from the per-editor `minter` if the input does not
 * already have one. */
export function field(
  labelText: string,
  input: HTMLInputElement | HTMLSelectElement,
  minter: FieldIdMinter,
): HTMLDivElement {
  const id = input.id || minter.next();
  input.id = id;
  const label = el('label', { attrs: { for: id }, text: labelText });
  return el('div', { class: 'irealb-editor__field', children: [label, input] });
}

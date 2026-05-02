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
    const classes = Array.isArray(init.class) ? init.class : [init.class];
    for (const c of classes) {
      if (c) node.classList.add(c);
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

/** Helper for grouping a `<label>` + `<input>` pair so the form
 * layout stays declarative. Returns the wrapper `<div>` so the caller
 * can attach event listeners on the contained input via the second
 * tuple member. */
export function field(
  labelText: string,
  input: HTMLInputElement | HTMLSelectElement,
): HTMLDivElement {
  const id = input.id || generateFieldId();
  input.id = id;
  const label = el('label', { attrs: { for: id }, text: labelText });
  return el('div', { class: 'irealb-editor__field', children: [label, input] });
}

let fieldIdCounter = 0;
function generateFieldId(): string {
  fieldIdCounter += 1;
  return `irealb-editor-field-${fieldIdCounter}`;
}

<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/react-ui

[![npm](https://img.shields.io/npm/v/@chordsketch/react-ui)](https://www.npmjs.com/package/@chordsketch/react-ui)

Wasm-free React design-system primitives for [ChordSketch](https://github.com/koedame/chordsketch) — the Rust ChordPro / iReal Pro engine. This package is the React binding of the ChordSketch design system: buttons, cards, badges, and form controls that compose the canonical design-system class vocabulary. It carries **no `@chordsketch/wasm` dependency**, so you can use it to build app chrome around the editor components from [`@chordsketch/react`](https://www.npmjs.com/package/@chordsketch/react) without pulling the WebAssembly bundle.

## Installation

```bash
npm install @chordsketch/react-ui
```

The package ships a single stylesheet — import it once at your app root (see Quick start).

## Quick start

```tsx
import { Button, Badge } from '@chordsketch/react-ui';
import '@chordsketch/react-ui/styles.css';

export function Toolbar() {
  return (
    <div>
      <Button variant="primary" onClick={() => save()}>
        Save
      </Button>
      <Button as="a" href="/docs" variant="ghost" size="sm">
        Docs
      </Button>
      <Badge variant="success" dot>
        Saved
      </Badge>
    </div>
  );
}
```

## API

All components are pure class composition over the canonical design-system classes; they add no behaviour beyond rendering the right markup. Load `@chordsketch/react-ui/styles.css` for them to be styled.

| Export | Element | Notes |
|---|---|---|
| `<Button>` | `<button>` / `<a>` | `variant` (`primary` \| `secondary` \| `ghost` \| `danger`), `size` (`sm` \| `md` \| `lg`), `iconOnly`, `isLoading`; `as="a"` renders a link. |
| `<Card>` | `<article>` | `variant` (`song` \| `setlist` \| `featured`), `featured` (song variant accent). Compose the inner structure with the design-system classes. |
| `<Badge>` | `<span>` | `variant` (`success` \| `warning` \| `danger` \| `info` \| `crimson` \| `muted` \| `key` \| `key-crimson` \| `format`), `dot`. |
| `<Pill>` | `<span>` | Genre pill; `solid` for the inverted fill. |
| `<Field>` | `<div>` | Label + control + `help` / `error` row wrapper. |
| `<Input>` | `<input>` | `error` toggles the error border. |
| `<Textarea>` | `<textarea>` | Multiline input. |
| `<Select>` | `<select>` | Native select with the design-system chevron. |
| `<Checkbox>` / `<Radio>` | `<label>` | Hidden native input + custom `.box`; pass `label`. |
| `<Switch>` | `<label>` | Toggle switch; pass `label`. |
| `<Segmented>` | `<div role="group">` | Single-select button group; `options`, `value`, `onValueChange`, `ariaLabel`. |
| `version` | `string` | The installed package version. |

## Design system

The class vocabulary, tokens, and visual contract are defined upstream in
[`design-system/DESIGN.md`](https://github.com/koedame/chordsketch/blob/main/design-system/DESIGN.md)
and the static references under `design-system/preview/`. This package is the
React binding of that layer (see
[ADR-0029](https://github.com/koedame/chordsketch/blob/main/docs/adr/0029-react-ui-primitives-package.md)); the design system itself remains the source of truth.

## Links

- Repository: <https://github.com/koedame/chordsketch>
- Playground: <https://chordsketch.koeda.me>
- Editor components (wasm-backed): [`@chordsketch/react`](https://www.npmjs.com/package/@chordsketch/react)
- Issues: <https://github.com/koedame/chordsketch/issues>

## License

MIT

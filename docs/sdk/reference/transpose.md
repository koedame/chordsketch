# `<Transpose>` + `useTranspose`

A native `<select>` for semitone transposition, and the clamped
state hook that drives it. Keyboard and screen-reader support come
from the browser's own control; the hook surfaces the same state for
hosts that want a different UI shell.

## `<Transpose>`

```tsx
import { Transpose, useTranspose } from '@chordsketch/react';

const { value, setValue } = useTranspose();

<Transpose value={value} onChange={setValue} />
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `value` | `number` | (required) | Current semitone offset (controlled). |
| `onChange` | `(next: number) => void` | (required) | Fires when the user picks an option. |
| `min` | `number` | `-6` | Lowest option. Pass down to `-11` to widen the list. |
| `max` | `number` | `+6` | Highest option. Pass up to `+11` to widen the list. |
| `step` | `number` | `1` | Gap between adjacent options. |
| `label` | `ReactNode` | `"Transpose"` | Visible label before the select. `null` hides it; the select keeps its `aria-label`. |
| `formatValue` | `(value: number) => string \| number` | signed integer | Text of each option. |

Options run highest first (`+6 … 0 … -6`). A controlled `value` that
is out of range or off the step grid selects the nearest rendered
option. Standard `HTMLAttributes<HTMLDivElement>` are forwarded to
the wrapper.

## `useTranspose`

```ts
function useTranspose(options?: UseTransposeOptions): UseTransposeResult;
```

| Option | Type | Default | Description |
|---|---|---|---|
| `initial` | `number` | `0` | Initial value. |
| `min` | `number` | `-11` | Clamp floor. |
| `max` | `number` | `11` | Clamp ceiling. |

Returns:

| Field | Type | Description |
|---|---|---|
| `value` | `number` | Current offset. |
| `setValue` | `(next: number) => void` | Clamps to `[min, max]` before updating. |
| `increment` | `(step?: number) => void` | Adds `step` (default `1`), clamped. |
| `decrement` | `(step?: number) => void` | Subtracts `step` (default `1`), clamped. |
| `reset` | `() => void` | Returns to `initial`. |

The two defaults differ on purpose: the hook clamps to the feature
limit `±11` (a full octave is the identity), while the select offers
the narrower `±6` that is useful in practice. Pass `min` / `max` to
`<Transpose>` to widen its options to the hook's range.

Use the hook directly to drive a custom UI (slider, number input,
keyboard shortcut) while reusing the clamping logic.

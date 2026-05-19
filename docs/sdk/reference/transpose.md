# `<Transpose>` + `useTranspose`

Accessible ± / reset control for semitone transposition. The
component handles announce-on-change (`aria-live="polite"`),
keyboard shortcuts (`+` / `−` / `0` while focus is inside), and
clamping; the hook surfaces the same state-machine for hosts that
want a different UI shell.

## `<Transpose>`

```tsx
import { Transpose, useTranspose } from '@chordsketch/react';

const { value, setValue } = useTranspose({ min: -11, max: 11 });

<Transpose value={value} onChange={setValue} />
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `value` | `number` | (required) | Current semitone offset (controlled). |
| `onChange` | `(next: number) => void` | (required) | Fires when a button or shortcut commits a new value. |
| `min` | `number` | `-11` | Minimum offset the buttons / shortcuts will emit. |
| `max` | `number` | `+11` | Maximum offset. |
| `step` | `number` | `1` | Step size for `+` / `−`. |
| `resetValue` | `number` | initial `value` | Value emitted by the reset button. |
| `label` | `ReactNode` | `"Transpose"` | Accessible label rendered above the control. |
| `formatValue` | `(value: number) => ReactNode` | signed integer | Formatter for the current-offset indicator. |

Standard `HTMLAttributes<HTMLDivElement>` are forwarded to the
wrapper.

## `useTranspose`

```ts
function useTranspose(options?: UseTransposeOptions): UseTransposeResult;
```

| Option | Type | Default | Description |
|---|---|---|---|
| `initial` | `number` | `0` | Initial value. |
| `min` | `number` | `-11` | Clamp floor. |
| `max` | `number` | `11` | Clamp ceiling. |
| `step` | `number` | `1` | Step for `increment` / `decrement`. |

Returns:

| Field | Type | Description |
|---|---|---|
| `value` | `number` | Current offset. |
| `setValue` | `(next: number) => void` | Clamps to `[min, max]` before updating. |
| `increment` | `() => void` | Adds `step`, clamped. |
| `decrement` | `() => void` | Subtracts `step`, clamped. |
| `reset` | `() => void` | Returns to `initial`. |

Use the hook directly to drive a custom UI (slider, dropdown,
command-palette entry) while reusing the clamping logic.

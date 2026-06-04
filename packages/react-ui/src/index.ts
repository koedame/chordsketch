// @chordsketch/react-ui — wasm-free React design-system primitives.
//
// The React binding of the framework-agnostic design system
// (`design-system/DESIGN.md` / `tokens.css`). Per ADR-0029 this package
// carries no `@chordsketch/wasm*` dependency; it is pure class
// composition over the canonical class vocabulary. Load the stylesheet
// once via `import '@chordsketch/react-ui/styles.css'`.

import packageJson from '../package.json' with { type: 'json' };

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './button';
export { Card, type CardProps, type CardVariant } from './card';
export { Badge, type BadgeProps, type BadgeVariant, Pill, type PillProps } from './badge';
export {
  Field,
  type FieldProps,
  Input,
  type InputProps,
  Textarea,
  type TextareaProps,
  Select,
  type SelectProps,
  Checkbox,
  type CheckboxProps,
  Radio,
  type RadioProps,
  Switch,
  type SwitchProps,
  Segmented,
  type SegmentedProps,
  type SegmentedOption,
} from './form';

/** The package version, read from `package.json`. */
export const version: string = packageJson.version;

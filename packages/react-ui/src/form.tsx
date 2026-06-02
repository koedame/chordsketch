import * as React from 'react';

export interface FieldProps {
  label?: React.ReactNode;
  /** `id` of the control this label points at. */
  htmlFor?: string;
  /** Help text rendered below the control (hidden when `error` is set). */
  help?: React.ReactNode;
  /** Error text rendered below the control; takes precedence over `help`. */
  error?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

/** Field wrapper (`.field`) — label + control + help/error row. */
export function Field({
  label,
  htmlFor,
  help,
  error,
  className,
  children,
}: FieldProps): React.ReactElement {
  const cls = ['field', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      {label != null ? <label htmlFor={htmlFor}>{label}</label> : null}
      {children}
      {error != null ? (
        <span className="err">{error}</span>
      ) : help != null ? (
        <span className="help">{help}</span>
      ) : null}
    </div>
  );
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Mark the field invalid: applies the `.error` border and sets `aria-invalid`. */
  invalid?: boolean;
}

/** Text input primitive (`.input`). */
export function Input({ invalid = false, className, ...rest }: InputProps): React.ReactElement {
  const cls = ['input', invalid ? 'error' : '', className ?? ''].filter(Boolean).join(' ');
  return <input className={cls} aria-invalid={invalid || undefined} {...rest} />;
}

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Multiline text input primitive (`.textarea`). */
export function Textarea({ className, ...rest }: TextareaProps): React.ReactElement {
  const cls = ['textarea', className ?? ''].filter(Boolean).join(' ');
  return <textarea className={cls} {...rest} />;
}

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/** Native select primitive (`.select`) with the design-system chevron. */
export function Select({ className, children, ...rest }: SelectProps): React.ReactElement {
  const cls = ['select', className ?? ''].filter(Boolean).join(' ');
  return (
    <select className={cls} {...rest}>
      {children}
    </select>
  );
}

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode;
}

/** Checkbox primitive (`.check`) — hidden input + custom `.box`. */
export function Checkbox({ label, className, ...rest }: CheckboxProps): React.ReactElement {
  const cls = ['check', className ?? ''].filter(Boolean).join(' ');
  return (
    <label className={cls}>
      <input type="checkbox" {...rest} />
      <span className="box" />
      {label}
    </label>
  );
}

export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode;
}

/** Radio primitive (`.radio`) — hidden input + custom `.box`. */
export function Radio({ label, className, ...rest }: RadioProps): React.ReactElement {
  const cls = ['radio', className ?? ''].filter(Boolean).join(' ');
  return (
    <label className={cls}>
      <input type="radio" {...rest} />
      <span className="box" />
      {label}
    </label>
  );
}

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode;
}

/** Toggle switch primitive (`.switch`) — hidden checkbox + `.track`. */
export function Switch({ label, className, ...rest }: SwitchProps): React.ReactElement {
  const cls = ['switch', className ?? ''].filter(Boolean).join(' ');
  return (
    <label className={cls}>
      <input type="checkbox" {...rest} />
      <span className="track" />
      {label}
    </label>
  );
}

export interface SegmentedOption<T extends string> {
  label: React.ReactNode;
  value: T;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onValueChange: (value: T) => void;
  /** Accessible group label (the control has `role="group"`). */
  ariaLabel: string;
  className?: string;
}

/**
 * Segmented control (`.segmented`) — a single-select group of buttons,
 * one pressed at a time via `aria-pressed`.
 */
export function Segmented<T extends string>({
  options,
  value,
  onValueChange,
  ariaLabel,
  className,
}: SegmentedProps<T>): React.ReactElement {
  const cls = ['segmented', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls} role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={opt.value === value}
          onClick={() => onValueChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

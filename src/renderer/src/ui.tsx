import { ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

type ButtonState = "loading" | "error" | "success";

export function Button({
  variant = "secondary",
  size,
  block,
  state,
  icon,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "lg";
  block?: boolean;
  state?: ButtonState;
  icon?: ReactNode;
}) {
  const cls = [
    "btn",
    variant !== "secondary" && `btn--${variant}`,
    size && `btn--${size}`,
    block && "btn--block",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={cls}
      data-state={state}
      aria-busy={state === "loading" || undefined}
      {...rest}
    >
      {state === "loading" ? <span className="spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/** Label above, helper below with a reserved line; an error replaces the helper. */
export function Field({
  label,
  helper,
  error,
  children,
}: {
  label: ReactNode;
  helper?: ReactNode;
  error?: string;
  children: (props: { id: string; "aria-describedby": string; "aria-invalid"?: true }) => ReactNode;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children({ id, "aria-describedby": helpId, ...(error && { "aria-invalid": true as const }) })}
      <p className="field__helper" id={helpId} data-tone={error ? "error" : undefined}>
        {error ?? helper}
      </p>
    </div>
  );
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="select">
      <select className={`control ${className}`} {...rest}>
        {children}
      </select>
      <ChevronDown aria-hidden />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Native <dialog> in modal mode: focus trap, Esc and inert background come from the platform. */
export function Dialog({
  open,
  onClose,
  className = "",
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // The platform can close a modal on its own (e.g. a repeated Esc); keep React state in sync.
      onClose={() => {
        if (open) onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && children}
    </dialog>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className = "",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      className={`switch ${className}`}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" aria-hidden />
    </button>
  );
}

/** A radio group drawn as one segmented control; arrow keys move the choice. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const i = options.findIndex((o) => o.value === value);
        const next = options[(i + step + options.length) % options.length];
        onChange(next.value);
        (e.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
          className="segmented__item"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A text input that commits on blur or Enter and reverts on Esc, so instant-save settings do not
 * write on every keystroke.
 */
export function CommitInput({
  value,
  onCommit,
  multiline,
  ...rest
}: {
  value: string;
  onCommit: (next: string) => void;
  multiline?: boolean;
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  type?: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  const props = {
    ...rest,
    className: "control",
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setDraft(value);
      } else if (e.key === "Enter" && !(multiline && !e.metaKey)) {
        e.preventDefault();
        commit();
      }
    },
  };
  return multiline ? <textarea {...props} /> : <input {...props} />;
}

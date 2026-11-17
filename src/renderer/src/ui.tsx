import { ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
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

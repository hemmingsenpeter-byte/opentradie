import { useEffect, useId, useRef } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { Icon } from './Icons';
import type { IconName } from './Icons';

type Variant = 'primary' | 'secondary' | 'go' | 'stop' | 'quiet';

export function Button({
  variant = 'secondary',
  block = false,
  icon,
  busy = false,
  children,
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  block?: boolean;
  icon?: IconName;
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} ${block ? 'btn-block' : ''} ${className}`}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : icon && <Icon name={icon} />}
      <span>{children}</span>
    </button>
  );
}

export function LinkButton({
  href,
  variant = 'secondary',
  block = false,
  icon,
  children,
  className = '',
}: {
  href: string;
  variant?: Variant;
  block?: boolean;
  icon?: IconName;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a href={href} className={`btn btn-${variant} ${block ? 'btn-block' : ''} ${className}`}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </a>
  );
}

export function PageHeader({
  title,
  eyebrow,
  back,
  actions,
  children,
}: {
  title: string;
  eyebrow?: string;
  back?: { href: string; label: string };
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      {back && (
        <a className="back-link" href={back.href}>
          <Icon name="back" size={20} />
          {back.label}
        </a>
      )}
      <div className="page-header-row">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="page-title">{title}</h1>
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function Section({
  title,
  count,
  action,
  children,
  className = '',
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={`card ${className}`} aria-labelledby={id}>
      <div className="section-head">
        <h2 id={id} className="section-title">
          {title}
          {count !== undefined && <span className="count">{count}</span>}
        </h2>
        {action}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

export type Tone = 'draft' | 'approved' | 'rejected' | 'neutral' | 'info';

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function MockBadge() {
  return (
    <span
      className="pill pill-mock"
      title="Assistant replies come from a fixed demo parser, not a language model."
    >
      <Icon name="warning" size={16} />
      Mock agent — not a real AI
    </span>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Notice({
  tone,
  title,
  children,
  action,
}: {
  tone: 'error' | 'warning' | 'info' | 'success';
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const icon: IconName = tone === 'success' ? 'check' : tone === 'info' ? 'shield' : 'warning';
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <div className="min-w-0 flex-1">
        {title && <p className="notice-title">{title}</p>}
        {children && <div>{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

export function ErrorNotice({
  error,
  retry,
  title = 'That didn’t work',
}: {
  error: unknown;
  retry?: () => void;
  title?: string;
}) {
  const message =
    error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  return (
    <Notice
      tone="error"
      title={title}
      action={
        retry && (
          <Button icon="refresh" onClick={retry}>
            Try again
          </Button>
        )
      }
    >
      {message}
    </Notice>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={32} />
      <p className="empty-title">{title}</p>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

/** Shown wherever a viewer sees a disabled owner-only control, so it is never a dead end. */
export function ViewOnlyNote({
  children = 'You are signed in with view-only access. Only the business owner can make changes.',
}: {
  children?: ReactNode;
}) {
  return (
    <p className="view-only">
      <Icon name="lock" size={18} />
      <span>{children}</span>
    </p>
  );
}

export function TextField({
  label,
  hint,
  optional,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; optional?: boolean }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} {optional && <span className="optional">optional</span>}
      </label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...rest} />
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export function TextArea({
  label,
  hint,
  optional,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: string;
  optional?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} {optional && <span className="optional">optional</span>}
      </label>
      <textarea id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...rest} />
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...rest}>
        {children}
      </select>
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Native modal dialog: focus trapping, Escape and inert background come from the browser. */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
    return () => dialog?.close?.();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId} className="section-title">
          {title}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}

/**
 * Shared UI primitives (M3). Token-only styling (primitives.css). No new deps.
 * User-visible labels are Russian.
 */

import { useEffect, useId } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ Button */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={cx(
        "btn",
        `btn-${variant}`,
        size === "sm" ? "btn-sm" : null,
        className,
      )}
      {...rest}
    />
  );
}

/* ------------------------------------------------------------------- Input */

export function Input({
  label,
  hint,
  error,
  id,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint || error ? `${inputId}-hint` : undefined;

  return (
    <label className={cx("input-field", className)} htmlFor={inputId}>
      {label ? <span className="input-label">{label}</span> : null}
      <input
        id={inputId}
        className={cx("input", error ? "input-invalid" : null)}
        aria-invalid={error ? true : undefined}
        aria-describedby={hintId}
        {...rest}
      />
      {error ? (
        <span className="input-error" id={hintId}>
          {error}
        </span>
      ) : hint ? (
        <span className="input-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/* -------------------------------------------------- Jacred attribution */

/**
 * Credit for search/release discovery powered by JacRed.
 * The brand name links to the JacRed referral URL.
 */
export function JacredAttribution({ className }: { className?: string }) {
  return (
    <p
      className={cx("jacred-attribution", className)}
      title="Поиск и подбор релизов выполняется системой JacRed"
    >
      <span>
        Поиск работает на{" "}
        <a
          className="jacred-attribution-link"
          href="https://jacred.su/r/287f21cb-494d-4e9c-a29a-1f2eaf7c8082"
          target="_blank"
          rel="noopener noreferrer"
        >
          JacRed
        </a>
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------- Badge */

export type BadgeTone = "neutral" | "accent" | "danger";

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children?: ReactNode;
}) {
  return <span className={cx("badge", `badge-${tone}`, className)}>{children}</span>;
}

/* ---------------------------------------------------------------- Spinner */

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------- ProgressBar */

export function ProgressBar({
  value,
  max = 100,
  label,
}: {
  value: number;
  max?: number;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(value, max));
  const pct = max > 0 ? (clamped / max) * 100 : 0;
  return (
    <div className="progress">
      {label ? <div className="progress-label">{label}</div> : null}
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={clamped}
        aria-label={label}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------- Empty / ErrorState */

export function EmptyState({
  title = "Пусто",
  description = "Здесь пока ничего нет.",
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state state-empty">
      <strong>{title}</strong>
      <p>{description}</p>
      {action ? <div className="state-actions">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Ошибка",
  description = "Что-то пошло не так. Попробуйте ещё раз.",
  onRetry,
  retryLabel = "Повторить",
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="state state-error" role="alert">
      <strong>{title}</strong>
      <p>{description}</p>
      {onRetry ? (
        <div className="state-actions">
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- Modal */

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </Button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- RatingStars */

/**
 * Rating display on a 0–10 scale (Kinopoisk-style), rendered as 5 stars.
 * Read-only; review editing arrives in a later milestone.
 */
export function RatingStars({
  value,
  max = 10,
  className,
}: {
  value: number | null | undefined;
  max?: number;
  className?: string;
}) {
  const starCount = 5;
  const score = value == null || Number.isNaN(value) ? 0 : Math.max(0, Math.min(value, max));
  const filled = (score / max) * starCount;

  return (
    <span
      className={cx("rating", className)}
      role="img"
      aria-label={value == null ? "Нет оценки" : `Оценка ${score.toFixed(1)} из ${max}`}
      title={value == null ? "Нет оценки" : `${score.toFixed(1)} / ${max}`}
    >
      {Array.from({ length: starCount }, (_, i) => {
        const level = Math.max(0, Math.min(1, filled - i));
        return (
          <span key={i} className="rating-star" aria-hidden="true">
            <span className="rating-star-fill" style={{ width: `${level * 100}%` }}>
              ★
            </span>
            <span className="rating-star-empty">★</span>
          </span>
        );
      })}
    </span>
  );
}

/* --------------------------------------------------------------- PosterCard */

export function PosterCard({
  title,
  subtitle,
  posterUrl,
  rating,
  href,
  onClick,
  className,
}: {
  title: string;
  subtitle?: string;
  posterUrl?: string | null;
  /** 0–10 rating shown as stars; omit to hide. */
  rating?: number | null;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const interactive = Boolean(href ?? onClick);
  const body = (
    <>
      <div className="poster-art">
        {posterUrl ? (
          <img className="poster-img" src={posterUrl} alt="" loading="lazy" />
        ) : (
          <div className="poster-fallback" aria-hidden="true">
            {title.slice(0, 1)}
          </div>
        )}
      </div>
      <div className="poster-meta">
        <div className="poster-title" title={title}>
          {title}
        </div>
        {subtitle ? <div className="poster-subtitle">{subtitle}</div> : null}
        {rating != null ? <RatingStars value={rating} className="poster-rating" /> : null}
      </div>
    </>
  );

  const cls = cx("poster-card", interactive ? "poster-card-interactive" : null, className);

  if (href) {
    return (
      <a className={cls} href={href} onClick={onClick}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

/* --------------------------------------------------------------------- Row */

export function Row({
  title,
  subtitle,
  leading,
  trailing,
  href,
  onClick,
  selected,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  href?: string;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}) {
  const cls = cx("row", selected ? "row-selected" : null, className);
  const inner = (
    <>
      {leading ? <div className="row-leading">{leading}</div> : null}
      <div className="row-text">
        <div className="row-title">{title}</div>
        {subtitle ? <div className="row-subtitle">{subtitle}</div> : null}
      </div>
      {trailing ? <div className="row-trailing">{trailing}</div> : null}
    </>
  );

  if (href) {
    return (
      <a className={cls} href={href} onClick={onClick} aria-current={selected ? "page" : undefined}>
        {inner}
      </a>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        onClick={onClick}
        aria-current={selected ? "page" : undefined}
      >
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}

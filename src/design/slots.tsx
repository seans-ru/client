import type { ReactNode } from "react";
import { EmptyState, ErrorState, Spinner } from "./primitives";

/**
 * Shared loading / empty / error slots used by M1 screens.
 * Thin wrappers over the M3 primitives (same Russian defaults).
 */
export function LoadingSlot({ label = "Загрузка…", logo = false }: { label?: string; logo?: boolean }) {
  return (
    <div className={`slot slot-loading${logo ? " slot-loading-logo" : ""}`}>
      {logo ? <img className="loading-logo" src="/seans-icon-animated.svg" alt="" /> : null}
      {logo ? (
        <span className="loading-logo-label" role="status" aria-live="polite">
          {label}
        </span>
      ) : (
        <Spinner label={label} />
      )}
    </div>
  );
}

export function EmptySlot({
  title = "Пусто",
  description = "Здесь пока ничего нет.",
}: {
  title?: string;
  description?: string;
}) {
  return <EmptyState title={title} description={description} />;
}

export function ErrorSlot({
  title = "Ошибка",
  description = "Что-то пошло не так. Попробуйте ещё раз.",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <ErrorState title={title} description={description} onRetry={onRetry} />
  );
}

export function Screen({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="screen">
      <header className="screen-header">
        <h1>{title}</h1>
      </header>
      <div className="screen-body">{children}</div>
    </section>
  );
}

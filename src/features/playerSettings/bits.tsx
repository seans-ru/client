/**
 * Small building blocks for the player settings section: switch, eye toggle,
 * and the icon glyphs used by the preview mockup.
 */

import type { ReactElement } from "react";

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="ps-toggle"
      onClick={() => onChange(!checked)}
    />
  );
}

export function EyeToggle({
  visible,
  onChange,
  label,
}: {
  visible: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={visible}
      aria-label={label}
      title={label}
      className="ps-eye"
      onClick={() => onChange(!visible)}
    >
      {visible ? <EyeOpenIcon /> : <EyeOffIcon />}
    </button>
  );
}

function EyeOpenIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 3.5C4.8 3.5 2.3 5.6 1.2 8c1.1 2.4 3.6 4.5 6.8 4.5s5.7-2.1 6.8-4.5C13.7 5.6 11.2 3.5 8 3.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  );
}

function EyeOffIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 2l12 12M6.2 6.3A2 2 0 008 10a2 2 0 001.7-1M3.5 4.4C2.2 5.4 1.4 6.6 1.2 8c1.1 2.4 3.6 4.5 6.8 4.5 1.2 0 2.3-.2 3.2-.7M6.1 3.7A7.7 7.7 0 018 3.5c3.2 0 5.7 2.1 6.8 4.5-.4.9-1 1.7-1.8 2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Short glyphs for the preview mockup control buttons. */
export function PreviewIcon({ id }: { id: string }): ReactElement {
  switch (id) {
    case "btn.playPause":
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M4 2.5v9l8-4.5z" fill="currentColor" />
        </svg>
      );
    case "btn.volume":
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 5.5h2.2L7 3v8L4.2 8.5H2z" fill="currentColor" />
          <path d="M9 5c.9.7.9 3.3 0 4M10.6 3.8c1.4 1.3 1.4 5.1 0 6.4" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      );
    case "btn.settings":
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="1.8" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path
            d="M7 1.8v1.4M7 10.8v1.4M1.8 7h1.4M10.8 7h1.4M3.3 3.3l1 1M9.7 9.7l1 1M10.7 3.3l-1 1M4.3 9.7l-1 1"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "btn.sidecar":
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M9 2.5v9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case "btn.fullscreen":
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M2 5V2h3M12 5V2H9M2 9v3h3M12 9v3H9"
            stroke="currentColor"
            strokeWidth="1.3"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return <span aria-hidden="true">•</span>;
  }
}

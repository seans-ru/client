/**
 * Auto-hide policy (spec: docs/compose/spec/clean-screen.md §S2.2).
 *
 * Pure rules — no DOM / timers / React. The `autoHide` extension wires them
 * to activity listeners and `ctx.ui.setChromeHidden`.
 */

/** Inputs deciding whether the player chrome may hide right now. */
export type ChromeVisibilityInput = {
  /** «Не скрывать» setting — never hide while on. */
  neverHide: boolean;
  fileLoaded: boolean;
  pause: boolean;
  eof: boolean;
};

/** Hide only during active playback and when «Не скрывать» is off. */
export function shouldHideChrome(input: ChromeVisibilityInput): boolean {
  return input.fileLoaded && !input.pause && !input.eof && !input.neverHide;
}

export const MIN_DELAY_SEC = 2;
export const MAX_DELAY_SEC = 10;
export const DEFAULT_DELAY_SEC = 3;

/**
 * Normalize a stored delay to an integer in [2, 10].
 * Non-finite / missing input falls back to the default (3).
 */
export function clampDelaySec(value: number | null | undefined): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : DEFAULT_DELAY_SEC;
  return Math.min(MAX_DELAY_SEC, Math.max(MIN_DELAY_SEC, n));
}

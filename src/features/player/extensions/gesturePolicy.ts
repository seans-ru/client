/**
 * Touch / trackpad gesture classification (issue #26) — pure logic,
 * unit-tested. The live listeners live in `keyboardNav.tsx`.
 *
 * Zones over the video area (left third / center / right third) drive
 * double-tap seeks; edge strips (20%) drive vertical volume / brightness
 * swipes; a downward flick in the center exits fullscreen.
 */

export type TapZone = "left" | "center" | "right";

/** Width ratio of the left/right edge strips used for vertical swipes. */
export const EDGE_RATIO = 0.2;

/** Max gap between taps to count as a double-tap (ms). */
export const DOUBLE_TAP_MS = 300;

/** Double-tap seek step (issue: ±10 s). */
export const DOUBLE_TAP_SEEK_SEC = 10;

/** Movement (px) below which a pointer sequence stays a tap. */
export const TAP_SLOP_PX = 12;

/** Movement (px) before a drag becomes a swipe (scaled by sensitivity). */
export const SWIPE_THRESHOLD_PX = 40;

/** Volume units per pixel of vertical drag (at sensitivity 1). */
export const VOLUME_PER_PX = 0.15;

/** Brightness units (-100..100) per pixel of vertical drag. */
export const BRIGHTNESS_PER_PX = 0.1;

export function tapZoneForX(x: number, width: number): TapZone {
  if (!(width > 0)) return "center";
  const ratio = x / width;
  if (ratio < 1 / 3) return "left";
  if (ratio > 2 / 3) return "right";
  return "center";
}

export function isLeftEdge(x: number, width: number): boolean {
  return width > 0 && x <= width * EDGE_RATIO;
}

export function isRightEdge(x: number, width: number): boolean {
  return width > 0 && x >= width * (1 - EDGE_RATIO);
}

export type TapRecord = {
  zone: TapZone;
  time: number;
};

/** A second tap in the same zone within the window is a double-tap. */
export function classifyTap(
  prev: TapRecord | null,
  next: TapRecord,
  windowMs: number = DOUBLE_TAP_MS,
): "single" | "double" {
  if (prev && prev.zone === next.zone && next.time - prev.time <= windowMs) {
    return "double";
  }
  return "single";
}

export type SwipeKind = "volume" | "brightness" | "exit-fullscreen";

export type SwipeInput = {
  dx: number;
  dy: number;
  /** Pointer-down x within the video area (px). */
  startX: number;
  /** Video area width (px). */
  width: number;
  fullscreen: boolean;
  /** Effective threshold (base px × sensitivity). */
  threshold: number;
};

/**
 * Classify a finished drag. Vertical wins ties; anything below the
 * threshold or horizontal-only is not a swipe (`null`).
 */
export function classifySwipe(input: SwipeInput): SwipeKind | null {
  const { dx, dy, startX, width, fullscreen, threshold } = input;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const limit = threshold > 0 ? threshold : SWIPE_THRESHOLD_PX;
  if (absY < limit && absX < limit) return null;
  if (absY < absX) return null; // horizontal — not a vertical gesture
  if (isLeftEdge(startX, width)) return "volume";
  if (isRightEdge(startX, width)) return "brightness";
  // Center: downward flick exits fullscreen (issue #26).
  if (dy > 0 && fullscreen) return "exit-fullscreen";
  return null;
}

/** Pixel delta → control units; negative `dy` (up) increases the value. */
export function deltaFromSwipe(
  pixels: number,
  sensitivity: number,
  unitPerPx: number,
): number {
  const s = Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : 1;
  return -pixels * unitPerPx * s;
}

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function clampBrightness(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(-100, Math.round(value)));
}

/** Sensitivity choices exposed in the settings row. */
export const SENSITIVITY_OPTIONS = [
  { value: 0.5, label: "Низкая" },
  { value: 1, label: "Средняя" },
  { value: 2, label: "Высокая" },
] as const;

export function clampSensitivity(value: number | null | undefined): number {
  if (value == null) return 1;
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  let best: number = SENSITIVITY_OPTIONS[0].value;
  for (const option of SENSITIVITY_OPTIONS) {
    if (Math.abs(option.value - n) < Math.abs(best - n)) best = option.value;
  }
  return best;
}

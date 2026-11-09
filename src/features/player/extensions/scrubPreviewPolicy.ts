/**
 * Scrub-preview cache policy (issue #17) — pure, no DOM. Thumbnails come from
 * the `ctx.frames` tap during viewing (stride samples, max side 32) and are
 * kept per file with a frame-count cap and a serialized-size cap. Capture is
 * bucketed so at most one frame is stored per `captureStepSec` window.
 */

/** Hard cap of cached thumbnails per file. */
export const MAX_PREVIEW_FRAMES = 180;
/** Minimum seconds between captured frames (issue: 1/5вЂ“10 s). */
export const MIN_CAPTURE_STEP_SEC = 5;
/** Serialized cache budget per file (localStorage-friendly). */
export const MAX_CACHE_BYTES = 1_500_000;
/** Nearest-frame lookup is only useful inside this distance. */
export const LOOKUP_TOLERANCE_SEC = 20;

export type PreviewFrame = {
  /** Playback position of the frame (seconds). */
  tSec: number;
  /** `canvas.toDataURL(...)` thumbnail. */
  dataUrl: string;
};

/**
 * Capture step for a file: at least `MIN_CAPTURE_STEP_SEC`, stretched for
 * long files so the count cap is respected without eviction churn.
 */
export function captureStepSec(durationSec: number): number {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (d <= 0) return MIN_CAPTURE_STEP_SEC;
  return Math.max(MIN_CAPTURE_STEP_SEC, d / MAX_PREVIEW_FRAMES);
}

/** Bucket id of a timestamp (one captured frame per bucket). */
export function previewBucket(tSec: number, stepSec: number): number {
  const t = Number.isFinite(tSec) && tSec > 0 ? tSec : 0;
  const step = stepSec > 0 ? stepSec : MIN_CAPTURE_STEP_SEC;
  return Math.floor(t / step);
}

/**
 * Insert a frame into a bucketed, sorted cache. Returns `null` when nothing
 * changes (bad input or the bucket is already filled); otherwise a new list,
 * trimmed to `maxFrames` by dropping the oldest frames.
 */
export function addPreviewFrame(
  list: readonly PreviewFrame[],
  frame: PreviewFrame,
  stepSec: number,
  maxFrames = MAX_PREVIEW_FRAMES,
): PreviewFrame[] | null {
  if (!Number.isFinite(frame.tSec) || frame.tSec < 0) return null;
  if (!frame.dataUrl) return null;
  const bucket = previewBucket(frame.tSec, stepSec);
  if (list.some((f) => previewBucket(f.tSec, stepSec) === bucket)) {
    return null;
  }
  const next = [...list, { tSec: frame.tSec, dataUrl: frame.dataUrl }];
  next.sort((a, b) => a.tSec - b.tSec);
  while (next.length > maxFrames) next.shift();
  return next;
}

/**
 * Frame closest to `tSec`, or null when nothing sits inside `toleranceSec`
 * (fallback: timecode-only tooltip).
 */
export function nearestPreview(
  list: readonly PreviewFrame[],
  tSec: number,
  toleranceSec = LOOKUP_TOLERANCE_SEC,
): PreviewFrame | null {
  if (list.length === 0 || !Number.isFinite(tSec)) return null;
  let best: PreviewFrame | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const frame of list) {
    const dist = Math.abs(frame.tSec - tSec);
    if (dist < bestDist) {
      bestDist = dist;
      best = frame;
    }
  }
  return best && bestDist <= toleranceSec ? best : null;
}

/** Approximate serialized size of the cache (UTF-16 code units of JSON). */
export function previewCacheBytes(list: readonly PreviewFrame[]): number {
  let bytes = 2;
  for (const frame of list) {
    bytes += frame.dataUrl.length + 32;
  }
  return bytes;
}

/**
 * Serialize for `ctx.storage`, dropping frames (newest last) until the size
 * cap is met. Returns `null` when nothing fits.
 */
export function serializePreviewCache(
  list: readonly PreviewFrame[],
  maxBytes = MAX_CACHE_BYTES,
): string | null {
  const kept: PreviewFrame[] = [];
  // Walk from the end (recent positions first) so the cap keeps the freshest.
  for (let i = list.length - 1; i >= 0; i--) {
    kept.push(list[i]);
    const payload = JSON.stringify(kept);
    if (payload.length > maxBytes) {
      kept.pop();
      break;
    }
  }
  if (kept.length === 0) return null;
  kept.reverse();
  return JSON.stringify(kept);
}

/** Parse a persisted cache; malformed payloads degrade to empty. */
export function parsePreviewCache(raw: unknown): PreviewFrame[] {
  if (!Array.isArray(raw)) return [];
  const out: PreviewFrame[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const tSec = typeof r.tSec === "number" ? r.tSec : NaN;
    const dataUrl = typeof r.dataUrl === "string" ? r.dataUrl : "";
    if (Number.isFinite(tSec) && tSec >= 0 && dataUrl) {
      out.push({ tSec, dataUrl });
    }
  }
  out.sort((a, b) => a.tSec - b.tSec);
  return out.slice(-MAX_PREVIEW_FRAMES);
}

/**
 * Pure progressive-playback helpers. No React/DOM/Tauri — unit-testable.
 *
 * Source of truth for the seek ceiling is `stream.max_seekable_bytes`
 * (falling back to `index.json.contiguous_bytes` via the same field on the
 * stream). Even if a later segment becomes available on disk/S3, the UI and
 * transport must refuse seeks beyond the last *reported* prefix until the
 * next playback/index poll updates it.
 */

import type { PlaybackStream, PlaybackVideo } from "../../api/playback";

/** Player delivery mode derived from `stream`. */
export type PlaybackMode =
  /** `complete` — full VOD, unrestricted seek. */
  | "vod"
  /** `ready && !complete` — progressive: seek only the downloaded prefix. */
  | "progressive"
  /** Not ready yet — wait for the first available segment. */
  | "waiting";

/** Dual progress values shown on the rail (0–100). */
export type DownloadProgress = {
  /** «Скачано» — `percent_downloaded` (can be non-contiguous). */
  percentDownloaded: number;
  /** «Доступно для просмотра» — `percent_seekable` / contiguous prefix. */
  percentSeekable: number;
};

export type SeekLimit = {
  /** Hard ceiling in seconds, or null when duration is unknown (percent-only). */
  maxSeekableSec: number | null;
  /** Contiguous seekable ratio 0–1, or null when unknown. */
  seekableRatio: number | null;
  /** Full duration in seconds when known. */
  durationSec: number | null;
};

export type SeekDecision =
  | { ok: true; seconds: number }
  | {
      ok: false;
      reason: "beyond_seekable" | "beyond_duration" | "not_ready";
      /** Closest allowed target (clamped), useful for UX feedback. */
      seconds: number;
    };

/** Edge buffer: treat position within this distance of the ceiling as "at edge". */
export const SEEK_EDGE_EPSILON_SEC = 0.75;

function finite(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Playback mode from `stream.ready` / `stream.complete`. */
export function resolvePlaybackMode(
  stream: Pick<PlaybackStream, "ready" | "complete"> | null | undefined,
): PlaybackMode {
  // `stream: null` = no worker heartbeat yet.
  if (!stream) return "waiting";
  if (stream.complete) return "vod";
  if (stream.ready) return "progressive";
  return "waiting";
}

/**
 * Contiguous seekable ratio 0–1.
 * Prefers `max_seekable_bytes / size_bytes`; falls back to `percent_seekable`.
 */
export function resolveSeekableRatio(input: {
  maxSeekableBytes?: number | null;
  sizeBytes?: number | null;
  percentSeekable?: number | null;
}): number | null {
  const maxBytes = finite(input.maxSeekableBytes);
  const size = finite(input.sizeBytes);
  if (maxBytes != null && size != null && size > 0) {
    return clamp01(maxBytes / size);
  }
  const pct = finite(input.percentSeekable);
  if (pct != null) return clamp01(pct / 100);
  return null;
}

/** Duration in seconds from `duration_ms` / `duration_sec` / `duration`. */
export function resolveDurationSec(input: {
  durationMs?: number | null;
  durationSec?: number | null;
  duration?: number | null;
}): number | null {
  const sec = finite(input.durationSec) ?? finite(input.duration);
  if (sec != null && sec > 0) return sec;
  const ms = finite(input.durationMs);
  if (ms != null && ms > 0) return ms / 1000;
  return null;
}

/**
 * Seek ceiling in seconds, or null when duration is unknown.
 * When duration is known: `duration * seekableRatio`
 * (equivalent to `duration_ms * percent_seekable / 100` from the contract).
 */
export function resolveSeekLimit(input: {
  durationMs?: number | null;
  durationSec?: number | null;
  duration?: number | null;
  maxSeekableBytes?: number | null;
  sizeBytes?: number | null;
  percentSeekable?: number | null;
}): SeekLimit {
  const durationSec = resolveDurationSec(input);
  const seekableRatio = resolveSeekableRatio(input);
  const maxSeekableSec =
    durationSec != null && seekableRatio != null
      ? durationSec * seekableRatio
      : null;
  return { maxSeekableSec, seekableRatio, durationSec };
}

/** Build a `SeekLimit` from a playback `stream` + `video` pair. */
export function seekLimitFromPlayback(
  stream: Pick<
    PlaybackStream,
    "max_seekable_bytes" | "percent_seekable" | "complete" | "ready" | "size_bytes"
  > | null | undefined,
  video: Pick<PlaybackVideo, "size_bytes" | "duration_ms"> | null,
): SeekLimit {
  if (!stream) {
    // No heartbeat yet — waiting; duration may still be known.
    const durationSec = resolveDurationSec({ durationMs: video?.duration_ms });
    return { maxSeekableSec: 0, seekableRatio: 0, durationSec };
  }
  // Complete file: the whole duration is seekable.
  if (stream.complete) {
    const durationSec = resolveDurationSec({ durationMs: video?.duration_ms });
    return {
      maxSeekableSec: durationSec,
      seekableRatio: durationSec != null ? 1 : null,
      durationSec,
    };
  }
  return resolveSeekLimit({
    durationMs: video?.duration_ms,
    maxSeekableBytes: stream.max_seekable_bytes,
    sizeBytes: video?.size_bytes ?? stream.size_bytes,
    percentSeekable: stream.percent_seekable,
  });
}

/**
 * Dual progress («Скачано» / «Доступно для просмотра»).
 * Values are independent: non-sequential download can make downloaded > seekable.
 */
export function resolveDownloadProgress(
  stream: Pick<
    PlaybackStream,
    "percent_downloaded" | "percent_seekable" | "complete"
  > | null | undefined,
): DownloadProgress {
  if (!stream) return { percentDownloaded: 0, percentSeekable: 0 };
  if (stream.complete) {
    return { percentDownloaded: 100, percentSeekable: 100 };
  }
  return {
    percentDownloaded: clampPct(finite(stream.percent_downloaded) ?? 0),
    percentSeekable: clampPct(finite(stream.percent_seekable) ?? 0),
  };
}

/**
 * Decide whether an absolute seek (seconds) may be sent to the transport.
 * Never allow a request past the last reported `max_seekable_bytes` ceiling.
 */
export function checkSeek(
  seconds: number,
  limit: SeekLimit,
  options: { mode?: PlaybackMode } = {},
): SeekDecision {
  const mode = options.mode ?? (limit.maxSeekableSec != null ? "progressive" : "vod");
  const raw = finite(seconds) ?? 0;
  const target = Math.max(0, raw);

  if (mode === "waiting") {
    return { ok: false, reason: "not_ready", seconds: 0 };
  }

  if (mode === "vod") {
    const duration = limit.durationSec;
    if (duration != null && duration > 0 && target > duration) {
      return { ok: false, reason: "beyond_duration", seconds: duration };
    }
    return { ok: true, seconds: target };
  }

  // progressive: hard ceiling from max_seekable_bytes
  const ceiling = limit.maxSeekableSec;
  if (ceiling == null) {
    // Duration unknown — still refuse non-finite / negative; allow relative play.
    return { ok: true, seconds: target };
  }
  if (target > ceiling + 1e-6) {
    return { ok: false, reason: "beyond_seekable", seconds: ceiling };
  }
  if (limit.durationSec != null && limit.durationSec > 0 && target > limit.durationSec) {
    return { ok: false, reason: "beyond_duration", seconds: limit.durationSec };
  }
  return { ok: true, seconds: Math.min(target, ceiling) };
}

/** Ratio (0–1) of the seek rail that is safe to scrub in progressive mode. */
export function seekableRailRatio(limit: SeekLimit, mode: PlaybackMode): number {
  if (mode === "vod") return 1;
  if (mode === "waiting") return 0;
  if (limit.seekableRatio != null) return clamp01(limit.seekableRatio);
  if (limit.maxSeekableSec != null && limit.durationSec != null && limit.durationSec > 0) {
    return clamp01(limit.maxSeekableSec / limit.durationSec);
  }
  return 0;
}

/** Downloaded rail ratio 0–1 (may exceed the seekable ratio). */
export function downloadedRailRatio(progress: DownloadProgress): number {
  return clamp01(progress.percentDownloaded / 100);
}

/** Seekable rail ratio from progress percentages. */
export function seekablePercentRailRatio(progress: DownloadProgress): number {
  return clamp01(progress.percentSeekable / 100);
}

/**
 * True when playback has run into the contiguous prefix and should pause
 * with «загрузка продолжается…» (progressive only).
 */
export function shouldPauseAtSeekEdge(
  positionSec: number,
  limit: SeekLimit,
  mode: PlaybackMode,
): boolean {
  if (mode !== "progressive") return false;
  const ceiling = limit.maxSeekableSec;
  if (ceiling == null) return false;
  const pos = finite(positionSec) ?? 0;
  return pos >= ceiling - SEEK_EDGE_EPSILON_SEC;
}

/**
 * True when the contiguous prefix grew and a waiting playback should resume.
 * Never auto-seeks backwards: the current position is kept.
 */
export function shouldAutoResumeAfterGrowth(
  previousLimit: SeekLimit | null,
  nextLimit: SeekLimit,
  options: { mode: PlaybackMode; waitingAtEdge: boolean },
): boolean {
  if (options.mode !== "progressive") return false;
  if (!options.waitingAtEdge) return false;
  const prev = previousLimit?.maxSeekableSec ?? null;
  const next = nextLimit.maxSeekableSec ?? null;
  if (next == null) return false;
  if (prev == null) return true;
  return next > prev + 1e-6;
}

/** Russian label for dual progress (rail tooltip / status line). */
export function formatProgressLabels(progress: DownloadProgress): {
  downloaded: string;
  seekable: string;
} {
  const dl = Math.round(progress.percentDownloaded * 10) / 10;
  const sk = Math.round(progress.percentSeekable * 10) / 10;
  return {
    downloaded: `Скачано ${dl}%`,
    seekable: `Доступно ${sk}%`,
  };
}

/** «смотрите до mm:ss» for the seekable ceiling. */
export function formatSeekableUntil(limit: SeekLimit): string | null {
  const ceiling = limit.maxSeekableSec;
  if (ceiling == null || !Number.isFinite(ceiling)) return null;
  const total = Math.max(0, Math.floor(ceiling));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const time = h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  return `смотрите до ${time}`;
}

/** Toast copy when the user tries to scrub into the grey zone. */
export const SEEK_BLOCKED_TOAST = "Этот момент ещё скачивается";

/** Pause copy at the contiguous-prefix edge. */
export const BUFFER_WAITING_LABEL = "Загрузка продолжается…";

/**
 * Byte-slice mapping for the progressive transport: pieces of `[start, end)`
 * that fall inside the currently seekable prefix and are backed by segments.
 */
export type ByteSlice = {
  /** Offset inside the virtual file. */
  fileStart: number;
  fileEnd: number;
  segmentIndex: number;
  /** URL of the segment that provides these bytes. */
  url: string;
};

/**
 * Map a virtual file range onto available segments.
 * Range is clipped to `[0, maxSeekableBytes)`. Unavailable segment holes are
 * skipped (caller waits) — never return slices past the seekable prefix.
 */
export function mapByteRangeToSlices(
  segments: readonly PlaybackStream["segments"][number][],
  start: number,
  end: number,
  maxSeekableBytes: number,
): ByteSlice[] {
  const lo = Math.max(0, finite(start) ?? 0);
  const hi = Math.max(lo, finite(end) ?? lo);
  const ceiling = Math.max(0, finite(maxSeekableBytes) ?? 0);
  const clippedEnd = Math.min(hi, ceiling);
  if (clippedEnd <= lo) return [];

  const out: ByteSlice[] = [];
  for (const seg of segments) {
    if (!seg?.available) continue;
    const segStart = finite(seg.start) ?? 0;
    const segEnd = finite(seg.end) ?? segStart;
    if (segEnd <= segStart) continue;
    const from = Math.max(lo, segStart);
    const to = Math.min(clippedEnd, segEnd);
    if (to > from) {
      out.push({
        fileStart: from,
        fileEnd: to,
        segmentIndex: seg.index,
        url: seg.url,
      });
    }
  }
  return out;
}

/** True when every byte in `[start, end)` is covered by available segments. */
export function isRangeAvailable(
  segments: readonly PlaybackStream["segments"][number][],
  start: number,
  end: number,
  maxSeekableBytes: number,
): boolean {
  const slices = mapByteRangeToSlices(segments, start, end, maxSeekableBytes);
  const lo = Math.max(0, finite(start) ?? 0);
  const hi = Math.min(finite(end) ?? lo, Math.max(0, finite(maxSeekableBytes) ?? 0));
  if (hi <= lo) return true;
  let cursor = lo;
  for (const slice of slices) {
    if (slice.fileStart > cursor) return false;
    cursor = Math.max(cursor, slice.fileEnd);
  }
  return cursor >= hi;
}

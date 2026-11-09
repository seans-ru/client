/**
 * Intro / credits auto-detection spike (issue #16) — pure algorithms over
 * `FrameSample`s from the frame tap (§S2.6). Research code for the go/no-go
 * decision in `docs/spikes/intro-detection.md`; not a shipping feature.
 *
 * Three pillars from the issue:
 *  (а) cross-episode repeatability: 64-bit dHash per sample + offset voting
 *      finds the clip that plays at a different position in every episode —
 *      the shared intro;
 *  (б) black frames / credit cards: luminance + sparse-bright ("text
 *      density") + low texture classify samples; a trailing run becomes the
 *      ending segment;
 *  (в) evaluation against ground truth in TheIntroDB's segment shape
 *      (`startMs`/`endMs`, nullable ends) — precision / recall / boundary
 *      error.
 */

import type { TheIntroDbSegment } from "../../theintrodb/types";
import type { FrameSample } from "./types";

/** 64-bit perceptual hash (dHash) split into two unsigned 32-bit halves. */
export type FrameHash = { hi: number; lo: number };

export type FrameFeatures = {
  /** Mean Rec.709 luminance, 0..1. */
  meanLuma: number;
  /** Mean absolute neighbor luminance gradient, 0..1 (texture/edge energy). */
  detail: number;
  /** Fraction of clearly bright pixels, 0..1 (text-stroke density proxy). */
  brightRatio: number;
};

export type FrameKind = "black" | "credits" | "content";

export type TimelineEntry = {
  tMs: number;
  hash: FrameHash;
  kind: FrameKind;
};

export type Timeline = TimelineEntry[];

export type TimelineRecord = {
  /** Episode identity (file url in the pilot). */
  id: string;
  timeline: Timeline;
};

export type DetectedSegment = {
  kind: "intro" | "credits";
  startMs: number;
  endMs: number;
  /** Episode identity the segment was detected in. */
  timelineId?: string;
};

export type RepeatMatch = {
  /** b.tMs − a.tMs for the winning alignment. */
  offsetMs: number;
  a: { startMs: number; endMs: number };
  b: { startMs: number; endMs: number };
  matched: number;
  /** matched / samples inside the a-span — how solid the run is. */
  coverage: number;
};

export type DetectOptions = {
  /** Max dHash bit distance to treat two samples as the same frame. */
  maxHamming?: number;
  /** Min intro length to accept. */
  minRunMs?: number;
  /** Offset histogram bucket. */
  offsetBucketMs?: number;
  /** Pairwise time tolerance when extending the aligned run. */
  offsetTolMs?: number;
  /** Allowed time gap between matched samples inside a run. */
  gapMs?: number;
  /** Min matched samples for a vote bucket to qualify. */
  minVotes?: number;
  /** Min matched fraction of the samples inside the run span. */
  minMatchRatio?: number;
  /** Ignore repeat votes landing in the tail of both timelines (credits). */
  tailFraction?: number;
};

const DEFAULTS = {
  maxHamming: 10,
  minRunMs: 10_000,
  offsetBucketMs: 500,
  offsetTolMs: 1_500,
  gapMs: 2_500,
  minVotes: 4,
  minMatchRatio: 0.5,
  // Shared end credits land at the same absolute time in every episode and
  // would win the offset vote; skip votes in the last quarter of both
  // timelines (typical intro sits in the first half of an episode).
  tailFraction: 0.25,
};

/** Bright-pixel threshold on 0..1 luminance (text strokes on dark cards). */
const BRIGHT_LUMA = 0.55;

function lumaAt(
  rgb: Uint8Array,
  width: number,
  x: number,
  y: number,
): number {
  const i = (y * width + x) * 3;
  return (0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]) / 255;
}

/**
 * 9×8 luminance dHash: adjacent-pixel comparisons along each row give 64
 * bits packed into two u32 halves. Stable under global brightness shifts —
 * that is what makes copies of the same intro match across episodes.
 */
export function frameHash(sample: FrameSample): FrameHash {
  const cols = 9;
  const rows = 8;
  const { width, height, rgb } = sample;
  if (width <= 0 || height <= 0 || rgb.length < width * height * 3) {
    return { hi: 0, lo: 0 };
  }
  let hi = 0;
  let lo = 0;
  let bit = 0;
  for (let y = 0; y < rows; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / rows));
    for (let x = 0; x < cols - 1; x++) {
      const sx1 = Math.min(width - 1, Math.floor((x * width) / cols));
      const sx2 = Math.min(width - 1, Math.floor(((x + 1) * width) / cols));
      const on = lumaAt(rgb, width, sx1, sy) > lumaAt(rgb, width, sx2, sy) ? 1 : 0;
      if (bit < 32) {
        hi = (hi << 1) | on;
      } else {
        lo = (lo << 1) | on;
      }
      bit++;
    }
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function popcount32(v: number): number {
  let x = v - ((v >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/** Bit distance between two frame hashes (0 = identical). */
export function hamming(a: FrameHash, b: FrameHash): number {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0);
}

export function hashToHex(hash: FrameHash): string {
  const hex = (v: number): string =>
    (v >>> 0).toString(16).padStart(8, "0");
  return hex(hash.hi) + hex(hash.lo);
}

/** Luminance / texture / bright-pixel features of one sample. */
export function frameFeatures(sample: FrameSample): FrameFeatures {
  const { width, height, rgb } = sample;
  const count = width * height;
  if (width <= 0 || height <= 0 || count <= 0 || rgb.length < count * 3) {
    return { meanLuma: 0, detail: 0, brightRatio: 0 };
  }
  let sum = 0;
  let bright = 0;
  let grad = 0;
  let gradCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = lumaAt(rgb, width, x, y);
      sum += l;
      if (l > BRIGHT_LUMA) bright++;
      if (x + 1 < width) {
        grad += Math.abs(l - lumaAt(rgb, width, x + 1, y));
        gradCount++;
      }
      if (y + 1 < height) {
        grad += Math.abs(l - lumaAt(rgb, width, x, y + 1));
        gradCount++;
      }
    }
  }
  return {
    meanLuma: sum / count,
    detail: gradCount > 0 ? grad / gradCount : 0,
    brightRatio: bright / count,
  };
}

/**
 * Frame classes for the ending heuristic (б):
 * - `black`   — near-zero luminance;
 * - `credits` — dark card with sparse bright strokes (text-like) and low
 *   texture;
 * - `content` — everything else.
 */
export function classifyFrame(features: FrameFeatures): FrameKind {
  if (features.meanLuma < 0.05) return "black";
  if (
    features.meanLuma < 0.45 &&
    features.brightRatio >= 0.01 &&
    features.brightRatio <= 0.45 &&
    features.detail < 0.12
  ) {
    return "credits";
  }
  return "content";
}

/** Build one timeline entry from a raw sample. */
export function probeAt(sample: FrameSample): TimelineEntry {
  return {
    tMs: Math.round(sample.pts * 1000),
    hash: frameHash(sample),
    kind: classifyFrame(frameFeatures(sample)),
  };
}

/**
 * (б) Trailing black / credit-card run of the episode. Content gaps up to
 * `gapMs` inside the run and trailing up to `gapMs` at the very end are
 * tolerated (fade-outs, vanity cards); a run must last `minRunMs`.
 */
export function detectCredits(
  timeline: Timeline,
  opts?: { minRunMs?: number; gapMs?: number },
): DetectedSegment | null {
  const minRunMs = opts?.minRunMs ?? 5_000;
  const gapMs = opts?.gapMs ?? 3_000;
  if (timeline.length === 0) return null;
  const timelineEndMs = timeline[timeline.length - 1].tMs;

  let lastSolidMs = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].kind !== "content") {
      lastSolidMs = timeline[i].tMs;
      break;
    }
  }
  if (lastSolidMs < 0) return null;
  // Credits must reach the episode tail (fade-out / vanity cards allowed).
  if (timelineEndMs - lastSolidMs > gapMs) return null;

  let startMs = lastSolidMs;
  let prevSolidMs = lastSolidMs;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry.kind === "content") continue;
    if (prevSolidMs - entry.tMs > gapMs) break;
    startMs = entry.tMs;
    prevSolidMs = entry.tMs;
  }
  if (lastSolidMs - startMs < minRunMs) return null;
  return { kind: "credits", startMs, endMs: lastSolidMs };
}

/**
 * (а) Best shared clip between two episode timelines: dHash matches vote
 * for a time-offset bucket, the winning bucket seeds an aligned run which
 * is then extended along both timelines. Votes landing in the tail of both
 * timelines are skipped — that region is usually shared end credits, which
 * `detectCredits` owns.
 */
export function findBestRepeat(
  a: Timeline,
  b: Timeline,
  opts?: DetectOptions,
): RepeatMatch | null {
  const maxHamming = opts?.maxHamming ?? DEFAULTS.maxHamming;
  const minRunMs = opts?.minRunMs ?? DEFAULTS.minRunMs;
  const bucketMs = opts?.offsetBucketMs ?? DEFAULTS.offsetBucketMs;
  const tolMs = opts?.offsetTolMs ?? DEFAULTS.offsetTolMs;
  const gapMs = opts?.gapMs ?? DEFAULTS.gapMs;
  const minVotes = opts?.minVotes ?? DEFAULTS.minVotes;
  const minMatchRatio = opts?.minMatchRatio ?? DEFAULTS.minMatchRatio;
  const tailFraction = opts?.tailFraction ?? DEFAULTS.tailFraction;
  if (a.length === 0 || b.length === 0) return null;

  const aEndMs = a[a.length - 1].tMs;
  const bEndMs = b[b.length - 1].tMs;
  const aTailMs = aEndMs * (1 - tailFraction);
  const bTailMs = bEndMs * (1 - tailFraction);

  // 1. Offset histogram from pairwise hash matches.
  const votes = new Map<number, number>();
  for (const ea of a) {
    const inTailA = ea.tMs >= aTailMs;
    for (const eb of b) {
      if (inTailA && eb.tMs >= bTailMs) continue; // shared credits tail
      if (hamming(ea.hash, eb.hash) > maxHamming) continue;
      const bucket = Math.round((eb.tMs - ea.tMs) / bucketMs);
      votes.set(bucket, (votes.get(bucket) ?? 0) + 1);
    }
  }
  let bestBucket = 0;
  let bestVotes = 0;
  for (const [bucket, count] of votes) {
    if (count > bestVotes || (count === bestVotes && bucket < bestBucket)) {
      bestVotes = count;
      bestBucket = bucket;
    }
  }
  if (bestVotes < minVotes) return null;

  // 2. Align every a-sample near the winning offset and collect matches.
  const offsetMs = bestBucket * bucketMs;
  const matchedA: number[] = []; // indices into a
  const matchedB: number[] = []; // aligned indices into b
  {
    let j = 0;
    for (let i = 0; i < a.length; i++) {
      const expected = a[i].tMs + offsetMs;
      while (j < b.length && b[j].tMs < expected - tolMs) j++;
      let bestJ = -1;
      let bestDist = tolMs + 1;
      for (let k = j; k < b.length && b[k].tMs <= expected + tolMs; k++) {
        const dist = Math.abs(b[k].tMs - expected);
        if (dist < bestDist && hamming(a[i].hash, b[k].hash) <= maxHamming) {
          bestDist = dist;
          bestJ = k;
        }
      }
      if (bestJ >= 0) {
        matchedA.push(i);
        matchedB.push(bestJ);
      }
    }
  }
  if (matchedA.length < minVotes) return null;

  // 3. Longest gap-tolerant run of aligned matches wins.
  let runStart = 0;
  let winFrom = -1;
  let winTo = -1;
  let bestSpan = -1;
  for (let m = 1; m <= matchedA.length; m++) {
    const breaks =
      m === matchedA.length ||
      a[matchedA[m]].tMs - a[matchedA[m - 1]].tMs > gapMs;
    if (!breaks) continue;
    const span = a[matchedA[m - 1]].tMs - a[matchedA[runStart]].tMs;
    if (span > bestSpan) {
      bestSpan = span;
      winFrom = runStart;
      winTo = m - 1;
    }
    runStart = m;
  }
  if (winFrom < 0 || winTo < winFrom) return null;

  const aStartMs = a[matchedA[winFrom]].tMs;
  const aEnd = a[matchedA[winTo]].tMs;
  const bStartMs = b[matchedB[winFrom]].tMs;
  const bEnd = b[matchedB[winTo]].tMs;
  if (aEnd - aStartMs < minRunMs) return null;

  const samplesInSpan = a.filter(
    (e) => e.tMs >= aStartMs && e.tMs <= aEnd,
  ).length;
  const matched = winTo - winFrom + 1;
  const coverage = samplesInSpan > 0 ? matched / samplesInSpan : 0;
  if (coverage < minMatchRatio) return null;

  return {
    offsetMs,
    a: { startMs: aStartMs, endMs: aEnd },
    b: { startMs: bStartMs, endMs: bEnd },
    matched,
    coverage,
  };
}

/**
 * (а) Intro clip shared by the season: `records[0]` is the reference episode,
 * every other episode must contain an overlapping shared run with it. The
 * returned segments are per episode (`timelineId`), reference span trimmed
 * to the intersection of all supports.
 */
export function detectCommonIntros(
  records: readonly TimelineRecord[],
  opts?: DetectOptions & { minEpisodes?: number },
): DetectedSegment[] {
  const minEpisodes = opts?.minEpisodes ?? 2;
  if (records.length < 2 || records.length < minEpisodes) return [];
  const ref = records[0];
  const supports: Array<{ record: TimelineRecord; match: RepeatMatch }> = [];
  for (let k = 1; k < records.length; k++) {
    const match = findBestRepeat(ref.timeline, records[k].timeline, opts);
    if (match) supports.push({ record: records[k], match });
  }
  if (supports.length + 1 < minEpisodes) return [];

  let startMs = supports[0].match.a.startMs;
  let endMs = supports[0].match.a.endMs;
  for (const s of supports) {
    startMs = Math.max(startMs, s.match.a.startMs);
    endMs = Math.min(endMs, s.match.a.endMs);
  }
  const minRunMs = opts?.minRunMs ?? DEFAULTS.minRunMs;
  if (endMs - startMs < minRunMs * 0.5) return [];

  const out: DetectedSegment[] = [
    { kind: "intro", startMs, endMs, timelineId: ref.id },
  ];
  for (const s of supports) {
    out.push({
      kind: "intro",
      startMs: s.match.b.startMs,
      endMs: s.match.b.endMs,
      timelineId: s.record.id,
    });
  }
  return out;
}

export type EvalResult = {
  predictedCount: number;
  truthCount: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
  /** Mean absolute start/end boundary error over matched pairs, ms. */
  meanAbsBoundaryErrMs: number | null;
};

function segmentLength(seg: { startMs: number; endMs: number }): number {
  return Math.max(0, seg.endMs - seg.startMs);
}

function iou(
  p: { startMs: number; endMs: number },
  t: { startMs: number; endMs: number },
): number {
  const inter =
    Math.min(p.endMs, t.endMs) - Math.max(p.startMs, t.startMs);
  if (inter <= 0) return 0;
  const union = segmentLength(p) + segmentLength(t) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * (в) Segment-level precision / recall against ground truth in TheIntroDB
 * shape. A prediction matches a truth segment when IoU ≥ `minIou` or both
 * boundaries land within `toleranceMs`. Matching is greedy 1-1 by best IoU.
 */
export function evaluateSegments(
  predicted: readonly { startMs: number; endMs: number }[],
  truth: readonly TheIntroDbSegment[],
  opts?: { toleranceMs?: number; episodeEndMs?: number; minIou?: number },
): EvalResult {
  const toleranceMs = opts?.toleranceMs ?? 3_000;
  const minIou = opts?.minIou ?? 0.5;
  const resolved = truth.map((seg) => ({
    startMs: seg.startMs ?? 0,
    endMs: seg.endMs ?? opts?.episodeEndMs ?? Number.MAX_SAFE_INTEGER,
  }));

  const usedTruth = new Set<number>();
  let matched = 0;
  let errSum = 0;
  for (const p of predicted) {
    let bestIdx = -1;
    let bestIou = 0;
    for (let t = 0; t < resolved.length; t++) {
      if (usedTruth.has(t)) continue;
      const score = iou(p, resolved[t]);
      const near =
        Math.abs(p.startMs - resolved[t].startMs) <= toleranceMs &&
        Math.abs(p.endMs - resolved[t].endMs) <= toleranceMs;
      if (score > bestIou || (near && bestIou === 0)) {
        bestIou = Math.max(score, near ? 1 : 0);
        bestIdx = t;
      }
    }
    if (bestIdx >= 0 && bestIou >= minIou) {
      usedTruth.add(bestIdx);
      matched++;
      errSum +=
        (Math.abs(p.startMs - resolved[bestIdx].startMs) +
          Math.abs(p.endMs - resolved[bestIdx].endMs)) /
        2;
    }
  }
  const precision = predicted.length > 0 ? matched / predicted.length : 1;
  const recall = resolved.length > 0 ? matched / resolved.length : 1;
  const f1 =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;
  return {
    predictedCount: predicted.length,
    truthCount: resolved.length,
    matched,
    precision,
    recall,
    f1,
    meanAbsBoundaryErrMs: matched > 0 ? errSum / matched : null,
  };
}

/**
 * (в) Compare detected intro/credits segments with a TheIntroDB bundle —
 * the same ground truth the app consumes from api.theintrodb.org.
 */
export function compareToTheIntroDb(
  predicted: readonly DetectedSegment[],
  truth: {
    intro: readonly TheIntroDbSegment[];
    credits: readonly TheIntroDbSegment[];
  },
  episodeEndMs: number,
): { intro: EvalResult; credits: EvalResult } {
  const byKind = (kind: DetectedSegment["kind"]): DetectedSegment[] =>
    predicted.filter((s) => s.kind === kind);
  return {
    intro: evaluateSegments(byKind("intro"), truth.intro, { episodeEndMs }),
    credits: evaluateSegments(byKind("credits"), truth.credits, {
      episodeEndMs,
    }),
  };
}

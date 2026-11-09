import { describe, expect, it } from "vitest";
import {
  classifyFrame,
  compareToTheIntroDb,
  detectCommonIntros,
  detectCredits,
  evaluateSegments,
  findBestRepeat,
  frameFeatures,
  frameHash,
  hashToHex,
  hamming,
  probeAt,
  type DetectedSegment,
  type Timeline,
  type TimelineRecord,
} from "../src/features/player/extensions/introDetectPolicy";
import {
  getPilotStatus,
  introDetectPilot,
  resetPilotSession,
  subscribePilot,
} from "../src/features/player/extensions/introDetectPilot";
import {
  createExtensionRuntime,
  type ExtensionRuntimeDeps,
} from "../src/features/player/extensions/registry";
import type {
  FrameSample,
  FrameSample as Sample,
} from "../src/features/player/extensions/types";
import { DEFAULT_SNAPSHOT } from "../src/features/player/playerTypes";

// ---------------------------------------------------------------- fixtures

function makeFrame(
  width: number,
  height: number,
  pts: number,
  pixel: (x: number, y: number) => [number, number, number],
): FrameSample {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return { width, height, pts, rgb };
}

/** Deterministic tiny xorshift for reproducible "content" noise. */
function xorshift(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Shared intro frame: stable texture + a bright bar that moves with the
 * intro-local frame index `k`. Same k -> same pixels in every episode, so
 * dHash matches cross-episode at the intro offset and nowhere else. The
 * texture also depends on k — without it the 16-step bar cycle would alias
 * frames k and k+16 and smear the offset histogram.
 */
function introFrame(k: number): FrameSample {
  const barRow = (k * 3) % 16;
  return makeFrame(16, 16, 0, (x, y) => {
    const cell = (x * 31 + y * 17 + k * 7) & 7;
    const onBar = y === barRow || y === ((barRow + 1) % 16);
    if (onBar) return [235, 225, 210];
    return [30 + cell * 24, 25 + ((cell * 37) % 160), 40 + cell * 18];
  });
}

/** Episode-unique noisy content (bright, high detail). */
function contentFrame(seed: number): FrameSample {
  const rnd = xorshift(seed);
  return makeFrame(16, 16, 0, () => [
    90 + Math.floor(rnd() * 150),
    70 + Math.floor(rnd() * 170),
    60 + Math.floor(rnd() * 180),
  ]);
}

/** End-credit card: dark background, sparse soft bright "text" dashes. */
function textCardFrame(k: number): FrameSample {
  return makeFrame(16, 16, 0, (x, y) => {
    const onTextRow = y === 4 || y === 8 || y === 12;
    const shift = (k * 2) % 5;
    const dash = onTextRow && (x + shift) % 5 < 3;
    return dash ? [165, 165, 165] : [13, 13, 15];
  });
}

function blackFrame(): FrameSample {
  return makeFrame(16, 16, 0, () => [0, 0, 0]);
}

type Shot = {
  startMs: number;
  endMs: number;
  frame: (localMs: number) => FrameSample;
};

/**
 * Episode body shot with a globally unique noise stream: seeds live in
 * `stream * 1_000_000 + slot`, so two bodies can never produce identical
 * frames (which would fabricate cross-episode "repeats").
 */
function bodyShot(stream: number, startMs: number, endMs: number): Shot {
  return {
    startMs,
    endMs,
    frame: (localMs) => contentFrame(stream * 1_000_000 + Math.floor(localMs / 500)),
  };
}

/** Sample every `stepMs`, build the timeline through the real `probeAt`. */
function timelineFromShots(shots: Shot[], stepMs = 500): Timeline {
  const endMs = Math.max(...shots.map((s) => s.endMs));
  const out: Timeline = [];
  for (let tMs = 0; tMs <= endMs; tMs += stepMs) {
    const shot = shots.find((s) => tMs >= s.startMs && tMs < s.endMs);
    if (!shot) continue;
    const frame = shot.frame(tMs - shot.startMs);
    out.push(probeAt({ ...frame, pts: tMs / 1000 }));
  }
  return out;
}

// ------------------------------------------------------- hash / features

describe("frameHash / hamming", () => {
  it("is deterministic and sensitive to content", () => {
    const a = introFrame(3);
    const b = introFrame(3);
    const c = introFrame(11);
    expect(hamming(frameHash(a), frameHash(b))).toBe(0);
    expect(hamming(frameHash(a), frameHash(c))).toBeGreaterThan(0);
  });

  it("tolerates small noise but separates unrelated frames", () => {
    const base = introFrame(5);
    const noisy = makeFrame(16, 16, 0, (x, y) => {
      const i = (y * 16 + x) * 3;
      return [
        Math.max(0, Math.min(255, base.rgb[i] + 2)),
        Math.max(0, Math.min(255, base.rgb[i + 1] - 1)),
        base.rgb[i + 2],
      ];
    });
    expect(hamming(frameHash(base), frameHash(noisy))).toBeLessThanOrEqual(4);
    expect(hamming(frameHash(base), frameHash(contentFrame(77)))).toBeGreaterThan(10);
  });

  it("hashToHex round-trips both halves", () => {
    const h = frameHash(introFrame(1));
    expect(hashToHex(h)).toHaveLength(16);
    expect(hashToHex(h)).toBe(hashToHex(frameHash(introFrame(1))));
  });
});

describe("frameFeatures / classifyFrame", () => {
  it("classifies black, credit cards and content", () => {
    expect(classifyFrame(frameFeatures(blackFrame()))).toBe("black");
    expect(classifyFrame(frameFeatures(textCardFrame(1)))).toBe("credits");
    expect(classifyFrame(frameFeatures(contentFrame(9)))).toBe("content");
    expect(classifyFrame(frameFeatures(introFrame(2)))).toBe("content");
  });

  it("reports low detail and sparse bright pixels for text cards", () => {
    const f = frameFeatures(textCardFrame(0));
    expect(f.meanLuma).toBeLessThan(0.45);
    expect(f.detail).toBeLessThan(0.12);
    expect(f.brightRatio).toBeGreaterThan(0.01);
    expect(f.brightRatio).toBeLessThan(0.45);
  });
});

// ---------------------------------------------------------------- (б) credits

describe("detectCredits", () => {
  const tail = (kind: "credits" | "black", count: number): Shot => ({
    startMs: 100_000,
    endMs: 100_000 + count * 500,
    frame: (localMs) =>
      kind === "black" || Math.floor(localMs / 500) % 3 === 2
        ? blackFrame()
        : textCardFrame(Math.floor(localMs / 500)),
  });

  it("finds a trailing text-card + black run", () => {
    const timeline = timelineFromShots([
      { startMs: 0, endMs: 100_000, frame: (m) => contentFrame(m) },
      tail("credits", 40),
    ]);
    const seg = detectCredits(timeline);
    expect(seg).not.toBeNull();
    expect(seg!.startMs).toBeGreaterThanOrEqual(98_000);
    expect(seg!.startMs).toBeLessThanOrEqual(101_000);
    expect(seg!.endMs).toBeGreaterThan(118_000);
    expect(seg!.kind).toBe("credits");
  });

  it("returns null when the episode ends with content", () => {
    const timeline = timelineFromShots([
      { startMs: 0, endMs: 120_000, frame: (m) => contentFrame(m) },
    ]);
    expect(detectCredits(timeline)).toBeNull();
  });

  it("returns null for a short black flash at the end", () => {
    const timeline = timelineFromShots([
      { startMs: 0, endMs: 118_000, frame: (m) => contentFrame(m) },
      { startMs: 118_000, endMs: 120_000, frame: () => blackFrame() },
    ]);
    expect(detectCredits(timeline)).toBeNull();
  });

  it("ignores mid-episode black flashes", () => {
    const timeline = timelineFromShots([
      { startMs: 0, endMs: 60_000, frame: (m) => contentFrame(m) },
      { startMs: 60_000, endMs: 62_000, frame: () => blackFrame() },
      { startMs: 62_000, endMs: 100_000, frame: (m) => contentFrame(m + 1) },
      tail("credits", 40),
    ]);
    const seg = detectCredits(timeline);
    expect(seg!.startMs).toBeGreaterThan(90_000);
  });

  it("bridges short content gaps inside the ending run", () => {
    const timeline = timelineFromShots([
      { startMs: 0, endMs: 95_000, frame: (m) => contentFrame(m) },
      {
        startMs: 95_000,
        endMs: 120_000,
        frame: (localMs) => {
          const slot = Math.floor(localMs / 500);
          // 1 s of content every 6 s — under the 3 s gap tolerance.
          return slot % 12 >= 10
            ? contentFrame(slot)
            : slot % 3 === 2
              ? blackFrame()
              : textCardFrame(slot);
        },
      },
    ]);
    const seg = detectCredits(timeline);
    expect(seg).not.toBeNull();
    expect(seg!.startMs).toBeLessThan(97_000);
  });
});

// ------------------------------------------------------------- (а) intro

describe("findBestRepeat", () => {
  const introShot = (startMs: number): Shot => ({
    startMs,
    endMs: startMs + 20_000,
    frame: (localMs) => introFrame(Math.floor(localMs / 500)),
  });

  it("recovers the shared intro offset between two episodes", () => {
    const a = timelineFromShots([
      bodyShot(1, 0, 10_000),
      introShot(10_000),
      bodyShot(2, 30_000, 120_000),
    ]);
    const b = timelineFromShots([
      bodyShot(3, 0, 5_000),
      introShot(5_000),
      bodyShot(4, 25_000, 120_000),
    ]);
    const match = findBestRepeat(a, b);
    expect(match).not.toBeNull();
    expect(match!.offsetMs).toBe(-5_000);
    expect(match!.a.startMs).toBeGreaterThanOrEqual(9_500);
    expect(match!.a.startMs).toBeLessThanOrEqual(10_500);
    expect(match!.a.endMs).toBeGreaterThanOrEqual(29_000);
    expect(match!.coverage).toBeGreaterThan(0.9);
  });

  it("returns null for episodes without a shared clip", () => {
    const a = timelineFromShots([bodyShot(5, 0, 120_000)]);
    const b = timelineFromShots([bodyShot(6, 0, 120_000)]);
    expect(findBestRepeat(a, b)).toBeNull();
  });

  it("does not lock onto the shared end credits", () => {
    const noIntro = (stream: number, creditsStart: number): Shot[] => [
      bodyShot(stream, 0, creditsStart),
      {
        startMs: creditsStart,
        endMs: creditsStart + 20_000,
        frame: (m) =>
          Math.floor(m / 500) % 3 === 2
            ? blackFrame()
            : textCardFrame(Math.floor(m / 500)),
      },
    ];
    const a = timelineFromShots(noIntro(7, 100_000));
    const b = timelineFromShots(noIntro(8, 100_000));
    const match = findBestRepeat(a, b);
    // Either no match at all, or (if hash noise sneaks through) nothing
    // that looks like a 10 s+ intro.
    if (match) {
      expect(match.a.endMs - match.a.startMs).toBeLessThan(10_000);
    }
  });
});

describe("detectCommonIntros", () => {
  it("returns one intro segment per episode", () => {
    const records: TimelineRecord[] = [
      {
        id: "ep1",
        timeline: timelineFromShots([
          bodyShot(11, 0, 8_000),
          {
            startMs: 8_000,
            endMs: 28_000,
            frame: (m) => introFrame(Math.floor(m / 500)),
          },
          bodyShot(12, 28_000, 120_000),
        ]),
      },
      {
        id: "ep2",
        timeline: timelineFromShots([
          bodyShot(13, 0, 5_000),
          {
            startMs: 5_000,
            endMs: 25_000,
            frame: (m) => introFrame(Math.floor(m / 500)),
          },
          bodyShot(14, 25_000, 120_000),
        ]),
      },
    ];
    const segments = detectCommonIntros(records);
    expect(segments).toHaveLength(2);
    for (const seg of segments) expect(seg.kind).toBe("intro");
    expect(segments.map((s) => s.timelineId).sort()).toEqual(["ep1", "ep2"]);
    const ep1 = segments.find((s) => s.timelineId === "ep1")!;
    const ep2 = segments.find((s) => s.timelineId === "ep2")!;
    expect(ep1.startMs).toBeGreaterThanOrEqual(7_500);
    expect(ep1.endMs).toBeLessThanOrEqual(28_500);
    expect(ep2.endMs - ep2.startMs).toBeGreaterThan(15_000);
  });

  it("needs at least two episodes", () => {
    const records: TimelineRecord[] = [
      { id: "ep1", timeline: timelineFromShots([bodyShot(15, 0, 60_000)]) },
    ];
    expect(detectCommonIntros(records)).toEqual([]);
  });
});

// ------------------------------------------------- (в) evaluation harness

describe("evaluateSegments / compareToTheIntroDb", () => {
  it("scores exact matches as precision=recall=1", () => {
    const result = evaluateSegments(
      [{ startMs: 1_000, endMs: 20_000 }],
      [{ startMs: 1_000, endMs: 20_000 }],
    );
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(1);
    expect(result.meanAbsBoundaryErrMs).toBe(0);
  });

  it("resolves null truth ends against episodeEndMs", () => {
    const result = evaluateSegments(
      [{ startMs: 90_000, endMs: 119_500 }],
      [{ startMs: 90_000, endMs: null }],
      { episodeEndMs: 120_000 },
    );
    expect(result.matched).toBe(1);
    expect(result.meanAbsBoundaryErrMs).toBeLessThan(3_000);
  });

  it("counts misses and false positives", () => {
    const result = evaluateSegments(
      [
        { startMs: 0, endMs: 10_000 },
        { startMs: 50_000, endMs: 60_000 },
      ],
      [{ startMs: 0, endMs: 10_500 }],
    );
    expect(result.precision).toBe(0.5);
    expect(result.recall).toBe(1);
  });

  it("compareToTheIntroDb splits intro and credits", () => {
    const predicted: DetectedSegment[] = [
      { kind: "intro", startMs: 8_000, endMs: 28_000 },
      { kind: "credits", startMs: 105_000, endMs: 119_500 },
    ];
    const scores = compareToTheIntroDb(
      predicted,
      {
        intro: [{ startMs: 8_000, endMs: 28_000 }],
        credits: [{ startMs: 105_000, endMs: null }],
      },
      120_000,
    );
    expect(scores.intro.precision).toBe(1);
    expect(scores.credits.recall).toBe(1);
  });
});

// --------------------------------------- synthetic season spike evaluation

/**
 * Synthetic season (the spike's stand-in for real episodes — no series are
 * available in the dev environment): three ~2 min episodes with a 20 s
 * shared intro at different offsets, a recap before the intro of ep2, black
 * flashes mid-episode and text-card + black endings. Frames are generated as
 * real 16x16 RGB samples and pushed through `probeAt`, so hashing and
 * classification run exactly as they do in the pilot.
 */
type SeasonEpisode = {
  id: string;
  timeline: Timeline;
  truth: { intro: TheIntroDbLike; credits: TheIntroDbLike };
};

type TheIntroDbLike = { startMs: number | null; endMs: number | null };

function buildSeason(): SeasonEpisode[] {
  const introLen = 20_000;
  const creditsStart = 105_000;
  const episodeEnd = 120_000;

  const intro = (startMs: number): Shot => ({
    startMs,
    endMs: startMs + introLen,
    frame: (localMs) => introFrame(Math.floor(localMs / 500)),
  });
  const credits = (startMs: number): Shot => ({
    startMs,
    endMs: episodeEnd,
    frame: (localMs) => {
      const slot = Math.floor(localMs / 500);
      return slot % 3 === 2 ? blackFrame() : textCardFrame(slot);
    },
  });
  const flash = (startMs: number): Shot => ({
    startMs,
    endMs: startMs + 1_500,
    frame: () => blackFrame(),
  });

  return [
    {
      id: "s1e1",
      timeline: timelineFromShots([
        bodyShot(1, 0, 8_000), // cold open
        intro(8_000),
        bodyShot(2, 28_000, creditsStart),
        credits(creditsStart),
      ]),
      truth: {
        intro: { startMs: 8_000, endMs: 8_000 + introLen },
        credits: { startMs: creditsStart, endMs: null },
      },
    },
    {
      id: "s1e2",
      timeline: timelineFromShots([
        bodyShot(3, 0, 5_000), // recap before intro
        intro(5_000),
        bodyShot(4, 25_000, 60_000),
        flash(60_000),
        bodyShot(5, 61_500, creditsStart),
        credits(creditsStart),
      ]),
      truth: {
        intro: { startMs: 5_000, endMs: 5_000 + introLen },
        credits: { startMs: creditsStart, endMs: null },
      },
    },
    {
      id: "s1e3",
      timeline: timelineFromShots([
        bodyShot(6, 0, 12_000), // longer cold open
        intro(12_000),
        bodyShot(7, 32_000, 70_000),
        flash(70_000),
        bodyShot(8, 71_500, creditsStart),
        credits(creditsStart),
      ]),
      truth: {
        intro: { startMs: 12_000, endMs: 12_000 + introLen },
        credits: { startMs: creditsStart, endMs: null },
      },
    },
  ];
}

type EpisodeScore = {
  id: string;
  intro: ReturnType<typeof evaluateSegments>;
  credits: ReturnType<typeof evaluateSegments>;
};

function scoreSeason(episodes: SeasonEpisode[]): EpisodeScore[] {
  const records: TimelineRecord[] = episodes.map((e) => ({
    id: e.id,
    timeline: e.timeline,
  }));
  const intros = detectCommonIntros(records);
  return episodes.map((episode) => {
    const predicted: DetectedSegment[] = intros.filter(
      (s) => s.timelineId === episode.id,
    );
    const credits = detectCredits(episode.timeline);
    if (credits) predicted.push({ ...credits, timelineId: episode.id });
    const scores = compareToTheIntroDb(
      predicted,
      { intro: [episode.truth.intro], credits: [episode.truth.credits] },
      120_000,
    );
    return { id: episode.id, ...scores };
  });
}

function microAverage(scores: EpisodeScore[], kind: "intro" | "credits") {
  let predicted = 0;
  let truth = 0;
  let matched = 0;
  let errSum = 0;
  let errCount = 0;
  for (const s of scores) {
    const r = s[kind];
    predicted += r.predictedCount;
    truth += r.truthCount;
    matched += r.matched;
    if (r.meanAbsBoundaryErrMs !== null) {
      errSum += r.meanAbsBoundaryErrMs * r.matched;
      errCount += r.matched;
    }
  }
  const precision = predicted > 0 ? matched / predicted : 1;
  const recall = truth > 0 ? matched / truth : 1;
  return {
    precision,
    recall,
    f1:
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0,
    meanAbsBoundaryErrMs: errCount > 0 ? errSum / errCount : null,
    matched,
    predicted,
    truth,
  };
}

describe("spike evaluation on a synthetic season", () => {
  const episodes = buildSeason();
  const scores = scoreSeason(episodes);
  const introAvg = microAverage(scores, "intro");
  const creditsAvg = microAverage(scores, "credits");

  it("prints the metrics table for docs/spikes/intro-detection.md", () => {
    // eslint-disable-next-line no-console
    console.log(
      "[intro-detect.spike]",
      JSON.stringify(
        {
          perEpisode: scores.map((s) => ({
            id: s.id,
            intro: {
              p: +s.intro.precision.toFixed(3),
              r: +s.intro.recall.toFixed(3),
              errMs: s.intro.meanAbsBoundaryErrMs,
            },
            credits: {
              p: +s.credits.precision.toFixed(3),
              r: +s.credits.recall.toFixed(3),
              errMs: s.credits.meanAbsBoundaryErrMs,
            },
          })),
          micro: {
            intro: {
              p: +introAvg.precision.toFixed(3),
              r: +introAvg.recall.toFixed(3),
              f1: +introAvg.f1.toFixed(3),
              errMs: introAvg.meanAbsBoundaryErrMs,
            },
            credits: {
              p: +creditsAvg.precision.toFixed(3),
              r: +creditsAvg.recall.toFixed(3),
              f1: +creditsAvg.f1.toFixed(3),
              errMs: creditsAvg.meanAbsBoundaryErrMs,
            },
          },
        },
        null,
        2,
      ),
    );
    expect(scores).toHaveLength(3);
  });

  it("intro detection: precision and recall ≥ 0.9, boundary error ≤ 3 s", () => {
    expect(introAvg.precision).toBeGreaterThanOrEqual(0.9);
    expect(introAvg.recall).toBeGreaterThanOrEqual(0.9);
    expect(introAvg.meanAbsBoundaryErrMs ?? 0).toBeLessThanOrEqual(3_000);
  });

  it("credits detection: precision and recall ≥ 0.9, boundary error ≤ 3 s", () => {
    expect(creditsAvg.precision).toBeGreaterThanOrEqual(0.9);
    expect(creditsAvg.recall).toBeGreaterThanOrEqual(0.9);
    expect(creditsAvg.meanAbsBoundaryErrMs ?? 0).toBeLessThanOrEqual(3_000);
  });

  it("recap before the intro does not shift the intro start", () => {
    const ep2 = episodes.find((e) => e.id === "s1e2")!;
    const records: TimelineRecord[] = episodes.map((e) => ({
      id: e.id,
      timeline: e.timeline,
    }));
    const seg = detectCommonIntros(records).find(
      (s) => s.timelineId === "s1e2",
    )!;
    // True intro starts at 5 000 ms; the 5 s recap before it must not be
    // absorbed (typical error class from the issue).
    expect(seg.startMs).toBeGreaterThanOrEqual(4_000);
    expect(seg.startMs).toBeLessThanOrEqual(6_500);
    expect(ep2.truth.intro.startMs).toBe(5_000);
  });
});

// -------------------------------------------------------- pilot extension

describe("introDetectPilot extension", () => {
  function makeHost(seedEnabled: boolean) {
    const snapshot = { ...DEFAULT_SNAPSHOT };
    const store = new Map<string, unknown>([["enabled", seedEnabled]]);
    let frameCb: ((s: Sample) => void) | null = null;
    const deps: ExtensionRuntimeDeps = {
      transport: {
        play: async () => {},
        pause: async () => {},
        togglePause: async () => {},
        seek: async () => {},
        setSpeed: async () => {},
        setVolume: async () => {},
        setMute: async () => {},
        setFullscreen: async () => {},
      },
      getSnapshot: () => snapshot,
      mpv: {
        getProperty: async () => "",
        setProperty: async () => {},
        command: async () => null,
      },
      frames: {
        subscribe: (cb) => {
          frameCb = cb;
          return () => {
            frameCb = null;
          };
        },
      },
      storageFor: () => ({
        get: <T,>(key: string, fallback: T): T =>
          (store.has(key) ? (store.get(key) as T) : fallback),
        set: (key, value) => {
          store.set(key, value);
        },
      }),
      setChromeHidden: () => {},
    };
    const runtime = createExtensionRuntime([introDetectPilot], deps);
    return {
      runtime,
      feed(ptsSec: number, frame: FrameSample) {
        frameCb?.({ ...frame, pts: ptsSec });
      },
    };
  }

  it("collects timelines across episodes and reports intro + credits", () => {
    resetPilotSession();
    const host = makeHost(true);
    const notify = (() => {
      let fired = 0;
      subscribePilot(() => {
        fired++;
      });
      return () => fired;
    })();

    const play = (id: string, shots: Shot[]) => {
      host.runtime.notifyOpen({ url: id, startAt: null, source: "vod" });
      const timeline = timelineFromShots(shots);
      for (const entry of timeline) {
        // Replay generated frames through the pipeline at their pts.
        const tMs = entry.tMs;
        const shot = shots.find((s) => tMs >= s.startMs && tMs < s.endMs)!;
        host.feed(tMs / 1000, shot.frame(tMs - shot.startMs));
      }
      host.runtime.notifyClose();
    };

    const intro = (startMs: number): Shot => ({
      startMs,
      endMs: startMs + 20_000,
      frame: (localMs) => introFrame(Math.floor(localMs / 500)),
    });
    const credits = (startMs: number): Shot => ({
      startMs,
      endMs: 120_000,
      frame: (localMs) => {
        const slot = Math.floor(localMs / 500);
        return slot % 3 === 2 ? blackFrame() : textCardFrame(slot);
      },
    });

    play("ep1", [
      bodyShot(21, 0, 8_000),
      intro(8_000),
      bodyShot(22, 28_000, 105_000),
      credits(105_000),
    ]);
    play("ep2", [
      bodyShot(23, 0, 5_000),
      intro(5_000),
      bodyShot(24, 25_000, 105_000),
      credits(105_000),
    ]);

    const status = getPilotStatus();
    expect(status.episodeCount).toBeGreaterThanOrEqual(2);
    expect(status.intro).not.toBeNull();
    expect(status.intro!.kind).toBe("intro");
    expect(status.credits).not.toBeNull();
    expect(status.credits!.kind).toBe("credits");
    expect(notify()).toBeGreaterThan(0);
    host.runtime.dispose();
    resetPilotSession();
  });

  it("stays idle when the pilot toggle is off", () => {
    resetPilotSession();
    const host = makeHost(false);
    host.runtime.notifyOpen({ url: "ep1", startAt: null, source: "vod" });
    host.feed(0, introFrame(0));
    expect(getPilotStatus().sampleCount).toBe(0);
    host.runtime.dispose();
    resetPilotSession();
  });
});

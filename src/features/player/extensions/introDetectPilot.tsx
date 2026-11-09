/**
 * Intro / credits auto-detection pilot (issue #16 spike).
 *
 * Research vehicle for the go/no-go in `docs/spikes/intro-detection.md`:
 * while a file plays, the frame tap (≤32×32 samples at ~2 fps) is reduced to
 * a per-episode timeline of perceptual hashes + frame kinds (see
 * `introDetectPolicy.ts`). Timelines of the last episodes of the session are
 * then compared: a clip that repeats at a different offset in every episode
 * is the shared intro; a trailing black / credit-card run is the ending.
 *
 * The pilot is registered but OFF by default — enable it in the player
 * settings menu («Авто-детект интро»), watch a couple of episodes of one
 * season and read the detected segments in the same row (a JSON report also
 * goes to the devtools console). No transport/UI behavior is changed and
 * detection runs outside the render path.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import {
  detectCommonIntros,
  detectCredits,
  probeAt,
  type DetectedSegment,
  type Timeline,
  type TimelineRecord,
} from "./introDetectPolicy";
import type {
  FrameSample,
  PlayerExtension,
  Unsubscribe,
} from "./types";

const ENABLED_KEY = "enabled";

/** Sampling cap for the analysis timeline (~2 fps is plenty for hashing). */
const PROBE_MAX_FPS = 2;

/** Max samples kept per episode (~2 h at 2 fps). */
const MAX_PROBE_COUNT = 12_000;

/** How many previous episode timelines participate in the comparison. */
const MAX_EPISODES = 6;

/** Recompute the detection report every N new samples. */
const REPORT_EVERY = 30;

type SessionData = {
  currentUrl: string | null;
  current: Timeline;
  previous: TimelineRecord[];
  report: DetectedSegment[];
  creditsByEpisode: Map<string, DetectedSegment>;
};

/**
 * Session-scoped store (module singleton — the player session is a
 * singleton too). Timelines live in memory only: a spike does not need
 * cross-restart persistence, and full timelines are too large for
 * localStorage.
 */
function createSession(): SessionData {
  return {
    currentUrl: null,
    current: [],
    previous: [],
    report: [],
    creditsByEpisode: new Map(),
  };
}

const listeners = new Set<() => void>();
let session = createSession();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export type PilotStatus = {
  episodeCount: number;
  sampleCount: number;
  intro: DetectedSegment | null;
  credits: DetectedSegment | null;
};

export function getPilotStatus(): PilotStatus {
  const intro =
    session.report.find((s) => s.kind === "intro") ?? null;
  const credits =
    session.currentUrl !== null
      ? (session.creditsByEpisode.get(session.currentUrl) ?? null)
      : null;
  return {
    episodeCount: session.previous.length + (session.current.length > 0 ? 1 : 0),
    sampleCount: session.current.length,
    intro,
    credits,
  };
}

export function subscribePilot(cb: () => void): Unsubscribe {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test hook: wipe the session timelines and report. */
export function resetPilotSession(): void {
  session = createSession();
  notify();
}

function recompute(logReport = false): void {
  const records: TimelineRecord[] = [];
  if (session.currentUrl !== null && session.current.length > 0) {
    records.push({ id: session.currentUrl, timeline: session.current });
  }
  for (const rec of session.previous.slice(-MAX_EPISODES)) {
    records.push(rec);
  }

  session.creditsByEpisode.clear();
  for (const rec of records) {
    const credits = detectCredits(rec.timeline);
    if (credits) session.creditsByEpisode.set(rec.id, credits);
  }
  session.report = detectCommonIntros(records);

  if (logReport) {
    // JSON dump at episode close: copy/paste from the devtools console when
    // validating on real series — the raw data behind the spike metrics.
    console.info(
      "[intro.pilot]",
      JSON.stringify({
        episodes: records.map((r) => ({ id: r.id, samples: r.timeline.length })),
        intro: session.report,
        credits: [...session.creditsByEpisode.values()],
      }),
    );
  }
  notify();
}

function formatMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function formatSegment(seg: DetectedSegment | null): string {
  if (!seg) return "—";
  return `${formatMs(seg.startMs)}–${formatMs(seg.endMs)}`;
}

/** Tiny observable boolean (persisted) for the settings row. */
function createToggleStore(get: () => boolean, set: (v: boolean) => void) {
  const toggleListeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      toggleListeners.add(listener);
      return () => {
        toggleListeners.delete(listener);
      };
    },
    get,
    set(next: boolean): void {
      set(next);
      for (const listener of [...toggleListeners]) listener();
    },
  };
}

type ToggleStore = ReturnType<typeof createToggleStore>;

function PilotRow({
  toggle,
}: {
  toggle: ToggleStore;
}): ReactElement {
  const enabled = useSyncExternalStore(toggle.subscribe, toggle.get);
  const status = useSyncExternalStore(subscribePilot, getPilotStatus);
  return (
    <section>
      <h4 className="player-menu-title">Авто-детект интро (пилот)</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={enabled}
          className={`player-menu-item${enabled ? " player-menu-item-active" : ""}`}
          onClick={() => toggle.set(!enabled)}
        >
          {enabled ? "Пилот включён" : "Пилот выключен"}
        </button>
      </div>
      <p className="player-menu-title" style={{ textTransform: "none" }}>
        {`Эпизодов: ${status.episodeCount} · сэмплов: ${status.sampleCount}`}
        <br />
        {`Интро: ${formatSegment(status.intro)}`}
        <br />
        {`Титры: ${formatSegment(status.credits)}`}
      </p>
    </section>
  );
}

export const introDetectPilot: PlayerExtension = {
  id: "intro-detect-pilot",
  name: "Авто-детект интро (пилот #16)",
  setup(ctx): Unsubscribe {
    const toggle = createToggleStore(
      () => Boolean(ctx.storage.get(ENABLED_KEY, false)),
      (value) => ctx.storage.set(ENABLED_KEY, value),
    );
    let enabled = toggle.get();
    let stopFrames: Unsubscribe | null = null;
    let sinceReport = 0;

    const onSample = (sample: FrameSample): void => {
      if (session.current.length >= MAX_PROBE_COUNT) return;
      session.current.push(probeAt(sample));
      sinceReport++;
      if (sinceReport >= REPORT_EVERY) {
        sinceReport = 0;
        recompute();
      }
    };

    const start = (): void => {
      if (!enabled || stopFrames !== null) return;
      stopFrames = ctx.frames.subscribe(onSample, { maxFps: PROBE_MAX_FPS });
    };

    const stop = (): void => {
      if (stopFrames === null) return;
      stopFrames();
      stopFrames = null;
    };

    const stopOpen = ctx.onOpen((info) => {
      // A new file starts a new timeline; the finished one joins the
      // cross-episode comparison pool.
      if (session.currentUrl !== null && session.current.length > 0) {
        session.previous.push({
          id: session.currentUrl,
          timeline: session.current,
        });
        if (session.previous.length > MAX_EPISODES) session.previous.shift();
      }
      session.currentUrl = info.url;
      session.current = [];
      sinceReport = 0;
      if (enabled) recompute();
    });

    const stopClose = ctx.onClose(() => {
      recompute(true);
    });

    const stopToggle = toggle.subscribe(() => {
      enabled = toggle.get();
      if (enabled) {
        start();
      } else {
        stop();
      }
      notify();
    });

    const stopRow = ctx.ui.add("settings.menu", () => (
      <PilotRow toggle={toggle} />
    ));

    start();

    return () => {
      stopRow();
      stopToggle();
      stopClose();
      stopOpen();
      stop();
    };
  },
};

/**
 * «Лучшие моменты» after the movie (phase 3, docs/compose/spec/clips-cloud.md).
 *
 * When the movie hits EOF the extension marks it watched and offers a
 * countdown card (same UX idea as an autopilot next-up card — the player has
 * none today). «Смотреть» plays this media's CLOUD CLIPS back to back,
 * ordered by the clip start timecode (a finale clip never plays before an
 * intro one), skipping spoiler clips from viewers who have not finished the
 * media. Screenshots never take part. Clips prefer their local file while it
 * exists, otherwise the cloud `file_url`.
 *
 * Playback runs through `ctx.mpv.command(["loadfile", src, "replace"])` — the
 * generic command bridge, no player-core changes.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type { PlayerSnapshot } from "../playerTypes";
import type { MpvBridge, PlayerExtension, Unsubscribe } from "./types";
import {
  bestMomentsCountdownLabel,
  CAPTURE_COPY,
  formatClipDuration,
} from "./captureHelpers";
import { createClipsNative } from "./captureNative";
import type { ClipsNative } from "../../clips/api";
import {
  createCloudRegistry,
  selectBestMoments,
  markMediaWatched,
  type CloudRegistry,
  type LocalCloudAsset,
} from "../../clips";
import { getActiveMediaId } from "../../clips/activeMedia";

/** Countdown before the reel starts (the card also starts instantly). */
export const BEST_MOMENTS_COUNTDOWN_SEC = 10;

export type BestMomentsPhase = "idle" | "countdown" | "playing" | "finished";

export type BestMomentsState = {
  phase: BestMomentsPhase;
  secondsLeft: number;
  index: number;
  assets: LocalCloudAsset[];
  /** Non-fatal note (e.g. «нет локального файла» per clip). */
  note: string | null;
};

export type BestMomentsStore = {
  subscribe(cb: () => void): Unsubscribe;
  get(): BestMomentsState;
  set(next: Partial<BestMomentsState>): void;
};

export function createBestMomentsStore(): BestMomentsStore {
  let state: BestMomentsState = {
    phase: "idle",
    secondsLeft: 0,
    index: 0,
    assets: [],
    note: null,
  };
  const listeners = new Set<() => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => state,
    set(next) {
      state = { ...state, ...next };
      for (const listener of [...listeners]) listener();
    },
  };
}

export type BestMomentsDeps = {
  mpv: MpvBridge;
  registry: CloudRegistry;
  native: ClipsNative;
  getSnapshot: () => PlayerSnapshot;
};

export type BestMomentsController = {
  store: BestMomentsStore;
  /** EOF edge: mark watched, gather clips, show the countdown card. */
  onEof(): void;
  /** Snapshot tick: nothing to do yet — kept for symmetry with capture. */
  onTick(snapshot: PlayerSnapshot): void;
  start(): Promise<void>;
  skip(): Promise<void>;
  exit(): void;
  /** One countdown second (driven by the extension's interval). */
  tickCountdown(): void;
  dispose(): void;
};

/** `loadfile <src> replace` through the generic mpv command bridge. */
export function loadFileArgs(source: string): string[] {
  return ["loadfile", source, "replace"];
}

export function createBestMomentsController(
  deps: BestMomentsDeps,
): BestMomentsController {
  const store = createBestMomentsStore();
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const stopCountdown = (): void => {
    if (countdownTimer != null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  const playIndex = async (index: number): Promise<void> => {
    if (disposed) return;
    const { assets } = store.get();
    if (index >= assets.length) {
      store.set({ phase: "finished", note: null });
      return;
    }
    const asset = assets[index];
    store.set({ phase: "playing", index, note: null });
    // Local file while it is still on disk; otherwise the cloud copy. No
    // source at all → the entry is skipped («нет доступного файла»).
    const localExists =
      asset.localPath != null &&
      (await deps.native.fileExists(asset.localPath).catch(() => false));
    const source = localExists ? asset.localPath : asset.fileUrl;
    if (!source) {
      store.set({ note: "нет доступного файла клипа" });
      // Skip broken entries without stalling the reel.
      await playIndex(index + 1);
      return;
    }
    void deps.mpv.command(loadFileArgs(source)).catch(() => {
      store.set({ note: "mpv не смог открыть клип" });
    });
  };

  const start = async (): Promise<void> => {
    if (disposed) return;
    stopCountdown();
    await playIndex(0);
  };

  return {
    store,
    onEof() {
      if (disposed) return;
      const { phase } = store.get();
      if (phase !== "idle") return;
      const mediaId = getActiveMediaId() ?? "";
      // The viewer just finished the media — spoilers open up for them.
      if (mediaId) markMediaWatched(mediaId);
      const assets = selectBestMoments(deps.registry.list(), {
        mediaId,
        watched: true,
      });
      if (assets.length === 0) return;
      store.set({
        phase: "countdown",
        secondsLeft: BEST_MOMENTS_COUNTDOWN_SEC,
        index: 0,
        assets,
        note: null,
      });
      stopCountdown();
      countdownTimer = setInterval(() => {
        if (disposed) return;
        const s = store.get();
        if (s.phase !== "countdown") {
          stopCountdown();
          return;
        }
        if (s.secondsLeft <= 1) {
          stopCountdown();
          void start();
        } else {
          store.set({ secondsLeft: s.secondsLeft - 1 });
        }
      }, 1000);
    },
    onTick(snapshot) {
      if (disposed) return;
      const s = store.get();
      if (s.phase !== "playing" || !snapshot.eof) return;
      // Current clip ended — advance the reel.
      void playIndex(s.index + 1);
    },
    start,
    async skip() {
      if (disposed) return;
      const s = store.get();
      if (s.phase !== "playing") return;
      await playIndex(s.index + 1);
    },
    exit() {
      stopCountdown();
      store.set({ phase: "idle", secondsLeft: 0, index: 0, note: null });
    },
    tickCountdown() {
      const s = store.get();
      if (s.phase !== "countdown") return;
      if (s.secondsLeft <= 1) {
        stopCountdown();
        void start();
      } else {
        store.set({ secondsLeft: s.secondsLeft - 1 });
      }
    },
    dispose() {
      disposed = true;
      stopCountdown();
    },
  };
}

/* -------------------------------------------------------------------- UI */

function BestMomentsCard({
  controller,
}: {
  controller: BestMomentsController;
}): ReactElement | null {
  const state = useSyncExternalStore(
    controller.store.subscribe,
    controller.store.get,
  );
  if (state.phase === "idle") return null;
  const current = state.assets[state.index];
  const clipRange =
    current && current.startSec != null && current.endSec != null
      ? `${formatClipDuration(current.endSec - current.startSec)}`
      : "";
  return (
    <div className="player-toast player-capture-toast" role="status">
      {state.phase === "countdown" ? (
        <>
          <span>{bestMomentsCountdownLabel(state.secondsLeft)}</span>
          <button
            type="button"
            className="player-capture-action"
            onClick={() => void controller.start()}
          >
            {CAPTURE_COPY.bestMomentsStart}
          </button>
          <button
            type="button"
            className="player-capture-action"
            onClick={controller.exit}
          >
            {CAPTURE_COPY.bestMomentsExit}
          </button>
        </>
      ) : null}
      {state.phase === "playing" ? (
        <>
          <span>
            {CAPTURE_COPY.bestMoments} {state.index + 1}/{state.assets.length}
            {clipRange ? ` · ${clipRange}` : ""}
            {state.note ? ` · ${state.note}` : ""}
          </span>
          <button
            type="button"
            className="player-capture-action"
            onClick={() => void controller.skip()}
          >
            {CAPTURE_COPY.bestMomentsSkip}
          </button>
          <button
            type="button"
            className="player-capture-action"
            onClick={controller.exit}
          >
            {CAPTURE_COPY.bestMomentsExit}
          </button>
        </>
      ) : null}
      {state.phase === "finished" ? (
        <>
          <span>{CAPTURE_COPY.bestMoments} — {CAPTURE_COPY.bestMomentsEmpty}</span>
          <button
            type="button"
            className="player-capture-action"
            onClick={controller.exit}
          >
            {CAPTURE_COPY.bestMomentsExit}
          </button>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- extension */

export const bestMoments: PlayerExtension = {
  id: "best-moments",
  name: "Лучшие моменты",
  setup(ctx): Unsubscribe {
    const controller = createBestMomentsController({
      mpv: ctx.mpv,
      registry: createCloudRegistry(),
      native: createClipsNative(),
      getSnapshot: ctx.getSnapshot,
    });
    let wasEof = ctx.getSnapshot().eof;
    const stopSnapshot = ctx.onSnapshot((snapshot: PlayerSnapshot) => {
      if (snapshot.eof && !wasEof) controller.onEof();
      wasEof = snapshot.eof;
      controller.onTick(snapshot);
    });
    const stopCard = ctx.ui.add("overlay", () => (
      <BestMomentsCard controller={controller} />
    ));
    return () => {
      stopCard();
      stopSnapshot();
      controller.dispose();
    };
  },
};

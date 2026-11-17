/**
 * Capture extension (issue #14 + clip builder rework, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Screenshots: one tap → `ctx.mpv.command(["screenshot-to-file", path, mode])`
 * into the configured folder (default «Изображения/Seans»), PNG / JPEG.
 * Clips: ONE «Клип» button opens the clip builder over the player — a wide
 * timeline with draggable A/B handles and a draggable segment, segment
 * preview (play A→B, optional loop), export via ffmpeg stream copy
 * (`src-tauri/src/capture.rs`, optional binary) and an honest frames
 * fallback. Cloud (docs/compose/spec/clips-cloud.md): every export is
 * auto-uploaded in the background with visibility / spoiler / share controls.
 *
 * UI: `controls.secondary` (screenshot / clip builder toggle), `overlay`
 * (builder + toasts), `settings.menu` (folder, format, mode, cloud list).
 * Paths and settings persist in `ctx.storage` (`seans.player.ext.capture.*`).
 */

import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import type { PlayerSnapshot } from "../playerTypes";
import type {
  ExtensionStorage,
  ExtensionTransport,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";
import {
  CAPTURE_COPY,
  clipDuration,
  clipFileName,
  clearMarks,
  EMPTY_MARKS,
  ensureClipExtension,
  exportingLabel,
  exportProgressPercent,
  fallbackFrames,
  formatClipDuration,
  frameFileName,
  isCaptureBusy,
  isExportable,
  isNearPosition,
  joinCapturePath,
  marksLabel,
  MIN_CLIP_SEC,
  moveHandle,
  moveSegment,
  parseMpvTime,
  parseSaveDir,
  parseScreenshotFormat,
  parseScreenshotMode,
  previewActionAt,
  screenshotArgs,
  screenshotFileName,
  setMarkA,
  setMarkB,
  timelineSeconds,
  SCREENSHOT_FORMATS,
  SCREENSHOT_FORMAT_LABELS,
  SCREENSHOT_MODES,
  SCREENSHOT_MODE_LABELS,
  type ClipMarks,
  type ScreenshotFormat,
  type ScreenshotMode,
} from "./captureHelpers";
import {
  createCaptureNative,
  createClipsNative,
  toCaptureError,
  type CaptureNative,
} from "./captureNative";
import {
  createCloudSync,
  type CloudSync,
} from "./captureCloud";
import {
  CLIP_VISIBILITIES,
  CLIP_VISIBILITY_LABELS,
  formatCloudStatus,
  shareUrlForCode,
  type ClipVisibility,
  type LocalCloudAsset,
} from "../../clips";

const SAVE_DIR_KEY = "saveDir";
const FORMAT_KEY = "format";
const MODE_KEY = "mode";

/* ------------------------------------------------------------- settings */

export type CaptureSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getSaveDir(): string;
  getFormat(): ScreenshotFormat;
  getMode(): ScreenshotMode;
  setSaveDir(dir: string): void;
  setFormat(format: ScreenshotFormat): void;
  setMode(mode: ScreenshotMode): void;
};

export function createCaptureSettings(
  storage: ExtensionStorage,
): CaptureSettings {
  let saveDir = parseSaveDir(storage.get(SAVE_DIR_KEY, ""));
  let format = parseScreenshotFormat(storage.get(FORMAT_KEY, "png"));
  let mode = parseScreenshotMode(storage.get(MODE_KEY, "video"));
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getSaveDir: () => saveDir,
    getFormat: () => format,
    getMode: () => mode,
    setSaveDir(dir) {
      const next = parseSaveDir(dir);
      if (next === saveDir) return;
      saveDir = next;
      storage.set(SAVE_DIR_KEY, saveDir);
      notify();
    },
    setFormat(next) {
      const value = parseScreenshotFormat(next);
      if (value === format) return;
      format = value;
      storage.set(FORMAT_KEY, format);
      notify();
    },
    setMode(next) {
      const value = parseScreenshotMode(next);
      if (value === mode) return;
      mode = value;
      storage.set(MODE_KEY, mode);
      notify();
    },
  };
}

/* ---------------------------------------------------------------- state */

export type MarksStore = {
  subscribe(cb: () => void): Unsubscribe;
  get(): ClipMarks;
  set(marks: ClipMarks): void;
};

export function createMarksStore(): MarksStore {
  let marks = EMPTY_MARKS;
  const listeners = new Set<() => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => marks,
    set(next) {
      if (next.a === marks.a && next.b === marks.b) return;
      marks = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

export type CaptureStatus =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "progress"; percent: number }
  | { kind: "done"; message: string; revealPath: string }
  | { kind: "fallback"; message: string }
  | { kind: "error"; message: string };

export type StatusStore = {
  subscribe(cb: () => void): Unsubscribe;
  get(): CaptureStatus;
  set(status: CaptureStatus): void;
};

export function createStatusStore(): StatusStore {
  let status: CaptureStatus = { kind: "idle" };
  const listeners = new Set<() => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => status,
    set(next) {
      if (next === status) return;
      status = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Clip builder mode: open/closed, preview loop flag, preview running. */
export type ClipModeState = {
  active: boolean;
  loop: boolean;
  previewing: boolean;
};

export type ClipModeStore = {
  subscribe(cb: () => void): Unsubscribe;
  get(): ClipModeState;
  set(next: Partial<ClipModeState>): void;
};

export function createClipModeStore(): ClipModeStore {
  let state: ClipModeState = { active: false, loop: false, previewing: false };
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
      const merged = { ...state, ...next };
      if (
        merged.active === state.active &&
        merged.loop === state.loop &&
        merged.previewing === state.previewing
      ) {
        return;
      }
      state = merged;
      for (const listener of [...listeners]) listener();
    },
  };
}

/* ------------------------------------------------------------ controller */

export type CaptureDeps = {
  getSnapshot: () => PlayerSnapshot;
  transport: ExtensionTransport;
  mpv: MpvBridge;
  native: CaptureNative;
  settings: CaptureSettings;
  marks: MarksStore;
  status: StatusStore;
  /** Cloud sync (clips-cloud.md) — optional so plain capture keeps working. */
  cloud?: CloudSync;
  clipMode?: ClipModeStore;
};

export type CaptureController = {
  settings: CaptureSettings;
  marks: MarksStore;
  status: StatusStore;
  clipMode: ClipModeStore;
  cloud: CloudSync | null;
  takeScreenshot(): Promise<void>;
  markStart(): void;
  markEnd(): void;
  clearClip(): void;
  exportClip(): Promise<void>;
  saveFallbackFrames(): Promise<void>;
  reveal(path: string): Promise<void>;
  chooseFolder(): Promise<void>;
  openFolder(): Promise<void>;
  /** Clip builder (phase 1). */
  enterClipMode(): void;
  exitClipMode(): void;
  playSegment(): Promise<void>;
  stopSegment(): Promise<void>;
  toggleLoop(): void;
  dragHandleTo(which: "a" | "b", seconds: number): void;
  dragSegmentBy(deltaSec: number): void;
  /** Snapshot tick: stop/loop the segment preview at the edges. */
  onTick(snapshot: PlayerSnapshot): void;
  /** Live file duration (0 when unknown) — timeline scaling. */
  getDuration(): number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Actions shared by the UI and the tests. Every async path ends in a status
 * toast — dialogs report `CaptureError`s, mpv rejects are wrapped the same
 * way, and the fallback is offered (never assumed) when ffmpeg is missing.
 */
export function createCaptureController(deps: CaptureDeps): CaptureController {
  const { settings, marks, status, native } = deps;
  const clipMode = deps.clipMode ?? createClipModeStore();
  const cloud = deps.cloud ?? null;

  const fail = (error: unknown, prefix: string): void => {
    const err = toCaptureError(error, "capture-failed");
    status.set({ kind: "error", message: `${prefix}: ${err.message}` });
  };

  /** Guard: one capture job at a time (review: double-click double export). */
  const busy = (): boolean => isCaptureBusy(status.get());

  /** Configured folder, falling back to «Изображения/Seans» (then remembered). */
  const resolveDir = async (): Promise<string> => {
    const current = settings.getSaveDir();
    if (current) return current;
    const dir = await native.defaultDir();
    settings.setSaveDir(dir);
    return dir;
  };

  /** After a personal seek, wait until the frame at `target` is up. */
  const waitForFrame = async (target: number): Promise<void> => {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const raw = await deps.mpv.getProperty("time-pos").catch(() => null);
      const position = parseMpvTime(raw ?? null);
      if (position != null && isNearPosition(position, target)) return;
      await sleep(100);
    }
    // Best effort: capture whatever frame is displayed by then.
  };

  const takeScreenshot = async (): Promise<void> => {
    if (busy()) return;
    const snapshot = deps.getSnapshot();
    if (!snapshot.file_loaded) {
      status.set({ kind: "error", message: CAPTURE_COPY.noMedia });
      return;
    }
    status.set({ kind: "working", label: CAPTURE_COPY.screenshot });
    try {
      const dir = await resolveDir();
      const path = joinCapturePath(
        dir,
        screenshotFileName(settings.getFormat(), new Date()),
      );
      await deps.mpv
        .command(screenshotArgs(path, settings.getMode()))
        .catch((error) => {
          throw toCaptureError(error, "screenshot-failed");
        });
      status.set({
        kind: "done",
        message: CAPTURE_COPY.screenshotSaved,
        revealPath: path,
      });
      // Auto-upload in the background (phase 2) — never blocks the save.
      cloud?.registerScreenshot({
        localPath: path,
        atSec: snapshot.position,
      });
    } catch (error) {
      fail(error, CAPTURE_COPY.screenshotFailed);
    }
  };

  const exportClip = async (): Promise<void> => {
    if (busy()) return;
    const current = marks.get();
    const duration = clipDuration(current);
    if (duration == null) {
      status.set({ kind: "error", message: CAPTURE_COPY.noRange });
      return;
    }
    const snapshot = deps.getSnapshot();
    if (!snapshot.file_loaded) {
      status.set({ kind: "error", message: CAPTURE_COPY.noMedia });
      return;
    }
    const source =
      snapshot.url || (await deps.mpv.getProperty("path").catch(() => ""));
    if (!source) {
      status.set({ kind: "error", message: CAPTURE_COPY.noMedia });
      return;
    }
    // Busy from before the dialog: the save dialog must not open twice.
    status.set({ kind: "working", label: CAPTURE_COPY.exportClip });
    try {
      const dir = await resolveDir();
      const chosen = await native.chooseClipPath(
        clipFileName(new Date(), "mp4"),
        dir,
      );
      // Cancelled dialog — no toast.
      if (chosen == null) {
        status.set({ kind: "idle" });
        return;
      }
      const outPath = ensureClipExtension(chosen, "mp4");
      status.set({ kind: "progress", percent: 0 });
      const stopProgress = native.onExportProgress((outTimeMs) => {
        status.set({
          kind: "progress",
          percent: exportProgressPercent(outTimeMs, duration),
        });
      });
      try {
        await native.exportClip({
          source,
          start: current.a as number,
          end: current.b as number,
          outPath,
        });
      } finally {
        stopProgress();
      }
      status.set({
        kind: "done",
        message: CAPTURE_COPY.exportDone,
        revealPath: outPath,
      });
      // Auto-upload the fresh clip (phase 2) — never blocks the export.
      cloud?.registerClip({
        localPath: outPath,
        startSec: current.a as number,
        endSec: current.b as number,
      });
    } catch (error) {
      const err = toCaptureError(error, "export-failed");
      if (err.code === "ffmpeg-missing") {
        status.set({ kind: "fallback", message: CAPTURE_COPY.ffmpegMissing });
      } else {
        status.set({
          kind: "error",
          message: `${CAPTURE_COPY.exportFailed}: ${err.message}`,
        });
      }
    }
  };

  const saveFallbackFrames = async (): Promise<void> => {
    if (busy()) return;
    const frames = fallbackFrames(marks.get());
    if (frames.length === 0) {
      status.set({ kind: "error", message: CAPTURE_COPY.noRange });
      return;
    }
    const snapshot = deps.getSnapshot();
    if (!snapshot.file_loaded) {
      status.set({ kind: "error", message: CAPTURE_COPY.noMedia });
      return;
    }
    try {
      const dir = await resolveDir();
      status.set({ kind: "working", label: "Сохраняем кадры…" });
      // One stamp for the whole fallback: -a/-b must share a timestamp so
      // the pair is recognisable (review note).
      const at = new Date();
      const wasPlaying = !snapshot.pause;
      const origin = snapshot.position;
      if (wasPlaying) await deps.transport.pause();
      const paths: string[] = [];
      try {
        for (const frame of frames) {
          // Personal seeks — must not broadcast to rooms (types.ts).
          await deps.transport.seek(frame.at, { personal: true });
          await waitForFrame(frame.at);
          const path = joinCapturePath(
            dir,
            frameFileName(at, frame.mark, settings.getFormat()),
          );
          await deps.mpv
            .command(screenshotArgs(path, settings.getMode()))
            .catch((error) => {
              throw toCaptureError(error, "screenshot-failed");
            });
          paths.push(path);
        }
      } finally {
        await deps.transport.seek(origin, { personal: true }).catch(() => {});
        if (wasPlaying) await deps.transport.play().catch(() => {});
      }
      status.set({
        kind: "done",
        message: CAPTURE_COPY.framesSaved,
        revealPath: paths[0],
      });
    } catch (error) {
      fail(error, CAPTURE_COPY.framesFailed);
    }
  };

  /* ------------------------------------------------------- clip builder */

  const enterClipMode = (): void => {
    const snapshot = deps.getSnapshot();
    if (!snapshot.file_loaded) {
      status.set({ kind: "error", message: CAPTURE_COPY.noMedia });
      return;
    }
    clipMode.set({ active: true });
    // Entering the builder seeds the range with the current position so the
    // handles are grabbable immediately.
    const position = snapshot.position;
    if (marks.get().a == null && marks.get().b == null && position > 0) {
      const seeded = setMarkB(setMarkA(EMPTY_MARKS, position), position + MIN_CLIP_SEC);
      marks.set(seeded);
    }
  };

  const exitClipMode = (): void => {
    clipMode.set({ active: false, previewing: false });
  };

  const playSegment = async (): Promise<void> => {
    const current = marks.get();
    if (!isExportable(current)) {
      status.set({ kind: "error", message: CAPTURE_COPY.noRange });
      return;
    }
    clipMode.set({ previewing: true });
    await deps.transport.seek(current.a as number, { personal: true }).catch(() => {});
    await deps.transport.play().catch(() => {});
  };

  const stopSegment = async (): Promise<void> => {
    clipMode.set({ previewing: false });
    await deps.transport.pause().catch(() => {});
  };

  const onTick = (snapshot: PlayerSnapshot): void => {
    if (!clipMode.get().previewing || !snapshot.file_loaded) return;
    const action = previewActionAt(snapshot.position, marks.get(), clipMode.get().loop);
    if (action === "stop") {
      clipMode.set({ previewing: false });
      void deps.transport.pause().catch(() => {});
    } else if (action === "loop") {
      const a = marks.get().a;
      if (a != null) void deps.transport.seek(a, { personal: true }).catch(() => {});
    }
  };

  return {
    settings,
    marks,
    status,
    clipMode,
    cloud,
    takeScreenshot,
    markStart() {
      const snapshot = deps.getSnapshot();
      if (!snapshot.file_loaded) {
        status.set({ kind: "error", message: CAPTURE_COPY.noMedia });
        return;
      }
      marks.set(setMarkA(marks.get(), snapshot.position));
    },
    markEnd() {
      const snapshot = deps.getSnapshot();
      if (!snapshot.file_loaded) {
        status.set({ kind: "error", message: CAPTURE_COPY.noMedia });
        return;
      }
      marks.set(setMarkB(marks.get(), snapshot.position));
    },
    clearClip() {
      marks.set(clearMarks());
      if (status.get().kind === "fallback") status.set({ kind: "idle" });
    },
    exportClip,
    saveFallbackFrames,
    reveal: (path) =>
      native.reveal(path).catch((error) => fail(error, "Не удалось открыть папку")),
    async chooseFolder() {
      try {
        const chosen = await native.chooseDir(settings.getSaveDir() || undefined);
        if (chosen) settings.setSaveDir(chosen);
      } catch (error) {
        fail(error, "Не удалось выбрать папку");
      }
    },
    async openFolder() {
      try {
        const dir = await resolveDir();
        await native.reveal(dir);
      } catch (error) {
        fail(error, "Не удалось открыть папку");
      }
    },
    enterClipMode,
    exitClipMode,
    playSegment,
    stopSegment,
    toggleLoop() {
      clipMode.set({ loop: !clipMode.get().loop });
    },
    dragHandleTo(which, seconds) {
      const snapshot = deps.getSnapshot();
      marks.set(moveHandle(marks.get(), which, seconds, snapshot.duration));
    },
    dragSegmentBy(deltaSec) {
      const snapshot = deps.getSnapshot();
      marks.set(moveSegment(marks.get(), deltaSec, snapshot.duration));
    },
    onTick,
    getDuration: () => deps.getSnapshot().duration,
  };
}

/* ----------------------------------------------------------------- icons */

function CameraIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect
        x="2"
        y="5"
        width="14"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
      <path
        d="M6.5 5l1-2h3l1 2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      <circle
        cx="9"
        cy="10"
        r="2.6"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  );
}

function ClipIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="5" cy="13" r="2.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="13" cy="13" r="2.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M6.6 11.4L13.5 3M11.4 11.4L4.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* -------------------------------------------------------------------- UI */

function CaptureButtons({
  controller,
}: {
  controller: CaptureController;
}): ReactElement {
  const clipMode = useSyncExternalStore(
    controller.clipMode.subscribe,
    controller.clipMode.get,
  );
  const status = useSyncExternalStore(
    controller.status.subscribe,
    controller.status.get,
  );
  const busy = isCaptureBusy(status);
  return (
    <>
      <button
        type="button"
        className="player-icon-btn"
        aria-label={CAPTURE_COPY.screenshot}
        title={CAPTURE_COPY.screenshotTitle}
        disabled={busy}
        onClick={controller.takeScreenshot}
      >
        <CameraIcon />
      </button>
      <button
        type="button"
        className={`player-icon-btn${clipMode.active ? " player-icon-btn-active" : ""}`}
        aria-label={CAPTURE_COPY.clipBuilder}
        title={CAPTURE_COPY.clipBuilderTitle}
        disabled={busy}
        onClick={() =>
          clipMode.active ? controller.exitClipMode() : controller.enterClipMode()
        }
      >
        <ClipIcon />
      </button>
    </>
  );
}

type DragState = {
  kind: "a" | "b" | "segment";
  startX: number;
  startA: number | null;
  startB: number | null;
};

function ClipBuilderPanel({
  controller,
}: {
  controller: CaptureController;
}): ReactElement {
  const marks = useSyncExternalStore(
    controller.marks.subscribe,
    controller.marks.get,
  );
  const clipMode = useSyncExternalStore(
    controller.clipMode.subscribe,
    controller.clipMode.get,
  );
  const status = useSyncExternalStore(
    controller.status.subscribe,
    controller.status.get,
  );
  const dragRef = useRef<DragState | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const secondsAt = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return timelineSeconds(clientX, rect.left, rect.width, controller.getDuration());
  };

  const beginDrag = (
    kind: DragState["kind"],
    event: ReactPointerEvent,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    dragRef.current = {
      kind,
      startX: event.clientX,
      startA: marks.a,
      startB: marks.b,
    };
    if (kind !== "segment") {
      controller.dragHandleTo(kind, secondsAt(event.clientX));
    }
  };

  const onMove = (event: ReactPointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const fileDuration = controller.getDuration();
    const secPerPx = rect.width > 0 && fileDuration > 0 ? fileDuration / rect.width : 0;
    if (drag.kind === "segment") {
      controller.dragSegmentBy((event.clientX - drag.startX) * secPerPx);
    } else {
      controller.dragHandleTo(drag.kind, secondsAt(event.clientX));
    }
  };

  const endDrag = (event: ReactPointerEvent): void => {
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  };

  const total = controller.getDuration() > 0 ? controller.getDuration() : 1;
  const aPct = marks.a != null ? Math.min(100, Math.max(0, (marks.a / total) * 100)) : 0;
  const bPct = marks.b != null ? Math.min(100, Math.max(0, (marks.b / total) * 100)) : 100;
  const durationLabel = clipDuration(marks);

  return (
    <div className="player-clip-builder" role="group" aria-label={CAPTURE_COPY.clipBuilder}>
      <div className="player-clip-builder-head">
        <span className="player-capture-marks-label">
          {marksLabel(marks) ?? CAPTURE_COPY.builderHint}
        </span>
        <span className="player-clip-duration">
          {CAPTURE_COPY.durationLabel}:{" "}
          {durationLabel != null ? formatClipDuration(durationLabel) : "—"}
        </span>
      </div>
      <div
        ref={trackRef}
        className="player-clip-track"
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="player-clip-segment"
          style={{ left: `${aPct}%`, width: `${Math.max(0, bPct - aPct)}%` }}
          onPointerDown={(event) => beginDrag("segment", event)}
          title={CAPTURE_COPY.builderHint}
        />
        <button
          type="button"
          className="player-clip-handle player-clip-handle-a"
          style={{ left: `${aPct}%` }}
          aria-label={CAPTURE_COPY.markA}
          onPointerDown={(event) => beginDrag("a", event)}
        >
          A
        </button>
        <button
          type="button"
          className="player-clip-handle player-clip-handle-b"
          style={{ left: `${bPct}%` }}
          aria-label={CAPTURE_COPY.markB}
          onPointerDown={(event) => beginDrag("b", event)}
        >
          B
        </button>
      </div>
      <div className="player-clip-actions">
        <button
          type="button"
          className="player-capture-action"
          disabled={!isExportable(marks)}
          onClick={() =>
            clipMode.previewing ? void controller.stopSegment() : void controller.playSegment()
          }
        >
          {clipMode.previewing ? CAPTURE_COPY.stopSegment : CAPTURE_COPY.playSegment}
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={clipMode.loop}
          className={`player-capture-action${clipMode.loop ? " player-icon-btn-active" : ""}`}
          onClick={controller.toggleLoop}
        >
          {CAPTURE_COPY.loopSegment}
        </button>
        <button
          type="button"
          className="player-capture-action"
          disabled={!isExportable(marks) || isCaptureBusy(status)}
          onClick={controller.exportClip}
        >
          {CAPTURE_COPY.exportClip}
        </button>
        <button
          type="button"
          className="player-capture-action"
          onClick={controller.clearClip}
        >
          {CAPTURE_COPY.clearMarks}
        </button>
        <button
          type="button"
          className="player-capture-action"
          onClick={controller.exitClipMode}
        >
          {CAPTURE_COPY.closeBuilder}
        </button>
      </div>
    </div>
  );
}

/** Transient result toasts auto-dismiss (like the progressive grey-zone one). */
const STATUS_DISMISS_MS = 5000;

function CaptureOverlay({
  controller,
}: {
  controller: CaptureController;
}): ReactElement | null {
  const clipMode = useSyncExternalStore(
    controller.clipMode.subscribe,
    controller.clipMode.get,
  );
  const status = useSyncExternalStore(
    controller.status.subscribe,
    controller.status.get,
  );

  useEffect(() => {
    if (status.kind !== "done" && status.kind !== "error") return;
    const timer = setTimeout(
      () => controller.status.set({ kind: "idle" }),
      STATUS_DISMISS_MS,
    );
    return () => clearTimeout(timer);
  }, [controller, status]);

  if (!clipMode.active && status.kind === "idle") return null;

  return (
    <>
      {clipMode.active ? <ClipBuilderPanel controller={controller} /> : null}

      {status.kind !== "idle" ? (
        <div
          className="player-toast player-capture-toast"
          role={status.kind === "error" ? "alert" : "status"}
        >
          {status.kind === "progress" ? exportingLabel(status.percent) : null}
          {status.kind === "working" ? status.label : null}
          {status.kind === "done" ? (
            <>
              {status.message}
              <button
                type="button"
                className="player-capture-action"
                onClick={() => void controller.reveal(status.revealPath)}
              >
                {CAPTURE_COPY.showInFolder}
              </button>
            </>
          ) : null}
          {status.kind === "fallback" ? (
            <>
              {status.message}
              <button
                type="button"
                className="player-capture-action"
                onClick={controller.saveFallbackFrames}
              >
                {CAPTURE_COPY.saveFrames}
              </button>
            </>
          ) : null}
          {status.kind === "error" ? status.message : null}
        </div>
      ) : null}
    </>
  );
}

function CloudAssetRow({
  asset,
  controller,
}: {
  asset: LocalCloudAsset;
  controller: CaptureController;
}): ReactElement {
  const cloud = controller.cloud;
  return (
    <div className="player-menu-list">
      <div className="player-menu-item" title={asset.localPath ?? undefined}>
        <span>
          {asset.kind === "clip" ? "Клип" : "Скриншот"} ·{" "}
          {formatCloudStatus(asset.status, asset.error)}
        </span>
        <span className="player-menu-row">
          {CLIP_VISIBILITIES.map((visibility: ClipVisibility) => (
            <button
              key={visibility}
              type="button"
              role="menuitemradio"
              aria-checked={asset.visibility === visibility}
              className={`player-chip${asset.visibility === visibility ? " player-chip-active" : ""}`}
              disabled={!cloud}
              onClick={() => void cloud?.setVisibility(asset.localId, visibility)}
            >
              {CLIP_VISIBILITY_LABELS[visibility]}
            </button>
          ))}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={asset.spoiler}
            className={`player-chip${asset.spoiler ? " player-chip-active" : ""}`}
            disabled={!cloud}
            onClick={() => void cloud?.setSpoiler(asset.localId, !asset.spoiler)}
          >
            {asset.spoiler ? CAPTURE_COPY.spoilerOn : CAPTURE_COPY.spoilerOff}
          </button>
          {asset.status !== "uploaded" ? (
            <button
              type="button"
              className="player-chip"
              disabled={!cloud || asset.status === "uploading"}
              onClick={() => void cloud?.upload(asset.localId)}
            >
              {asset.status === "uploading"
                ? CAPTURE_COPY.uploading
                : CAPTURE_COPY.upload}
            </button>
          ) : (
            <button
              type="button"
              className="player-chip"
              disabled={!cloud}
              onClick={() => void cloud?.share(asset.localId)}
            >
              {CAPTURE_COPY.share}
            </button>
          )}
        </span>
      </div>
      {asset.code ? (
        <div className="player-capture-path">{shareUrlForCode(asset.code)}</div>
      ) : null}
    </div>
  );
}

function CaptureSettingsSection({
  controller,
}: {
  controller: CaptureController;
}): ReactElement {
  const { settings } = controller;
  const saveDir = useSyncExternalStore(settings.subscribe, settings.getSaveDir);
  const format = useSyncExternalStore(settings.subscribe, settings.getFormat);
  const mode = useSyncExternalStore(settings.subscribe, settings.getMode);
  const cloudAssets = useSyncExternalStore(
    (cb) => (controller.cloud ? controller.cloud.subscribe(cb) : () => {}),
    () => (controller.cloud ? controller.cloud.list() : EMPTY_ASSETS),
  );
  return (
    <section>
      <h4 className="player-menu-title">{CAPTURE_COPY.section}</h4>
      <h4 className="player-menu-title">{CAPTURE_COPY.formatLabel}</h4>
      <div
        className="player-menu-row"
        role="group"
        aria-label={CAPTURE_COPY.formatLabel}
      >
        {SCREENSHOT_FORMATS.map((value) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={format === value}
            className={`player-chip${format === value ? " player-chip-active" : ""}`}
            onClick={() => settings.setFormat(value)}
          >
            {SCREENSHOT_FORMAT_LABELS[value]}
          </button>
        ))}
      </div>
      <h4 className="player-menu-title">{CAPTURE_COPY.modeLabel}</h4>
      <div
        className="player-menu-row"
        role="group"
        aria-label={CAPTURE_COPY.modeLabel}
      >
        {SCREENSHOT_MODES.map((value) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={mode === value}
            className={`player-chip${mode === value ? " player-chip-active" : ""}`}
            onClick={() => settings.setMode(value)}
          >
            {SCREENSHOT_MODE_LABELS[value]}
          </button>
        ))}
      </div>
      <h4 className="player-menu-title">{CAPTURE_COPY.folderLabel}</h4>
      <div className="player-menu-list">
        <div className="player-capture-path" title={saveDir || undefined}>
          {saveDir || CAPTURE_COPY.defaultFolderHint}
        </div>
        <button
          type="button"
          className="player-menu-item"
          onClick={controller.chooseFolder}
        >
          <span className="player-menu-item-label">{CAPTURE_COPY.changeFolder}</span>
        </button>
        <button
          type="button"
          className="player-menu-item"
          onClick={controller.openFolder}
        >
          <span className="player-menu-item-label">{CAPTURE_COPY.openFolder}</span>
        </button>
      </div>
      <h4 className="player-menu-title">{CAPTURE_COPY.cloudSection}</h4>
      {cloudAssets.length === 0 ? (
        <p className="player-menu-empty">{CAPTURE_COPY.cloudListEmpty}</p>
      ) : (
        cloudAssets.map((asset) => (
          <CloudAssetRow key={asset.localId} asset={asset} controller={controller} />
        ))
      )}
    </section>
  );
}

const EMPTY_ASSETS: LocalCloudAsset[] = [];

/* ------------------------------------------------------------- extension */

export const capture: PlayerExtension = {
  id: "capture",
  name: "Захват",
  setup(ctx): Unsubscribe {
    const settings = createCaptureSettings(ctx.storage);
    const marks = createMarksStore();
    const status = createStatusStore();
    const clipMode = createClipModeStore();
    // Cloud layer (phase 2): real native bridge in the desktop shell; the
    // upload failures degrade to «Ожидает загрузки» and never break capture.
    const cloud = createCloudSync({ native: createClipsNative() });
    const controller = createCaptureController({
      getSnapshot: ctx.getSnapshot,
      transport: ctx.transport,
      mpv: ctx.mpv,
      native: createCaptureNative(),
      settings,
      marks,
      status,
      cloud,
      clipMode,
    });
    // A new file invalidates marks taken from the previous one.
    const reset = () => {
      marks.set(clearMarks());
      status.set({ kind: "idle" });
      clipMode.set({ active: false, previewing: false });
    };
    const stopOpen = ctx.onOpen(reset);
    const stopClose = ctx.onClose(reset);
    const stopTick = ctx.onSnapshot((snapshot) => controller.onTick(snapshot));
    const stopButtons = ctx.ui.add("controls.secondary", () => (
      <CaptureButtons controller={controller} />
    ));
    const stopOverlay = ctx.ui.add("overlay", () => (
      <CaptureOverlay controller={controller} />
    ));
    const stopMenu = ctx.ui.add("settings.menu", () => (
      <CaptureSettingsSection controller={controller} />
    ));
    return () => {
      stopButtons();
      stopOverlay();
      stopMenu();
      stopOpen();
      stopClose();
      stopTick();
    };
  },
};

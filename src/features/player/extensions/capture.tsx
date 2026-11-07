/**
 * Capture extension (issue #14, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Screenshots: one tap → `ctx.mpv.command(["screenshot-to-file", path, mode])`
 * into the configured folder (default «Изображения/Seans»), PNG / JPEG.
 * Clips: A→B marks set live during playback, export via ffmpeg stream copy
 * (`src-tauri/src/capture.rs`, optional binary). Without ffmpeg — the honest
 * fallback saves the start/end frames through mpv and says so; never a
 * silent failure.
 *
 * UI: `controls.secondary` (screenshot / A / B), `overlay` (clip badge +
 * toasts with actions), `settings.menu` (folder, format, mode). Paths and
 * settings persist in `ctx.storage` (`seans.player.ext.capture.*`).
 */

import {
  useEffect,
  useSyncExternalStore,
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
  frameFileName,
  isExportable,
  isNearPosition,
  joinCapturePath,
  marksLabel,
  parseMpvTime,
  parseSaveDir,
  parseScreenshotFormat,
  parseScreenshotMode,
  screenshotArgs,
  screenshotFileName,
  setMarkA,
  setMarkB,
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
  toCaptureError,
  type CaptureNative,
} from "./captureNative";

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

/* ------------------------------------------------------------ controller */

export type CaptureDeps = {
  getSnapshot: () => PlayerSnapshot;
  transport: ExtensionTransport;
  mpv: MpvBridge;
  native: CaptureNative;
  settings: CaptureSettings;
  marks: MarksStore;
  status: StatusStore;
};

export type CaptureController = {
  settings: CaptureSettings;
  marks: MarksStore;
  status: StatusStore;
  takeScreenshot(): Promise<void>;
  markStart(): void;
  markEnd(): void;
  clearClip(): void;
  exportClip(): Promise<void>;
  saveFallbackFrames(): Promise<void>;
  reveal(path: string): Promise<void>;
  chooseFolder(): Promise<void>;
  openFolder(): Promise<void>;
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

  const fail = (error: unknown, prefix: string): void => {
    const err = toCaptureError(error, "capture-failed");
    status.set({ kind: "error", message: `${prefix}: ${err.message}` });
  };

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
    const snapshot = deps.getSnapshot();
    if (!snapshot.file_loaded) {
      status.set({ kind: "error", message: CAPTURE_COPY.noMedia });
      return;
    }
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
    } catch (error) {
      fail(error, CAPTURE_COPY.screenshotFailed);
    }
  };

  const exportClip = async (): Promise<void> => {
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
    try {
      const dir = await resolveDir();
      const chosen = await native.chooseClipPath(
        clipFileName(new Date(), "mp4"),
        dir,
      );
      // Cancelled dialog — no toast.
      if (chosen == null) return;
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
            frameFileName(new Date(), frame.mark, settings.getFormat()),
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

  return {
    settings,
    marks,
    status,
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

function MarkIcon({ letter }: { letter: string }): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M4 3.5h10v11l-5-3-5 3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      <text
        x="9"
        y="10"
        textAnchor="middle"
        fontSize="7.5"
        fill="currentColor"
        fontFamily="inherit"
      >
        {letter}
      </text>
    </svg>
  );
}

/* -------------------------------------------------------------------- UI */

function CaptureButtons({
  controller,
}: {
  controller: CaptureController;
}): ReactElement {
  const marks = useSyncExternalStore(
    controller.marks.subscribe,
    controller.marks.get,
  );
  const status = useSyncExternalStore(
    controller.status.subscribe,
    controller.status.get,
  );
  const busy = status.kind === "working" || status.kind === "progress";
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
        className={`player-icon-btn${marks.a != null ? " player-icon-btn-active" : ""}`}
        aria-label={CAPTURE_COPY.markA}
        title={CAPTURE_COPY.markA}
        disabled={busy}
        onClick={controller.markStart}
      >
        <MarkIcon letter="A" />
      </button>
      <button
        type="button"
        className={`player-icon-btn${marks.b != null ? " player-icon-btn-active" : ""}`}
        aria-label={CAPTURE_COPY.markB}
        title={CAPTURE_COPY.markB}
        disabled={busy}
        onClick={controller.markEnd}
      >
        <MarkIcon letter="B" />
      </button>
    </>
  );
}

/** Transient result toasts auto-dismiss (like the progressive grey-zone one). */
const STATUS_DISMISS_MS = 5000;

function CaptureOverlay({
  controller,
}: {
  controller: CaptureController;
}): ReactElement | null {
  const marks = useSyncExternalStore(
    controller.marks.subscribe,
    controller.marks.get,
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

  const label = marksLabel(marks);
  if (!label && status.kind === "idle") return null;

  return (
    <>
      {label ? (
        <div className="player-capture-marks" role="status">
          <span className="player-capture-marks-label">{label}</span>
          <button
            type="button"
            className="player-capture-action"
            disabled={
              !isExportable(marks) ||
              status.kind === "working" ||
              status.kind === "progress"
            }
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
        </div>
      ) : null}

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

function CaptureSettingsSection({
  controller,
}: {
  controller: CaptureController;
}): ReactElement {
  const { settings } = controller;
  const saveDir = useSyncExternalStore(settings.subscribe, settings.getSaveDir);
  const format = useSyncExternalStore(settings.subscribe, settings.getFormat);
  const mode = useSyncExternalStore(settings.subscribe, settings.getMode);
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
    </section>
  );
}

/* ------------------------------------------------------------- extension */

export const capture: PlayerExtension = {
  id: "capture",
  name: "Захват",
  setup(ctx): Unsubscribe {
    const settings = createCaptureSettings(ctx.storage);
    const marks = createMarksStore();
    const status = createStatusStore();
    const controller = createCaptureController({
      getSnapshot: ctx.getSnapshot,
      transport: ctx.transport,
      mpv: ctx.mpv,
      native: createCaptureNative(),
      settings,
      marks,
      status,
    });
    // A new file invalidates marks taken from the previous one.
    const reset = () => {
      marks.set(clearMarks());
      status.set({ kind: "idle" });
    };
    const stopOpen = ctx.onOpen(reset);
    const stopClose = ctx.onClose(reset);
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
    };
  },
};

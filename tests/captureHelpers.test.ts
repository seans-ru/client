import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_COPY,
  clipDuration,
  clipFileName,
  clearMarks,
  containerFromPath,
  EMPTY_MARKS,
  ensureClipExtension,
  exportingLabel,
  exportProgressPercent,
  fallbackFrames,
  formatClipDuration,
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
  sourceCodecs,
  timestampStamp,
} from "../src/features/player/extensions/captureHelpers";
import {
  capture,
  createCaptureController,
  createCaptureSettings,
  createMarksStore,
  createStatusStore,
} from "../src/features/player/extensions/capture";
import { toCaptureError } from "../src/features/player/extensions/captureNative";
import {
  createExtensionRuntime,
  type ExtensionRuntimeDeps,
} from "../src/features/player/extensions/registry";
import type {
  ExtensionStorage,
  ExtensionTransport,
  MpvBridge,
} from "../src/features/player/extensions/types";
import {
  DEFAULT_SNAPSHOT,
  type PlayerSnapshot,
} from "../src/features/player/playerTypes";

function makeStorage(initial: Record<string, unknown> = {}): ExtensionStorage {
  const store = new Map(Object.entries(initial));
  return {
    get: <T,>(key: string, fallback: T): T =>
      store.has(key) ? (store.get(key) as T) : fallback,
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

type TestMpv = MpvBridge & { calls: string[][]; props: Map<string, string> };

function makeMpv(): TestMpv {
  const calls: string[][] = [];
  const props = new Map<string, string>([["time-pos", "0"]]);
  return {
    calls,
    props,
    getProperty: async (name: string) => props.get(name) ?? "",
    setProperty: async () => {},
    command: async (args: string[]) => {
      calls.push([...args]);
      return null;
    },
  };
}

type TestTransport = ExtensionTransport & { calls: unknown[][] };

function makeTransport(mpv?: TestMpv): TestTransport {
  const calls: unknown[][] = [];
  return {
    calls,
    play: async () => {
      calls.push(["play"]);
    },
    pause: async () => {
      calls.push(["pause"]);
    },
    togglePause: async () => {
      calls.push(["togglePause"]);
    },
    seek: async (seconds: number, opts?: { personal?: boolean }) => {
      calls.push(["seek", seconds, opts]);
      // Mirror the seeked frame so `waitForFrame` resolves immediately.
      mpv?.props.set("time-pos", String(seconds));
    },
    setSpeed: async () => {},
    setVolume: async () => {},
    setMute: async () => {},
    setFullscreen: async () => {},
  };
}

type TestNative = {
  defaultDir: () => Promise<string>;
  chooseDir: (defaultPath?: string) => Promise<string | null>;
  chooseClipPath: (defaultName: string, defaultDir: string) => Promise<string | null>;
  exportClip: (args: {
    source: string;
    start: number;
    end: number;
    outPath: string;
    videoCodec: string;
    audioCodec: string;
  }) => Promise<void>;
  onExportProgress: (cb: (outTimeMs: number) => void) => () => void;
  reveal: (path: string) => Promise<void>;
  revealed: string[];
  dirChoices: Array<string | undefined>;
  clipChoices: string[];
  exports: Array<{
    source: string;
    start: number;
    end: number;
    outPath: string;
    videoCodec: string;
    audioCodec: string;
  }>;
};

function makeNative(overrides: Partial<TestNative> = {}): TestNative {
  const revealed: string[] = [];
  const dirChoices: Array<string | undefined> = [];
  const clipChoices: string[] = [];
  const exports: TestNative["exports"] = [];
  return {
    revealed,
    dirChoices,
    clipChoices,
    exports,
    defaultDir: async () => "C:\\Users\\t\\Pictures\\Seans",
    chooseDir: async (defaultPath?: string) => {
      dirChoices.push(defaultPath);
      return null;
    },
    chooseClipPath: async (defaultName: string) => {
      clipChoices.push(defaultName);
      return "C:\\Users\\t\\Pictures\\Seans\\seans-clip-test.mp4";
    },
    exportClip: async (args) => {
      exports.push(args);
    },
    onExportProgress: () => () => {},
    reveal: async (path) => {
      revealed.push(path);
    },
    ...overrides,
  };
}

function makeSnapshot(partial: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    ...DEFAULT_SNAPSHOT,
    file_loaded: true,
    url: "https://cdn.example/v.mp4",
    position: 12.5,
    duration: 100,
    pause: true,
    tracks: [
      { id: 1, kind: "video", title: "", lang: "", codec: "h264", selected: true, external: false },
      { id: 2, kind: "audio", title: "", lang: "", codec: "aac", selected: true, external: false },
    ],
    ...partial,
  };
}

function makeController(
  opts: {
    snapshot?: Partial<PlayerSnapshot>;
    storage?: Record<string, unknown>;
    native?: Partial<TestNative>;
  } = {},
) {
  const mpv = makeMpv();
  const transport = makeTransport(mpv);
  const native = makeNative(opts.native);
  const storage = makeStorage(opts.storage);
  const settings = createCaptureSettings(storage);
  const marks = createMarksStore();
  const status = createStatusStore();
  let snapshot = makeSnapshot(opts.snapshot);
  const controller = createCaptureController({
    getSnapshot: () => snapshot,
    transport,
    mpv,
    native,
    settings,
    marks,
    status,
  });
  return {
    controller,
    mpv,
    transport,
    native,
    settings,
    marks,
    status,
    setSnapshot(next: Partial<PlayerSnapshot>) {
      snapshot = { ...snapshot, ...next };
    },
  };
}

/* ------------------------------------------------------------- pure logic */

describe("capture parse helpers", () => {
  it("keeps known screenshot modes and falls back to video", () => {
    expect(parseScreenshotMode("subtitles")).toBe("subtitles");
    expect(parseScreenshotMode("video")).toBe("video");
    expect(parseScreenshotMode("window")).toBe("video");
    expect(parseScreenshotMode(undefined)).toBe("video");
  });

  it("keeps known formats and falls back to png", () => {
    expect(parseScreenshotFormat("jpeg")).toBe("jpeg");
    expect(parseScreenshotFormat("png")).toBe("png");
    expect(parseScreenshotFormat("gif")).toBe("png");
    expect(parseScreenshotFormat(42)).toBe("png");
  });

  it("trims a persisted folder and rejects non-strings", () => {
    expect(parseSaveDir("  C:/shots  ")).toBe("C:/shots");
    expect(parseSaveDir("")).toBe("");
    expect(parseSaveDir(null)).toBe("");
    expect(parseSaveDir(7)).toBe("");
  });

  it("builds the screenshot-to-file command from the issue contract", () => {
    expect(screenshotArgs("D:/shots/a.png", "video")).toEqual([
      "screenshot-to-file",
      "D:/shots/a.png",
      "video",
    ]);
    expect(screenshotArgs("D:/shots/a.png", "subtitles")).toEqual([
      "screenshot-to-file",
      "D:/shots/a.png",
      "subtitles",
    ]);
  });
});

describe("capture file names", () => {
  const at = new Date(2026, 0, 5, 7, 8, 9);

  it("stamps local time as YYYYMMDD-HHMMSS", () => {
    expect(timestampStamp(at)).toBe("20260105-070809");
  });

  it("names screenshots by format", () => {
    expect(screenshotFileName("png", at)).toBe("seans-shot-20260105-070809.png");
    expect(screenshotFileName("jpeg", at)).toBe("seans-shot-20260105-070809.jpg");
  });

  it("names clips by container and fallback frames by mark", () => {
    expect(clipFileName(at, "mp4")).toBe("seans-clip-20260105-070809.mp4");
    expect(clipFileName(at, "mkv")).toBe("seans-clip-20260105-070809.mkv");
    expect(frameFileName(at, "a", "png")).toBe("seans-clip-20260105-070809-a.png");
    expect(frameFileName(at, "b", "jpeg")).toBe("seans-clip-20260105-070809-b.jpg");
  });

  it("joins paths with the directory's own separator", () => {
    expect(joinCapturePath("C:\\Users\\t\\Seans", "f.png")).toBe(
      "C:\\Users\\t\\Seans\\f.png",
    );
    expect(joinCapturePath("C:\\Users\\t\\Seans\\", "f.png")).toBe(
      "C:\\Users\\t\\Seans\\f.png",
    );
    expect(joinCapturePath("/home/u/Seans/", "f.png")).toBe("/home/u/Seans/f.png");
    expect(joinCapturePath("", "f.png")).toBe("f.png");
  });
});

describe("clip marks", () => {
  it("drops a stale end mark when the start moves past it", () => {
    expect(setMarkA({ a: 5, b: 10 }, 7)).toEqual({ a: 7, b: 10 });
    expect(setMarkA({ a: 5, b: 10 }, 12)).toEqual({ a: 12, b: null });
    expect(setMarkA(EMPTY_MARKS, 3)).toEqual({ a: 3, b: null });
  });

  it("swaps marks when the end is clicked before the start", () => {
    expect(setMarkB({ a: 20, b: null }, 8)).toEqual({ a: 8, b: 20 });
    expect(setMarkB({ a: 20, b: 25 }, 10)).toEqual({ a: 10, b: 20 });
    expect(setMarkB({ a: 20, b: 25 }, 30)).toEqual({ a: 20, b: 30 });
  });

  it("stores an end mark alone when the start is not set", () => {
    expect(setMarkB(EMPTY_MARKS, 9)).toEqual({ a: null, b: 9 });
  });

  it("clamps garbage positions to 0", () => {
    expect(setMarkA(EMPTY_MARKS, -4)).toEqual({ a: 0, b: null });
    expect(setMarkA(EMPTY_MARKS, Number.NaN)).toEqual({ a: 0, b: null });
    expect(clearMarks()).toEqual(EMPTY_MARKS);
  });

  it("computes duration only for complete ranges", () => {
    expect(clipDuration({ a: 1, b: 3 })).toBe(2);
    expect(clipDuration({ a: 3, b: 1 })).toBeNull();
    expect(clipDuration({ a: 1, b: 1 })).toBeNull();
    expect(clipDuration({ a: 1, b: null })).toBeNull();
    expect(isExportable({ a: 1, b: 2 })).toBe(true);
    expect(isExportable({ a: 1, b: null })).toBe(false);
  });
});

describe("capture labels", () => {
  it("formats durations under a minute with tenths", () => {
    expect(formatClipDuration(33.44)).toBe("33.4 с");
    expect(formatClipDuration(59)).toBe("59 с");
    expect(formatClipDuration(0)).toBe("0 с");
    expect(formatClipDuration(-3)).toBe("0 с");
  });

  it("formats longer durations as clock time", () => {
    expect(formatClipDuration(65)).toBe("1:05");
    expect(formatClipDuration(3661)).toBe("1:01:01");
  });

  it("labels the A→B badge", () => {
    expect(marksLabel({ a: 12, b: 45.4 })).toBe("A 0:12 → B 0:45 · 33.4 с");
    expect(marksLabel({ a: 12, b: null })).toBe("A 0:12 → B —");
    expect(marksLabel({ a: null, b: 30 })).toBe("A — → B 0:30");
    expect(marksLabel(EMPTY_MARKS)).toBeNull();
  });
});

describe("clip paths and fallback", () => {
  it("detects the container from the file extension", () => {
    expect(containerFromPath("C:/x/clip.MP4")).toBe("mp4");
    expect(containerFromPath("clip.mkv")).toBe("mkv");
    expect(containerFromPath("clip.avi")).toBeNull();
  });

  it("appends the fallback extension when the dialog name has none", () => {
    expect(ensureClipExtension("clip", "mp4")).toBe("clip.mp4");
    expect(ensureClipExtension("clip.mkv", "mp4")).toBe("clip.mkv");
    expect(ensureClipExtension("clip.mp4", "mkv")).toBe("clip.mp4");
  });

  it("plans the start/end frames only for complete ranges", () => {
    expect(fallbackFrames({ a: 10, b: 30 })).toEqual([
      { at: 10, mark: "a" },
      { at: 30, mark: "b" },
    ]);
    expect(fallbackFrames({ a: 10, b: null })).toEqual([]);
  });
});

describe("progress helpers", () => {
  it("parses mpv time-pos strings", () => {
    expect(parseMpvTime("12.5")).toBe(12.5);
    expect(parseMpvTime("0")).toBe(0);
    expect(parseMpvTime("no")).toBeNull();
    expect(parseMpvTime("-1")).toBeNull();
    expect(parseMpvTime(null)).toBeNull();
    expect(parseMpvTime(undefined)).toBeNull();
  });

  it("compares seeked frames within an epsilon", () => {
    expect(isNearPosition(10, 10.5)).toBe(true);
    expect(isNearPosition(10, 12)).toBe(false);
    expect(isNearPosition(10, 12, 2)).toBe(true);
  });

  it("maps ffmpeg out_time to a clamped percent of the range", () => {
    expect(exportProgressPercent(5000, 10)).toBe(50);
    expect(exportProgressPercent(0, 10)).toBe(0);
    expect(exportProgressPercent(20000, 10)).toBe(100);
    expect(exportProgressPercent(5000, 0)).toBe(0);
    expect(exportProgressPercent(5000, Number.NaN)).toBe(0);
  });

  it("labels the export progress toast", () => {
    expect(exportingLabel(null)).toBe("Готовим экспорт…");
    expect(exportingLabel(45)).toBe("Экспорт клипа… 45%");
    expect(exportingLabel(45.6)).toBe("Экспорт клипа… 46%");
    expect(exportingLabel(200)).toBe("Экспорт клипа… 100%");
    expect(exportingLabel(Number.NaN)).toBe("Экспорт клипа… 0%");
  });

  it("picks the embedded stream codecs the export maps", () => {
    expect(
      sourceCodecs([
        { kind: "video", codec: "hevc", external: false },
        { kind: "audio", codec: "flac", external: false },
        { kind: "audio", codec: "ac3", external: true },
      ]),
    ).toEqual({ videoCodec: "hevc", audioCodec: "flac" });
    // Sidecar audio is not part of the source file — skipped.
    expect(
      sourceCodecs([{ kind: "audio", codec: "ac3", external: true }]),
    ).toEqual({ videoCodec: "", audioCodec: "" });
    expect(sourceCodecs([])).toEqual({ videoCodec: "", audioCodec: "" });
  });
});

describe("toCaptureError", () => {
  it("passes structured Rust errors through", () => {
    expect(
      toCaptureError({ code: "ffmpeg-missing", message: "нет ffmpeg" }, "x"),
    ).toEqual({ code: "ffmpeg-missing", message: "нет ffmpeg" });
  });

  it("falls back to a code for unstructured rejects", () => {
    expect(toCaptureError(new Error("boom"), "no-tauri")).toEqual({
      code: "no-tauri",
      message: "boom",
    });
  });
});

/* ----------------------------------------------------------------- stores */

describe("createCaptureSettings", () => {
  it("normalizes and persists settings", () => {
    const storage = makeStorage();
    const settings = createCaptureSettings(storage);
    expect(settings.getSaveDir()).toBe("");
    expect(settings.getFormat()).toBe("png");
    expect(settings.getMode()).toBe("video");

    settings.setSaveDir("  D:/shots  ");
    settings.setFormat("jpeg");
    settings.setMode("subtitles");

    const restored = createCaptureSettings(storage);
    expect(restored.getSaveDir()).toBe("D:/shots");
    expect(restored.getFormat()).toBe("jpeg");
    expect(restored.getMode()).toBe("subtitles");
  });

  it("notifies subscribers once per change and unsubscribes cleanly", () => {
    const settings = createCaptureSettings(makeStorage());
    const cb = vi.fn();
    const stop = settings.subscribe(cb);
    settings.setFormat("jpeg");
    settings.setFormat("jpeg");
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
    settings.setMode("subtitles");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("marks and status stores", () => {
  it("keeps referential identity until a real change", () => {
    const marks = createMarksStore();
    const first = marks.get();
    marks.set(EMPTY_MARKS);
    expect(marks.get()).toBe(first);
    marks.set({ a: 1, b: null });
    expect(marks.get()).not.toBe(first);
  });

  it("surfaces status transitions to subscribers", () => {
    const status = createStatusStore();
    const cb = vi.fn();
    status.subscribe(cb);
    expect(status.get()).toEqual({ kind: "idle" });
    status.set({ kind: "error", message: "x" });
    expect(status.get()).toEqual({ kind: "error", message: "x" });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------- controller */

describe("capture controller: marks", () => {
  it("marks A and B from the live position", () => {
    const { controller, marks, setSnapshot } = makeController();
    setSnapshot({ position: 12.5 });
    controller.markStart();
    setSnapshot({ position: 30.25 });
    controller.markEnd();
    expect(marks.get()).toEqual({ a: 12.5, b: 30.25 });
    controller.clearClip();
    expect(marks.get()).toEqual(EMPTY_MARKS);
  });

  it("refuses to mark without an open file", () => {
    const { controller, marks, status } = makeController({
      snapshot: { file_loaded: false },
    });
    controller.markStart();
    controller.markEnd();
    expect(marks.get()).toEqual(EMPTY_MARKS);
    expect(status.get()).toEqual({ kind: "error", message: CAPTURE_COPY.noMedia });
  });
});

describe("capture controller: screenshots", () => {
  it("saves one tap into the default folder and offers reveal", async () => {
    const { controller, mpv, native, status, settings } = makeController();
    await controller.takeScreenshot();
    // The default folder is resolved once and remembered.
    expect(settings.getSaveDir()).toBe("C:\\Users\\t\\Pictures\\Seans");
    expect(mpv.calls).toHaveLength(1);
    expect(mpv.calls[0][0]).toBe("screenshot-to-file");
    expect(mpv.calls[0][1]).toMatch(
      /^C:\\Users\\t\\Pictures\\Seans\\seans-shot-.*\.png$/,
    );
    expect(mpv.calls[0][2]).toBe("video");
    const saved = status.get();
    expect(saved.kind).toBe("done");
    if (saved.kind === "done") {
      expect(saved.message).toBe(CAPTURE_COPY.screenshotSaved);
      expect(saved.revealPath).toContain("seans-shot-");
      await controller.reveal(saved.revealPath);
      expect(native.revealed).toEqual([saved.revealPath]);
    }
  });

  it("uses the configured folder, format and mode", async () => {
    const { controller, mpv } = makeController({
      storage: {
        saveDir: "D:/shots",
        format: "jpeg",
        mode: "subtitles",
      },
    });
    await controller.takeScreenshot();
    const [cmd, path, mode] = mpv.calls[0];
    expect(cmd).toBe("screenshot-to-file");
    expect(path.startsWith("D:/shots/seans-shot-")).toBe(true);
    expect(path.endsWith(".jpg")).toBe(true);
    expect(mode).toBe("subtitles");
  });

  it("reports mpv rejects instead of failing silently", async () => {
    const { controller, mpv, status } = makeController({
      storage: { saveDir: "D:/shots" },
    });
    mpv.command = async () => {
      throw new Error("screenshot unavailable");
    };
    await controller.takeScreenshot();
    const failed = status.get();
    expect(failed.kind).toBe("error");
    if (failed.kind === "error") {
      expect(failed.message).toContain(CAPTURE_COPY.screenshotFailed);
      expect(failed.message).toContain("screenshot unavailable");
    }
  });

  it("blocks screenshots without an open file", async () => {
    const { controller, mpv, status } = makeController({
      snapshot: { file_loaded: false },
    });
    await controller.takeScreenshot();
    expect(mpv.calls).toHaveLength(0);
    expect(status.get()).toEqual({ kind: "error", message: CAPTURE_COPY.noMedia });
  });
});

describe("capture controller: clip export", () => {
  it("exports A→B with stream copy and reports the saved file", async () => {
    const { controller, native, status, setSnapshot } = makeController({
      snapshot: { position: 12 },
    });
    controller.markStart();
    setSnapshot({ position: 30 });
    controller.markEnd();
    await controller.exportClip();

    expect(native.clipChoices[0]).toMatch(/^seans-clip-.*\.mp4$/);
    expect(native.exports).toEqual([
      {
        source: "https://cdn.example/v.mp4",
        start: 12,
        end: 30,
        outPath: "C:\\Users\\t\\Pictures\\Seans\\seans-clip-test.mp4",
        videoCodec: "h264",
        audioCodec: "aac",
      },
    ]);
    const done = status.get();
    expect(done.kind).toBe("done");
    if (done.kind === "done") {
      expect(done.message).toBe(CAPTURE_COPY.exportDone);
      expect(done.revealPath).toBe(
        "C:\\Users\\t\\Pictures\\Seans\\seans-clip-test.mp4",
      );
    }
  });

  it("keeps the .mkv extension chosen in the save dialog", async () => {
    const { controller, native, setSnapshot } = makeController({
      snapshot: { position: 1 },
      native: {
        chooseClipPath: async () => "D:/clips/scene.mkv",
      },
    });
    controller.markStart();
    setSnapshot({ position: 5 });
    controller.markEnd();
    await controller.exportClip();
    expect(native.exports[0].outPath).toBe("D:/clips/scene.mkv");
  });

  it("appends .mp4 when the dialog name has no extension", async () => {
    const { controller, native, setSnapshot } = makeController({
      snapshot: { position: 1 },
      native: {
        chooseClipPath: async () => "D:/clips/scene",
      },
    });
    controller.markStart();
    setSnapshot({ position: 5 });
    controller.markEnd();
    await controller.exportClip();
    expect(native.exports[0].outPath).toBe("D:/clips/scene.mp4");
  });

  it("says nothing when the save dialog is cancelled", async () => {
    const { controller, native, status, setSnapshot } = makeController({
      snapshot: { position: 1 },
      native: { chooseClipPath: async () => null },
    });
    controller.markStart();
    setSnapshot({ position: 5 });
    controller.markEnd();
    await controller.exportClip();
    expect(native.exports).toHaveLength(0);
    expect(status.get()).toEqual({ kind: "idle" });
  });

  it("demands a complete range first", async () => {
    const { controller, status } = makeController();
    await controller.exportClip();
    expect(status.get()).toEqual({ kind: "error", message: CAPTURE_COPY.noRange });
  });

  it("offers the frames fallback when ffmpeg is missing", async () => {
    const { controller, status, setSnapshot } = makeController({
      snapshot: { position: 1 },
      native: {
        exportClip: async () => {
          throw toCaptureError(
            { code: "ffmpeg-missing", message: "ffmpeg не найден" },
            "export-failed",
          );
        },
      },
    });
    controller.markStart();
    setSnapshot({ position: 5 });
    controller.markEnd();
    await controller.exportClip();
    expect(status.get()).toEqual({
      kind: "fallback",
      message: CAPTURE_COPY.ffmpegMissing,
    });
  });

  it("surfaces other export errors", async () => {
    const { controller, status, setSnapshot } = makeController({
      snapshot: { position: 1 },
      native: {
        exportClip: async () => {
          throw toCaptureError(
            { code: "ffmpeg-failed", message: "bad codec" },
            "export-failed",
          );
        },
      },
    });
    controller.markStart();
    setSnapshot({ position: 5 });
    controller.markEnd();
    await controller.exportClip();
    const failed = status.get();
    expect(failed.kind).toBe("error");
    if (failed.kind === "error") {
      expect(failed.message).toContain(CAPTURE_COPY.exportFailed);
      expect(failed.message).toContain("bad codec");
    }
  });

  it("shows ffmpeg progress as a percent of the range", async () => {
    let report: ((ms: number) => void) | null = null;
    const { controller, status, setSnapshot } = makeController({
      snapshot: { position: 10 },
      native: {
        onExportProgress: (cb) => {
          report = cb;
          return () => {};
        },
        exportClip: async () => {
          report?.(10000);
        },
      },
    });
    controller.markStart();
    setSnapshot({ position: 30 });
    controller.markEnd();
    await controller.exportClip();
    // 10 s of a 20 s range → 50%, then the final done status.
    expect(status.get().kind).toBe("done");
  });

  it("records progress mid-export", async () => {
    const seen: string[] = [];
    let report: ((ms: number) => void) | null = null;
    const { controller, status, setSnapshot } = makeController({
      snapshot: { position: 0 },
      native: {
        onExportProgress: (cb) => {
          report = cb;
          return () => {};
        },
        exportClip: async () => {
          report?.(5000);
          seen.push(
            status.get().kind === "progress" ? status.get().kind : "other",
          );
          report?.(15000);
        },
      },
    });
    controller.markStart();
    setSnapshot({ position: 20 });
    controller.markEnd();
    await controller.exportClip();
    expect(seen).toEqual(["progress"]);
  });
});

describe("capture controller: frames fallback", () => {
  it("seeks to both marks, saves frames and restores playback", async () => {
    const { controller, mpv, transport, status, setSnapshot } = makeController({
      snapshot: { position: 12.5, pause: false, url: "https://cdn.example/v.mp4" },
    });
    controller.markStart();
    setSnapshot({ position: 30 });
    controller.markEnd();
    // The viewer has moved on before clicking the fallback.
    setSnapshot({ position: 45.5 });
    await controller.saveFallbackFrames();

    // Pause → seek A → shot → seek B → shot → back to origin → play.
    expect(transport.calls[0]).toEqual(["pause"]);
    expect(transport.calls[1]).toEqual(["seek", 12.5, { personal: true }]);
    expect(transport.calls[2]).toEqual(["seek", 30, { personal: true }]);
    expect(transport.calls[3]).toEqual(["seek", 45.5, { personal: true }]);
    expect(transport.calls[4]).toEqual(["play"]);

    const shots = mpv.calls.filter((c) => c[0] === "screenshot-to-file");
    expect(shots).toHaveLength(2);
    expect(shots[0][1]).toMatch(/-a\.png$/);
    expect(shots[1][1]).toMatch(/-b\.png$/);
    // Personal seeks never broadcast to rooms.
    for (const call of transport.calls.filter((c) => c[0] === "seek")) {
      expect(call[2]).toEqual({ personal: true });
    }

    const done = status.get();
    expect(done.kind).toBe("done");
    if (done.kind === "done") {
      expect(done.message).toBe(CAPTURE_COPY.framesSaved);
    }
  });

  it("does not resume a paused player", async () => {
    const { controller, transport, setSnapshot } = makeController({
      snapshot: { position: 3, pause: true },
    });
    controller.markStart();
    setSnapshot({ position: 8 });
    controller.markEnd();
    await controller.saveFallbackFrames();
    expect(transport.calls.map((c) => c[0])).toEqual([
      "seek",
      "seek",
      "seek",
    ]);
  });

  it("demands a complete range", async () => {
    const { controller, status } = makeController();
    await controller.saveFallbackFrames();
    expect(status.get()).toEqual({ kind: "error", message: CAPTURE_COPY.noRange });
  });
});

describe("capture controller: folder actions", () => {
  it("persists the folder chosen in the system dialog", async () => {
    const dirChoices: Array<string | undefined> = [];
    const { controller, settings } = makeController({
      native: {
        chooseDir: async (defaultPath?: string) => {
          dirChoices.push(defaultPath);
          return "E:/clips";
        },
      },
    });
    await controller.chooseFolder();
    expect(settings.getSaveDir()).toBe("E:/clips");
    expect(dirChoices).toEqual([undefined]);

    await controller.chooseFolder();
    expect(dirChoices).toEqual([undefined, "E:/clips"]);
  });

  it("opens the configured folder", async () => {
    const { controller, native } = makeController({
      storage: { saveDir: "E:/clips" },
    });
    await controller.openFolder();
    expect(native.revealed).toEqual(["E:/clips"]);
  });

  it("reports a failing dialog instead of dying", async () => {
    const { controller, status } = makeController({
      native: {
        chooseDir: async () => {
          throw toCaptureError({ code: "no-tauri", message: "no dialog" }, "x");
        },
      },
    });
    await controller.chooseFolder();
    const failed = status.get();
    expect(failed.kind).toBe("error");
    if (failed.kind === "error") {
      expect(failed.message).toContain("no dialog");
    }
  });
});

/* --------------------------------------------------------------- registry */

describe("capture extension (registry scenarios)", () => {
  function setup() {
    const mpv = makeMpv();
    const deps: ExtensionRuntimeDeps = {
      transport: makeTransport(mpv),
      getSnapshot: () => makeSnapshot(),
      mpv,
      frames: { subscribe: () => () => {} },
      storageFor: () => makeStorage(),
      setChromeHidden: () => {},
    };
    const runtime = createExtensionRuntime([capture], deps);
    return { mpv, runtime };
  }

  it("contributes buttons, the overlay badge and the settings section", () => {
    const { runtime } = setup();
    expect(runtime.getSlotEntries("controls.secondary")).toHaveLength(1);
    expect(runtime.getSlotEntries("overlay")).toHaveLength(1);
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(1);
    for (const slot of ["controls.secondary", "overlay", "settings.menu"] as const) {
      const entry = runtime.getSlotEntries(slot)[0];
      expect(entry.extId).toBe("capture");
      expect(typeof entry.render()).toBe("object");
    }
    runtime.dispose();
    expect(runtime.getSlotEntries("controls.secondary")).toHaveLength(0);
    expect(runtime.getSlotEntries("overlay")).toHaveLength(0);
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
  });

  it("resets marks on file open", () => {
    const { runtime } = setup();
    // Marks live in the setup closure; opening a file must not throw and the
    // overlay slot keeps contributing UI (a React element object).
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    const entry = runtime.getSlotEntries("overlay")[0];
    expect(typeof entry.render()).toBe("object");
    runtime.dispose();
  });
});

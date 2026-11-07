/**
 * Native capture adapter (issue #14): Tauri dialogs + the `capture_*`
 * commands from src-tauri/src/capture.rs.
 *
 * Thin wrappers only — all rules live in `captureHelpers.ts`. Every call
 * rejects with a structured `CaptureError` (`code` + `message`); outside
 * Tauri (plain vite) the rejects surface as `no-tauri` and the UI shows an
 * honest toast instead of failing silently (spec: player-extensibility §S2.9).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { joinCapturePath } from "./captureHelpers";
import type { Unsubscribe } from "./types";

export type CaptureError = {
  /** Machine code: `ffmpeg-missing`, `invalid-range`, `no-tauri`, … */
  code: string;
  message: string;
};

export function toCaptureError(error: unknown, fallbackCode: string): CaptureError {
  if (error != null && typeof error === "object" && "code" in error && "message" in error) {
    const structured = error as { code: unknown; message: unknown };
    return {
      code: String(structured.code),
      message: String(structured.message),
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

export type ExportClipArgs = {
  /** mpv `path` of the open file (local path or stream URL). */
  source: string;
  /** Range start / end in seconds (A→B marks). */
  start: number;
  end: number;
  outPath: string;
};

export type CaptureNative = {
  /** «Изображения/Seans», created on demand. */
  defaultDir(): Promise<string>;
  /** System folder picker; `null` when the user cancels. */
  chooseDir(defaultPath?: string): Promise<string | null>;
  /** System save dialog for a clip; `null` when the user cancels. */
  chooseClipPath(defaultName: string, defaultDir: string): Promise<string | null>;
  /** ffmpeg stream-copy export (see capture.rs). Rejects with `CaptureError`. */
  exportClip(args: ExportClipArgs): Promise<void>;
  /** ffmpeg progress pings (ms into the range). */
  onExportProgress(cb: (outTimeMs: number) => void): Unsubscribe;
  /** «Показать в папке» — reveal a file or open its folder. */
  reveal(path: string): Promise<void>;
};

export function createCaptureNative(): CaptureNative {
  return {
    defaultDir: () =>
      invoke<string>("capture_default_dir").catch((error) => {
        throw toCaptureError(error, "no-tauri");
      }),

    async chooseDir(defaultPath?: string): Promise<string | null> {
      let picked: string | string[] | null;
      try {
        picked = await openDialog({
          directory: true,
          multiple: false,
          defaultPath: defaultPath || undefined,
          title: "Папка для сохранения",
        });
      } catch (error) {
        throw toCaptureError(error, "no-tauri");
      }
      return typeof picked === "string" ? picked : null;
    },

    async chooseClipPath(
      defaultName: string,
      defaultDir: string,
    ): Promise<string | null> {
      const defaultPath = defaultDir
        ? joinCapturePath(defaultDir, defaultName)
        : defaultName;
      let picked: string | null;
      try {
        picked = await saveDialog({
          defaultPath,
          title: "Сохранить клип",
          filters: [
            { name: "MP4", extensions: ["mp4"] },
            { name: "MKV", extensions: ["mkv"] },
          ],
        });
      } catch (error) {
        throw toCaptureError(error, "no-tauri");
      }
      return picked ?? null;
    },

    exportClip: (args) =>
      invoke<void>("capture_export_clip", {
        source: args.source,
        start: args.start,
        end: args.end,
        outPath: args.outPath,
      }).catch((error) => {
        throw toCaptureError(error, "export-failed");
      }),

    onExportProgress(cb): Unsubscribe {
      let active = true;
      let unlisten: (() => void) | null = null;
      void listen<{ outTimeMs?: number }>(
        "capture://export-progress",
        (event) => {
          if (!active) return;
          const ms = event.payload?.outTimeMs;
          if (typeof ms === "number" && Number.isFinite(ms)) cb(ms);
        },
      ).then((stop) => {
        unlisten = stop;
        // Unsubscribed before the listener resolved — honour it now.
        if (!active) stop();
      });
      return () => {
        if (!active) return;
        active = false;
        unlisten?.();
      };
    },

    reveal: (path) =>
      invoke<void>("capture_reveal", { path }).catch((error) => {
        throw toCaptureError(error, "reveal-failed");
      }),
  };
}

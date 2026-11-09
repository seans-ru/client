/**
 * A/V sync extension (issue #5, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Audio / subtitle delay shifts (VLC/mpv `audio-delay` / `sub-delay`) with
 * ±50 ms coarse and ±5 ms fine steps, instant apply and a reset. The current
 * shift is remembered PER FILE (keyed by the media url in `ctx.storage`) and
 * restored on reopen; a separate global default is used for files without a
 * saved override (per-file always wins). Settings live in
 * `seans.player.ext.av-sync.*`.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type {
  ExtensionStorage,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";

/** Coarse / fine adjustment steps (issue: ±50 мс, ±5 мс). */
export const AV_SYNC_STEP_COARSE = 50;
export const AV_SYNC_STEP_FINE = 5;

/** Sanity clamp so the UI cannot drift into minutes of delay. */
export const AV_SYNC_LIMIT_MS = 10_000;

export const DEFAULT_AUDIO_MS = 0;
export const DEFAULT_SUB_MS = 0;

const DEFAULTS_KEY = "defaults";
const FILES_KEY = "files";

export type AvDelays = {
  /** Audio delay in milliseconds (positive = audio later). */
  audioMs: number;
  /** Subtitle delay in milliseconds (positive = subs later). */
  subMs: number;
};

export type AvSyncPropertyCommand = {
  /** mpv property name; delays are stored in SECONDS by mpv. */
  name: "audio-delay" | "sub-delay";
  /** Value in seconds (UI state is in ms). */
  value: number;
};

export function clampDelayMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(AV_SYNC_LIMIT_MS, Math.max(-AV_SYNC_LIMIT_MS, Math.round(value)));
}

/** Parse a persisted delays object; unknown shapes fall back to zeros. */
export function parseDelays(raw: unknown): AvDelays {
  const record = (raw ?? {}) as Partial<AvDelays>;
  return {
    audioMs: clampDelayMs(
      typeof record.audioMs === "number" ? record.audioMs : 0,
    ),
    subMs: clampDelayMs(typeof record.subMs === "number" ? record.subMs : 0),
  };
}

/** Parse a persisted per-file map (url → delays); junk is dropped. */
export function parseFileDelays(raw: unknown): Record<string, AvDelays> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, AvDelays> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === "string" && key.length > 0 && value != null) {
      out[key] = parseDelays(value);
    }
  }
  return out;
}

/** mpv wants seconds; the UI works in milliseconds. */
export function avSyncPropertyCommands(delays: AvDelays): AvSyncPropertyCommand[] {
  return [
    { name: "audio-delay", value: clampDelayMs(delays.audioMs) / 1000 },
    { name: "sub-delay", value: clampDelayMs(delays.subMs) / 1000 },
  ];
}

/** "+150" / "−50" / "0" — signed integer, no unit (the row label has it). */
export function formatDelayMs(value: number): string {
  const ms = clampDelayMs(value);
  return ms > 0 ? `+${ms}` : String(ms);
}

export type AvSyncSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getAudioMs(): number;
  getSubMs(): number;
  getDefaultAudioMs(): number;
  getDefaultSubMs(): number;
  /** Media id the current shift is bound to (`null` before the first open). */
  getFileKey(): string | null;
  /** Load per-file shift (or the global default) for a reopened file. */
  openFile(key: string): AvDelays;
  adjustAudio(deltaMs: number): void;
  adjustSub(deltaMs: number): void;
  /** Reset both shifts to 0 (per-file, when a file is open). */
  reset(): void;
  resetAudio(): void;
  resetSub(): void;
  /** Persist the current shifts as the global default for new files. */
  saveAsDefault(): void;
};

export function createAvSyncSettings(storage: ExtensionStorage): AvSyncSettings {
  let defaults = parseDelays(storage.get(DEFAULTS_KEY, null));
  let files = parseFileDelays(storage.get(FILES_KEY, null));
  let current: AvDelays = { ...defaults };
  let fileKey: string | null = null;

  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const persistFiles = () => storage.set(FILES_KEY, files);
  const persistCurrent = () => {
    // Per-file memory: adjustments while a file is open override the default
    // for that file only (issue: «per-файл главнее»).
    if (fileKey != null) {
      files = { ...files, [fileKey]: { ...current } };
      persistFiles();
    }
    notify();
  };
  const setCurrent = (next: AvDelays) => {
    current = {
      audioMs: clampDelayMs(next.audioMs),
      subMs: clampDelayMs(next.subMs),
    };
    persistCurrent();
  };

  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getAudioMs: () => current.audioMs,
    getSubMs: () => current.subMs,
    getDefaultAudioMs: () => defaults.audioMs,
    getDefaultSubMs: () => defaults.subMs,
    getFileKey: () => fileKey,
    openFile(key) {
      // Re-read the shared map so adjustments from any other instance of
      // this settings (e.g. across a remount) are visible.
      files = parseFileDelays(storage.get(FILES_KEY, null));
      fileKey = key;
      const saved = files[key];
      current = saved ? { ...saved } : { ...defaults };
      notify();
      return { ...current };
    },
    adjustAudio(deltaMs) {
      setCurrent({
        audioMs: current.audioMs + clampDelayMs(deltaMs),
        subMs: current.subMs,
      });
    },
    adjustSub(deltaMs) {
      setCurrent({
        audioMs: current.audioMs,
        subMs: current.subMs + clampDelayMs(deltaMs),
      });
    },
    reset() {
      setCurrent({ audioMs: 0, subMs: 0 });
    },
    resetAudio() {
      setCurrent({ audioMs: 0, subMs: current.subMs });
    },
    resetSub() {
      setCurrent({ audioMs: current.audioMs, subMs: 0 });
    },
    saveAsDefault() {
      defaults = { ...current };
      storage.set(DEFAULTS_KEY, defaults);
      notify();
    },
  };
}

export type AvSyncController = {
  settings: AvSyncSettings;
  /** Push the current shifts to mpv (instant, no reload). */
  apply(): void;
  /** Bind to a media id and apply its remembered (or default) shifts. */
  openFile(key: string): void;
  /** Restore zero delays and stop reacting to settings. */
  dispose(): void;
};

/**
 * Settings + mpv wiring shared by the extension and the tests. Every command
 * is fire-and-forget: a bridge/mpv reject is swallowed (the extension must
 * never break the player).
 */
export function createAvSyncController(
  mpv: MpvBridge,
  storage: ExtensionStorage,
): AvSyncController {
  const settings = createAvSyncSettings(storage);
  let disposed = false;
  const apply = (): void => {
    for (const { name, value } of avSyncPropertyCommands({
      audioMs: settings.getAudioMs(),
      subMs: settings.getSubMs(),
    })) {
      void mpv.setProperty(name, value).catch(() => {});
    }
  };
  const stopSettings = settings.subscribe(() => {
    if (!disposed) apply();
  });
  return {
    settings,
    apply,
    openFile(key) {
      // `settings.openFile` notifies, and the settings subscription applies
      // the restored shifts to mpv.
      settings.openFile(key);
    },
    dispose() {
      disposed = true;
      stopSettings();
      for (const { name } of avSyncPropertyCommands({
        audioMs: 0,
        subMs: 0,
      })) {
        void mpv.setProperty(name, 0).catch(() => {});
      }
    },
  };
}

const COARSE_STEPS = [-AV_SYNC_STEP_COARSE, AV_SYNC_STEP_FINE, -AV_SYNC_STEP_FINE, AV_SYNC_STEP_COARSE] as const;

function DelayRow({
  label,
  value,
  onAdjust,
  onReset,
}: {
  label: string;
  value: number;
  onAdjust: (deltaMs: number) => void;
  onReset: () => void;
}): ReactElement {
  return (
    <div className="player-menu-list">
      <div className="player-menu-item" role="group" aria-label={label}>
        <span>
          {label}: {formatDelayMs(value)} мс
        </span>
        <span className="player-menu-row">
          {COARSE_STEPS.map((step) => (
            <button
              key={step}
              type="button"
              className="player-chip"
              aria-label={`${label}: ${step > 0 ? "+" : ""}${step} мс`}
              onClick={() => onAdjust(step)}
            >
              {step > 0 ? `+${step}` : step}
            </button>
          ))}
          <button
            type="button"
            className="player-chip"
            aria-label={`${label}: сброс в 0`}
            onClick={onReset}
          >
            Сброс
          </button>
        </span>
      </div>
    </div>
  );
}

function AvSyncSection({
  settings,
}: {
  settings: AvSyncSettings;
}): ReactElement {
  const audioMs = useSyncExternalStore(settings.subscribe, settings.getAudioMs);
  const subMs = useSyncExternalStore(settings.subscribe, settings.getSubMs);
  const defaultAudioMs = useSyncExternalStore(
    settings.subscribe,
    settings.getDefaultAudioMs,
  );
  const defaultSubMs = useSyncExternalStore(
    settings.subscribe,
    settings.getDefaultSubMs,
  );
  return (
    <section>
      <h4 className="player-menu-title">Синхронизация</h4>
      <DelayRow
        label="Аудио"
        value={audioMs}
        onAdjust={(delta) => settings.adjustAudio(delta)}
        onReset={() => settings.resetAudio()}
      />
      <DelayRow
        label="Субтитры"
        value={subMs}
        onAdjust={(delta) => settings.adjustSub(delta)}
        onReset={() => settings.resetSub()}
      />
      <div className="player-menu-list">
        <button
          type="button"
          className="player-menu-item"
          onClick={() => settings.saveAsDefault()}
        >
          Сделать по умолчанию ({formatDelayMs(defaultAudioMs)} /{" "}
          {formatDelayMs(defaultSubMs)} мс)
        </button>
      </div>
    </section>
  );
}

export const avSync: PlayerExtension = {
  id: "av-sync",
  name: "Синхронизация A/V",
  setup(ctx): Unsubscribe {
    const controller = createAvSyncController(ctx.mpv, ctx.storage);
    const stopOpen = ctx.onOpen((info) => controller.openFile(info.url));
    const stopRow = ctx.ui.add("settings.menu", () => (
      <AvSyncSection settings={controller.settings} />
    ));
    // A file may already be playing when the extension mounts.
    const { url } = ctx.getSnapshot();
    if (url) controller.openFile(url);
    return () => {
      stopRow();
      stopOpen();
      controller.dispose();
    };
  },
};

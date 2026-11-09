/**
 * Playback speed with pitch preservation (issue #8, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Guarantees the mpv `scaletempo` audio filter in the af chain as the NAMED
 * filter `@seans-scaletempo` (`af add` / `af remove` by label, never
 * `setProperty("af")`), so other extensions' filters are never overwritten.
 * The «Сохранять высоту тона» toggle is on by default; switching it off
 * removes the filter AND disables mpv's own auto pitch correction
 * (`audio-pitch-correction`), otherwise mpv would silently keep preserving
 * pitch and the toggle would be inaudible. Restored to mpv default on dispose.
 *
 * Speed presets 0.75×–2× with ±0.05 fine steps go through
 * `ctx.transport.setSpeed` (shared guarded transport). The last chosen speed
 * is persisted in `ctx.storage` (`seans.player.ext.scale-tempo.*`) as a
 * prefill only — it is never auto-applied to playback.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type {
  ExtensionStorage,
  ExtensionTransport,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";

/** Filter label — the remove/toggle reference is `@<label>`. */
export const SCALE_TEMPO_LABEL = "seans-scaletempo";

/** Issue vocabulary: `af-add "@seans-scaletempo:scaletempo"`. */
export const SCALE_TEMPO_FILTER = `@${SCALE_TEMPO_LABEL}:scaletempo`;

export const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export const SPEED_FINE_STEP = 0.05;
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

const PITCH_KEY = "pitch";
const SPEED_KEY = "speed";

/** Label-only reference used by `af remove`. */
export function labelRef(label: string): string {
  return `@${label}`;
}

export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(value * 100) / 100));
}

export function parseSpeed(raw: unknown): number {
  return typeof raw === "number" ? clampSpeed(raw) : 1;
}

/** Fine step from a base speed (±0.05, clamped). */
export function stepSpeed(base: number, direction: 1 | -1): number {
  return clampSpeed(base + direction * SPEED_FINE_STEP);
}

/** "1.25×" — UI label for a speed value. */
export function formatSpeed(value: number): string {
  return `${clampSpeed(value)}×`;
}

export type ScaleTempoFilterCommand = {
  /** Operation of the mpv `af` command (filter-list verbs `add`/`remove`). */
  op: "add" | "remove";
  /** Filter entry: full labeled spec for `add`, `@label` ref for `remove`. */
  entry: string;
};

/**
 * Desired af-chain edits for the pitch toggle. `add` with a used label
 * replaces the filter in place, so re-applying is idempotent; `remove`
 * matches by label and touches no other extension's filters.
 */
export function scaleTempoCommands(enabled: boolean): ScaleTempoFilterCommand[] {
  return enabled
    ? [{ op: "add", entry: SCALE_TEMPO_FILTER }]
    : [{ op: "remove", entry: labelRef(SCALE_TEMPO_LABEL) }];
}

/** Shared settings state for the menu rows and the af-chain sync. */
export type ScaleTempoSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getPitchEnabled(): boolean;
  /** Last user-chosen speed (prefill only — never auto-applied). */
  getLastSpeed(): number;
  setPitchEnabled(next: boolean): void;
  setLastSpeed(speed: number): void;
};

export function createScaleTempoSettings(
  storage: ExtensionStorage,
): ScaleTempoSettings {
  // On by default (issue); only an explicit stored `false` turns it off.
  const storedPitch = storage.get<unknown>(PITCH_KEY, true);
  let pitchEnabled = storedPitch !== false;
  let lastSpeed = parseSpeed(storage.get(SPEED_KEY, 1));
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
    getPitchEnabled: () => pitchEnabled,
    getLastSpeed: () => lastSpeed,
    setPitchEnabled(next) {
      pitchEnabled = Boolean(next);
      storage.set(PITCH_KEY, pitchEnabled);
      notify();
    },
    setLastSpeed(speed) {
      lastSpeed = clampSpeed(speed);
      storage.set(SPEED_KEY, lastSpeed);
      notify();
    },
  };
}

export type ScaleTempoController = {
  settings: ScaleTempoSettings;
  /** Bring the af chain + pitch correction in line with the settings. */
  apply(): void;
  /** Drop our filter, restore mpv default pitch correction, stop reacting. */
  dispose(): void;
};

/**
 * Settings + mpv wiring shared by the extension and the tests. Every command
 * is fire-and-forget: a bridge/mpv reject is swallowed (issue: «ошибка mpv
 * изолирована — расширение не роняет плеер»).
 */
export function createScaleTempoController(
  mpv: MpvBridge,
  storage: ExtensionStorage,
): ScaleTempoController {
  const settings = createScaleTempoSettings(storage);
  let disposed = false;
  const run = (commands: ScaleTempoFilterCommand[]): void => {
    for (const { op, entry } of commands) {
      void mpv.command(["af", op, entry]).catch(() => {});
    }
  };
  const apply = (): void => {
    const enabled = settings.getPitchEnabled();
    run(scaleTempoCommands(enabled));
    // Keep mpv's implicit scaletempo2 in sync with the toggle: off means
    // genuine pitch-shifting playback, on keeps mpv's fallback if `af add`
    // ever fails.
    void mpv.setProperty("audio-pitch-correction", enabled).catch(() => {});
  };
  const stopSettings = settings.subscribe(() => {
    if (!disposed) apply();
  });
  return {
    settings,
    apply,
    dispose() {
      disposed = true;
      stopSettings();
      run(scaleTempoCommands(false));
      void mpv.setProperty("audio-pitch-correction", true).catch(() => {});
    },
  };
}

/** Live playback speed, prefilled from storage, applied via the transport. */
export type SpeedStore = {
  subscribe(cb: () => void): Unsubscribe;
  getSpeed(): number;
  /** Apply immediately (transport) and remember as the last chosen speed. */
  setSpeed(speed: number): void;
  nudge(direction: 1 | -1): void;
  /** Follow the player snapshot (external speed changes included). */
  syncFromSnapshot(speed: number): void;
};

export function createSpeedStore(
  storage: ExtensionStorage,
  transport: ExtensionTransport,
): SpeedStore {
  const settings = createScaleTempoSettings(storage);
  // Prefill from the persisted value; the first snapshot replaces it with
  // the real playback speed (never force-applied to the transport).
  let speed = settings.getLastSpeed();
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
    getSpeed: () => speed,
    setSpeed(next) {
      speed = clampSpeed(next);
      settings.setLastSpeed(speed);
      void transport.setSpeed(speed).catch(() => {});
      notify();
    },
    nudge(direction) {
      // Nudge from the live speed so repeated taps step predictably.
      const base = speed;
      const next = stepSpeed(base, direction);
      speed = next;
      settings.setLastSpeed(next);
      void transport.setSpeed(next).catch(() => {});
      notify();
    },
    syncFromSnapshot(next) {
      const parsed = clampSpeed(next);
      if (parsed !== speed) {
        speed = parsed;
        notify();
      }
    },
  };
}

function ScaleTempoSection({
  settings,
  speedStore,
}: {
  settings: ScaleTempoSettings;
  speedStore: SpeedStore;
}): ReactElement {
  const pitchEnabled = useSyncExternalStore(
    settings.subscribe,
    settings.getPitchEnabled,
  );
  const speed = useSyncExternalStore(speedStore.subscribe, speedStore.getSpeed);
  return (
    <section>
      <h4 className="player-menu-title">Скорость воспроизведения</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={pitchEnabled}
          className={`player-menu-item${pitchEnabled ? " player-menu-item-active" : ""}`}
          onClick={() => settings.setPitchEnabled(!pitchEnabled)}
        >
          {pitchEnabled
            ? "Сохранять высоту тона: включено"
            : "Сохранять высоту тона: выключено"}
        </button>
        <p className="player-menu-empty">Скорость: {formatSpeed(speed)}</p>
      </div>
      <div className="player-menu-row" role="group" aria-label="Пресеты скорости">
        {SPEED_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            role="menuitemradio"
            aria-checked={speed === preset}
            className={`player-chip${speed === preset ? " player-chip-active" : ""}`}
            onClick={() => speedStore.setSpeed(preset)}
          >
            {formatSpeed(preset)}
          </button>
        ))}
      </div>
      <div className="player-menu-row" role="group" aria-label="Точная настройка скорости">
        <button
          type="button"
          className="player-chip"
          aria-label="Скорость минус 0.05"
          onClick={() => speedStore.nudge(-1)}
        >
          −0.05
        </button>
        <button
          type="button"
          className="player-chip"
          aria-label="Скорость плюс 0.05"
          onClick={() => speedStore.nudge(1)}
        >
          +0.05
        </button>
      </div>
    </section>
  );
}

export const scaleTempo: PlayerExtension = {
  id: "scale-tempo",
  name: "Скорость воспроизведения",
  setup(ctx): Unsubscribe {
    const controller = createScaleTempoController(ctx.mpv, ctx.storage);
    const speedStore = createSpeedStore(ctx.storage, ctx.transport);
    const stopOpen = ctx.onOpen(() => controller.apply());
    const stopSnapshot = ctx.onSnapshot((snapshot) =>
      speedStore.syncFromSnapshot(snapshot.speed),
    );
    const stopRow = ctx.ui.add("settings.menu", () => (
      <ScaleTempoSection
        settings={controller.settings}
        speedStore={speedStore}
      />
    ));
    // A file may already be playing when the extension mounts.
    controller.apply();
    speedStore.syncFromSnapshot(ctx.getSnapshot().speed);
    return () => {
      stopRow();
      stopSnapshot();
      stopOpen();
      controller.dispose();
    };
  },
};

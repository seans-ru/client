/**
 * Volume processor extension (issue #3, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Two sound modes as NAMED mpv audio filters, so the af chain of other
 * extensions is never overwritten (no `setProperty("af")`):
 *
 * - "Нормализация громкости" — `loudnorm` (EBU R128: I=-16, TP=-1.5, LRA=11),
 * - "Ночной режим" — `acompressor` dynamic range compression with
 *   "мягкий" / "сильный" presets (threshold/ratio).
 *
 * Filters are applied on file open and immediately on settings change;
 * disabling removes the filter, `dispose` restores the original chain.
 * mpv errors are swallowed — the extension must never break the player.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type {
  ExtensionStorage,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";

export type NightMode = "off" | "soft" | "strong";

export const NIGHT_MODES: readonly NightMode[] = ["off", "soft", "strong"];

const NORMALIZATION_KEY = "normalization";
const NIGHT_MODE_KEY = "nightMode";

/** Filter labels — the remove/toggle reference is `@<label>`. */
export const LOUDNORM_LABEL = "seans-vp-loudnorm";
export const NIGHT_LABEL = "seans-vp-night";

/** EBU R128 cinema loudness targets (issue #3). */
export const LOUDNORM_FILTER =
  `@${LOUDNORM_LABEL}:lavfi=[loudnorm=I=-16:TP=-1.5:LRA=11]`;

/**
 * `acompressor` presets (issue: порог/ratio). `threshold` is linear
 * amplitude — 0.125 is -18 dBFS, 0.2 is about -14 dBFS. Both modes share
 * the `NIGHT_LABEL`, so switching a preset replaces the filter in place.
 */
const NIGHT_FILTERS: Record<Exclude<NightMode, "off">, string> = {
  soft: `@${NIGHT_LABEL}:lavfi=[acompressor=threshold=0.2:ratio=2:` +
    `attack=15:release=250:makeup=1.25]`,
  strong: `@${NIGHT_LABEL}:lavfi=[acompressor=threshold=0.1:ratio=8:` +
    `attack=5:release=400:makeup=2]`,
};

export function nightFilter(mode: Exclude<NightMode, "off">): string {
  return NIGHT_FILTERS[mode];
}

/** Label-only reference used by `af remove`. */
export function labelRef(label: string): string {
  return `@${label}`;
}

export function parseNightMode(raw: unknown): NightMode {
  return raw === "soft" || raw === "strong" ? raw : "off";
}

export type VolumeFilterState = {
  normalization: boolean;
  nightMode: NightMode;
};

export type FilterCommand = {
  /** mpv `af` list operation (maps to the `af-add` / `af-remove` verbs). */
  op: "add" | "remove";
  /** Filter entry: full labeled spec for `add`, `@label` ref for `remove`. */
  entry: string;
};

/**
 * Desired af-chain edits for a settings snapshot. `add` with a used label
 * replaces the filter, so re-applying is idempotent; `remove` matches by
 * label and touches no other extension's filters.
 */
export function volumeFilterCommands(
  state: VolumeFilterState,
): FilterCommand[] {
  return [
    state.normalization
      ? { op: "add", entry: LOUDNORM_FILTER }
      : { op: "remove", entry: labelRef(LOUDNORM_LABEL) },
    state.nightMode === "off"
      ? { op: "remove", entry: labelRef(NIGHT_LABEL) }
      : { op: "add", entry: nightFilter(state.nightMode) },
  ];
}

/** Shared settings state for the menu row and the af-chain sync. */
export type VolumeSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getNormalization(): boolean;
  getNightMode(): NightMode;
  setNormalization(next: boolean): void;
  setNightMode(mode: NightMode): void;
};

export function createVolumeSettings(
  storage: ExtensionStorage,
): VolumeSettings {
  let normalization = Boolean(storage.get(NORMALIZATION_KEY, false));
  let nightMode = parseNightMode(storage.get(NIGHT_MODE_KEY, "off"));
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
    getNormalization: () => normalization,
    getNightMode: () => nightMode,
    setNormalization(next) {
      normalization = Boolean(next);
      storage.set(NORMALIZATION_KEY, normalization);
      notify();
    },
    setNightMode(mode) {
      nightMode = parseNightMode(mode);
      storage.set(NIGHT_MODE_KEY, nightMode);
      notify();
    },
  };
}

export type VolumeController = {
  settings: VolumeSettings;
  /** Bring the af chain in line with the current settings. */
  apply(): void;
  /** Drop our filters (original sound) and stop reacting to settings. */
  dispose(): void;
};

/**
 * Settings + mpv wiring shared by the extension and the tests. Every command
 * is fire-and-forget: a bridge/mpv reject is swallowed (issue: «ошибка mpv
 * изолирована — расширение не роняет плеер»).
 */
export function createVolumeController(
  mpv: MpvBridge,
  storage: ExtensionStorage,
): VolumeController {
  const settings = createVolumeSettings(storage);
  const run = (commands: FilterCommand[]): void => {
    for (const { op, entry } of commands) {
      void mpv.command(["af", op, entry]).catch(() => {});
    }
  };
  const apply = (): void =>
    run(
      volumeFilterCommands({
        normalization: settings.getNormalization(),
        nightMode: settings.getNightMode(),
      }),
    );
  const stopSettings = settings.subscribe(apply);
  return {
    settings,
    apply,
    dispose() {
      stopSettings();
      run([
        { op: "remove", entry: labelRef(LOUDNORM_LABEL) },
        { op: "remove", entry: labelRef(NIGHT_LABEL) },
      ]);
    },
  };
}

const NIGHT_MODE_LABELS: Record<NightMode, string> = {
  off: "Выкл",
  soft: "Мягкий",
  strong: "Сильный",
};

function VolumeProcessorRow({
  settings,
}: {
  settings: VolumeSettings;
}): ReactElement {
  const normalization = useSyncExternalStore(
    settings.subscribe,
    settings.getNormalization,
  );
  const nightMode = useSyncExternalStore(
    settings.subscribe,
    settings.getNightMode,
  );
  return (
    <section>
      <h4 className="player-menu-title">Обработка звука</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={normalization}
          className={`player-menu-item${normalization ? " player-menu-item-active" : ""}`}
          onClick={() => settings.setNormalization(!normalization)}
        >
          {normalization
            ? "Нормализация громкости: включено"
            : "Нормализация громкости: выключено"}
        </button>
      </div>
      <h4 className="player-menu-title">Ночной режим</h4>
      <div className="player-menu-row">
        {NIGHT_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="menuitemradio"
            aria-checked={mode === nightMode}
            className={`player-chip${mode === nightMode ? " player-chip-active" : ""}`}
            onClick={() => settings.setNightMode(mode)}
          >
            {NIGHT_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
    </section>
  );
}

export const volumeProcessor: PlayerExtension = {
  id: "volume-processor",
  name: "Обработка звука",
  setup(ctx): Unsubscribe {
    const controller = createVolumeController(ctx.mpv, ctx.storage);
    const stopOpen = ctx.onOpen(() => controller.apply());
    const stopRow = ctx.ui.add("settings.menu", () => (
      <VolumeProcessorRow settings={controller.settings} />
    ));
    // A file may already be playing when the extension mounts.
    controller.apply();
    return () => {
      stopRow();
      stopOpen();
      controller.dispose();
    };
  },
};

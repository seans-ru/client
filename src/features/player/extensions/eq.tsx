/**
 * Equalizer extension (issue #4, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * 10-band graphic EQ as a NAMED mpv audio filter `@seans-eq`, so the af
 * chain of other extensions (volume processor) is never overwritten:
 * `af add` / `af remove` by label, never `setProperty("af")`.
 *
 * Implementation: one `firequalizer` FIR filter with `gain_entry` points at
 * 31 Hz … 16 kHz (±12 dB). Presets: «Плоский», «Кино», «Музыка», «Голос»,
 * «Ночь» + custom (slider edits → «Свой», persisted in ctx.storage under
 * `seans.player.ext.eq.*`). Applied on file open and immediately on settings
 * change; disabling removes the filter, `dispose` restores the original
 * chain. mpv errors are swallowed — the extension must never break the player.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type {
  ExtensionStorage,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";

/** Octave-spaced graphic-EQ center frequencies (Hz), low → high. */
export const EQ_BANDS = [
  31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const;

export const EQ_BAND_COUNT = EQ_BANDS.length;
export const EQ_MIN_GAIN = -12;
export const EQ_MAX_GAIN = 12;

/** Filter label — the remove/toggle reference is `@<label>`. */
export const EQ_LABEL = "seans-eq";

export type EqPresetId =
  | "flat"
  | "cinema"
  | "music"
  | "voice"
  | "night"
  | "custom";

export const EQ_NAMED_PRESETS = [
  "flat",
  "cinema",
  "music",
  "voice",
  "night",
] as const;

export type EqNamedPreset = (typeof EQ_NAMED_PRESETS)[number];

/**
 * Named preset gain curves (dB per band). `custom` is not a curve — its
 * gains live in settings state and storage.
 */
export const EQ_PRESETS: Record<EqNamedPreset, readonly number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // Cinema: bass + treble lift, slight mid scoop (V-curve).
  cinema: [6, 5, 3, 1, 0, 0, 1, 2, 4, 5],
  // Music: classic smiley curve.
  music: [5, 4, 2, 0, -1, -1, 0, 2, 3, 5],
  // Voice: dialogue presence — mids up, extremes down.
  voice: [-3, -2, 0, 3, 5, 5, 4, 2, 0, -3],
  // Night: soft late-night curve — gentle mids, rolled-off extremes.
  night: [-4, -3, -1, 1, 2, 2, 1, 0, -2, -4],
};

export const EQ_PRESET_LABELS: Record<EqPresetId, string> = {
  flat: "Плоский",
  cinema: "Кино",
  music: "Музыка",
  voice: "Голос",
  night: "Ночь",
  custom: "Свой",
};

const ENABLED_KEY = "enabled";
const PRESET_KEY = "preset";
const GAINS_KEY = "gains";

export function clampGain(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(EQ_MAX_GAIN, Math.max(EQ_MIN_GAIN, value));
}

export function parsePresetId(raw: unknown): EqPresetId {
  if (raw === "custom") return "custom";
  if (typeof raw === "string" && (EQ_NAMED_PRESETS as readonly string[]).includes(raw)) {
    return raw as EqNamedPreset;
  }
  return "flat";
}

/** Sanitize a persisted gains array to exactly EQ_BAND_COUNT clamped numbers. */
export function parseGains(raw: unknown): number[] {
  const fallback = [...EQ_PRESETS.flat];
  if (!Array.isArray(raw)) return fallback;
  return EQ_BANDS.map((_, i) => {
    const value = raw[i];
    return typeof value === "number" ? clampGain(value) : fallback[i] ?? 0;
  });
}

/**
 * Labeled firequalizer filter string. `add` with a used label replaces the
 * filter in place, so re-applying is idempotent.
 */
export function eqFilter(gains: readonly number[]): string {
  const entries = EQ_BANDS.map(
    (freq, i) => `entry(${freq},${clampGain(gains[i] ?? 0)})`,
  ).join(";");
  return `@${EQ_LABEL}:lavfi=[firequalizer=gain_entry='${entries}']`;
}

/** Label-only reference used by `af remove`. */
export function labelRef(label: string): string {
  return `@${label}`;
}

export type EqFilterCommand = {
  /** Operation of the mpv `af` command (filter-list verbs `add`/`remove`). */
  op: "add" | "remove";
  /** Filter entry: full labeled spec for `add`, `@label` ref for `remove`. */
  entry: string;
};

export type EqState = {
  enabled: boolean;
  preset: EqPresetId;
  gains: number[];
};

/** Desired af-chain edits for a settings snapshot. */
export function eqFilterCommands(state: EqState): EqFilterCommand[] {
  return state.enabled
    ? [{ op: "add", entry: eqFilter(state.gains) }]
    : [{ op: "remove", entry: labelRef(EQ_LABEL) }];
}

export function initialEqState(storage: ExtensionStorage): EqState {
  const enabled = Boolean(storage.get(ENABLED_KEY, false));
  const preset = parsePresetId(storage.get(PRESET_KEY, "flat"));
  const storedGains = parseGains(storage.get(GAINS_KEY, null));
  // A named preset wins over stale gains so the UI and curve stay in sync.
  const gains =
    preset === "custom" ? storedGains : [...EQ_PRESETS[preset]];
  return { enabled, preset, gains };
}

/** Shared settings state for the menu row and the af-chain sync. */
export type EqSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getEnabled(): boolean;
  getPreset(): EqPresetId;
  getGains(): readonly number[];
  setEnabled(next: boolean): void;
  setPreset(id: EqNamedPreset): void;
  setBandGain(index: number, gain: number): void;
};

/** One settings store per storage instance — player row and settings section share state. */
const settingsByStorage = new WeakMap<ExtensionStorage, EqSettings>();

export function createEqSettings(storage: ExtensionStorage): EqSettings {
  const cached = settingsByStorage.get(storage);
  if (cached) return cached;
  let state = initialEqState(storage);
  const listeners = new Set<() => void>();
  const persist = () => {
    storage.set(ENABLED_KEY, state.enabled);
    storage.set(PRESET_KEY, state.preset);
    storage.set(GAINS_KEY, state.gains);
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const commit = (next: EqState) => {
    state = next;
    persist();
    notify();
  };
  const settings: EqSettings = {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getEnabled: () => state.enabled,
    getPreset: () => state.preset,
    getGains: () => state.gains,
    setEnabled(next) {
      commit({ ...state, enabled: Boolean(next) });
    },
    setPreset(id) {
      const preset = parsePresetId(id);
      if (preset === "custom") return;
      commit({ ...state, preset, gains: [...EQ_PRESETS[preset]] });
    },
    setBandGain(index, gain) {
      if (index < 0 || index >= EQ_BAND_COUNT) return;
      const gains = [...state.gains];
      gains[index] = clampGain(gain);
      commit({ ...state, preset: "custom", gains });
    },
  };
  settingsByStorage.set(storage, settings);
  return settings;
}

export type EqController = {
  settings: EqSettings;
  /** Bring the af chain in line with the current settings. */
  apply(): void;
  /** Drop our filter (original sound) and stop reacting to settings. */
  dispose(): void;
};

/**
 * Settings + mpv wiring shared by the extension and the tests. Every command
 * is fire-and-forget: a bridge/mpv reject is swallowed (issue: «ошибка mpv
 * изолирована — расширение не роняет плеер»).
 */
export function createEqController(
  mpv: MpvBridge,
  storage: ExtensionStorage,
): EqController {
  const settings = createEqSettings(storage);
  const run = (commands: EqFilterCommand[]): void => {
    for (const { op, entry } of commands) {
      void mpv.command(["af", op, entry]).catch(() => {});
    }
  };
  const apply = (): void =>
    run(
      eqFilterCommands({
        enabled: settings.getEnabled(),
        preset: settings.getPreset(),
        gains: [...settings.getGains()],
      }),
    );
  const stopSettings = settings.subscribe(apply);
  return {
    settings,
    apply,
    dispose() {
      stopSettings();
      run([{ op: "remove", entry: labelRef(EQ_LABEL) }]);
    },
  };
}

/** Settings section for the equalizer (player settings menu + settings screen). */
export function EqSection({ settings }: { settings: EqSettings }): ReactElement {
  const enabled = useSyncExternalStore(
    settings.subscribe,
    settings.getEnabled,
    settings.getEnabled,
  );
  const preset = useSyncExternalStore(
    settings.subscribe,
    settings.getPreset,
    settings.getPreset,
  );
  const gains = useSyncExternalStore(
    settings.subscribe,
    // Readonly array identity changes only when gains are replaced.
    () => settings.getGains() as readonly number[],
    () => settings.getGains() as readonly number[],
  );
  return (
    <section>
      <h4 className="player-menu-title">Эквалайзер</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={enabled}
          className={`player-menu-item${enabled ? " player-menu-item-active" : ""}`}
          onClick={() => settings.setEnabled(!enabled)}
        >
          {enabled ? "Эквалайзер: включено" : "Эквалайзер: выключено"}
        </button>
      </div>
      {enabled ? (
        <>
          <div className="player-menu-row" role="group" aria-label="Пресеты эквалайзера">
            {EQ_NAMED_PRESETS.map((id) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={preset === id}
                className={`player-chip${preset === id ? " player-chip-active" : ""}`}
                onClick={() => settings.setPreset(id)}
              >
                {EQ_PRESET_LABELS[id]}
              </button>
            ))}
            {preset === "custom" ? (
              <span
                className="player-chip player-chip-active"
                aria-label="Пользовательский пресет"
              >
                {EQ_PRESET_LABELS.custom}
              </span>
            ) : null}
          </div>
          <div className="eq-bands" role="group" aria-label="Полосы эквалайзера">
            {EQ_BANDS.map((freq, index) => {
              const gain = gains[index] ?? 0;
              const label =
                freq >= 1000 ? `${freq / 1000}k` : String(freq);
              return (
                <label key={freq} className="eq-band" title={`${freq} Hz`}>
                  <span className="eq-band-value">
                    {gain > 0 ? `+${gain}` : gain}
                  </span>
                  <input
                    type="range"
                    min={EQ_MIN_GAIN}
                    max={EQ_MAX_GAIN}
                    step={1}
                    value={gain}
                    aria-label={`${freq} Hz`}
                    onChange={(event) =>
                      settings.setBandGain(index, Number(event.target.value))
                    }
                  />
                  <span className="eq-band-label">{label}</span>
                </label>
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}

export const equalizer: PlayerExtension = {
  id: "eq",
  name: "Эквалайзер",
  setup(ctx): Unsubscribe {
    const controller = createEqController(ctx.mpv, ctx.storage);
    const stopOpen = ctx.onOpen(() => controller.apply());
    const stopRow = ctx.ui.add("settings.menu", () => (
      <EqSection settings={controller.settings} />
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

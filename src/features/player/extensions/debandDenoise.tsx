/**
 * Deband & denoise extension (issue #12, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Banding in dark scenes and compression noise — the classic mpv tuning pair:
 *
 * - «Deband»: the GPU option `deband` plus its parameters
 *   (`deband-iterations` / `deband-threshold` / `deband-range` /
 *   `deband-grain`) through `ctx.mpv.setProperty`, with the presets
 *   «Мягкий» / «Стандарт» / «Сильный» (issue #12 vocabulary).
 * - «Шумоподавление»: the NAMED video filter `@seans-denoise`
 *   (`vf add` / `vf remove`, `lavfi=[hqdn3d=…]`) so the vf chain of other
 *   extensions (e.g. `@seans-sharpen`) is never overwritten. `hqdn3d` runs on
 *   the CPU — on slow machines the «Сильный» preset is capped to «Стандарт»
 *   so playback never stalls (issue #12 acceptance).
 *
 * The two blocks are independent and apply instantly. Settings apply on file
 * open too; `dispose` returns the mpv deband defaults and drops the filter.
 * mpv errors are swallowed — the extension must never break the player.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type {
  ExtensionStorage,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";

export type DebandPreset = "soft" | "standard" | "strong";
export type DenoisePreset = "soft" | "standard" | "strong";

export const DEBAND_PRESETS: readonly DebandPreset[] = [
  "soft",
  "standard",
  "strong",
];
export const DENOISE_PRESETS: readonly DenoisePreset[] = [
  "soft",
  "standard",
  "strong",
];

/** Filter label — the remove/toggle reference is `@<label>`. */
export const DENOISE_LABEL = "seans-denoise";

/** Label-only reference used by `vf remove`. */
export function labelRef(label: string): string {
  return `@${label}`;
}

export type DebandParams = {
  iterations: number;
  threshold: number;
  range: number;
  grain: number;
};

export type DebandPropertyName =
  | "deband"
  | "deband-iterations"
  | "deband-threshold"
  | "deband-range"
  | "deband-grain";

export const DEBAND_PROPERTY_NAMES: readonly DebandPropertyName[] = [
  "deband",
  "deband-iterations",
  "deband-threshold",
  "deband-range",
  "deband-grain",
];

/**
 * Preset parameters (issue #12). «Стандарт» is mpv's own option defaults
 * (DOCS/man/options.rst: iterations 1, threshold 48, range 16, grain 32);
 * «Сильный» adds an iteration and compensates the radius downward, as the
 * manual recommends when raising `--deband-iterations`.
 */
export const DEBAND_PRESET_PARAMS: Record<DebandPreset, DebandParams> = {
  soft: { iterations: 1, threshold: 32, range: 16, grain: 16 },
  standard: { iterations: 1, threshold: 48, range: 16, grain: 32 },
  strong: { iterations: 2, threshold: 64, range: 12, grain: 48 },
};

/** mpv defaults — `dispose` and the disabled state write them back. */
export const MPV_DEFAULT_DEBAND: DebandParams = {
  iterations: 1,
  threshold: 48,
  range: 16,
  grain: 32,
};

/**
 * `hqdn3d` presets: luma_spatial:chroma_spatial:luma_tmp:chroma_tmp.
 * «Стандарт» is the filter's own default ratio (4:3:6:4.5).
 */
const DENOISE_FILTERS: Record<DenoisePreset, string> = {
  soft: `@${DENOISE_LABEL}:lavfi=[hqdn3d=2:1.5:3:2.25]`,
  standard: `@${DENOISE_LABEL}:lavfi=[hqdn3d=4:3:6:4.5]`,
  strong: `@${DENOISE_LABEL}:lavfi=[hqdn3d=8:6:12:9]`,
};

export function denoiseFilter(preset: DenoisePreset): string {
  return DENOISE_FILTERS[preset];
}

/** Threshold for the slow-machine guard (issue #12: «порог/предупреждение»). */
export const SLOW_CPU_MAX_CORES = 2;

export function isSlowCpu(cpuCores: number): boolean {
  return Number.isFinite(cpuCores) && cpuCores > 0 && cpuCores <= SLOW_CPU_MAX_CORES;
}

/**
 * Applied denoise preset: «Сильный» is capped to «Стандарт» on slow CPUs so
 * the CPU filter cannot stall playback.
 */
export function resolveDenoisePreset(
  preset: DenoisePreset,
  cpuCores: number,
): DenoisePreset {
  return preset === "strong" && isSlowCpu(cpuCores) ? "standard" : preset;
}

/** Warning shown under the denoise presets (null = nothing to warn about). */
export function denoiseWarning(
  preset: DenoisePreset,
  cpuCores: number,
): string | null {
  if (preset === "strong" && isSlowCpu(cpuCores)) {
    return "Слабый CPU: «Сильный» применяется как «Стандарт», чтобы не тормозить.";
  }
  return null;
}

export function parseDebandPreset(raw: unknown): DebandPreset {
  return raw === "soft" || raw === "strong" ? raw : "standard";
}

export function parseDenoisePreset(raw: unknown): DenoisePreset {
  return raw === "soft" || raw === "strong" ? raw : "standard";
}

export type DebandDenoiseState = {
  debandEnabled: boolean;
  debandPreset: DebandPreset;
  denoiseEnabled: boolean;
  denoisePreset: DenoisePreset;
};

export type DebandDenoiseCommand =
  | { op: "set"; name: DebandPropertyName; value: boolean | number }
  | { op: "filter"; filterOp: "add" | "remove"; entry: string };

function debandSetCommands(
  enabled: boolean,
  preset: DebandPreset,
): DebandDenoiseCommand[] {
  const params = enabled ? DEBAND_PRESET_PARAMS[preset] : MPV_DEFAULT_DEBAND;
  return [
    { op: "set", name: "deband", value: enabled },
    { op: "set", name: "deband-iterations", value: params.iterations },
    { op: "set", name: "deband-threshold", value: params.threshold },
    { op: "set", name: "deband-range", value: params.range },
    { op: "set", name: "deband-grain", value: params.grain },
  ];
}

function denoiseFilterCommands(
  enabled: boolean,
  preset: DenoisePreset,
  cpuCores: number,
): DebandDenoiseCommand[] {
  return [
    enabled
      ? {
          op: "filter",
          filterOp: "add",
          entry: denoiseFilter(resolveDenoisePreset(preset, cpuCores)),
        }
      : { op: "filter", filterOp: "remove", entry: labelRef(DENOISE_LABEL) },
  ];
}

/**
 * Desired mpv edits for a settings snapshot: the deband option family plus
 * the named hqdn3d filter. `add` with a used label replaces the filter, so
 * re-applying is idempotent and never touches `@seans-sharpen` / `@seans-eq`.
 */
export function debandDenoiseCommands(
  state: DebandDenoiseState,
  cpuCores: number,
): DebandDenoiseCommand[] {
  return [
    ...debandSetCommands(state.debandEnabled, state.debandPreset),
    ...denoiseFilterCommands(state.denoiseEnabled, state.denoisePreset, cpuCores),
  ];
}

/** `dispose` edits: deband back to the mpv defaults, filter dropped. */
export function debandDenoiseDisposeCommands(): DebandDenoiseCommand[] {
  return [
    ...debandSetCommands(false, "standard"),
    { op: "filter", filterOp: "remove", entry: labelRef(DENOISE_LABEL) },
  ];
}

const DEBAND_ENABLED_KEY = "debandEnabled";
const DEBAND_PRESET_KEY = "debandPreset";
const DENOISE_ENABLED_KEY = "denoiseEnabled";
const DENOISE_PRESET_KEY = "denoisePreset";

/** Shared settings state for the menu rows and the mpv sync. */
export type DebandDenoiseSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getDebandEnabled(): boolean;
  getDebandPreset(): DebandPreset;
  getDenoiseEnabled(): boolean;
  getDenoisePreset(): DenoisePreset;
  setDebandEnabled(enabled: boolean): void;
  setDebandPreset(preset: DebandPreset): void;
  setDenoiseEnabled(enabled: boolean): void;
  setDenoisePreset(preset: DenoisePreset): void;
};

export function createDebandDenoiseSettings(
  storage: ExtensionStorage,
): DebandDenoiseSettings {
  let debandEnabled = Boolean(storage.get(DEBAND_ENABLED_KEY, false));
  let debandPreset = parseDebandPreset(storage.get(DEBAND_PRESET_KEY, "standard"));
  let denoiseEnabled = Boolean(storage.get(DENOISE_ENABLED_KEY, false));
  let denoisePreset = parseDenoisePreset(
    storage.get(DENOISE_PRESET_KEY, "standard"),
  );
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
    getDebandEnabled: () => debandEnabled,
    getDebandPreset: () => debandPreset,
    getDenoiseEnabled: () => denoiseEnabled,
    getDenoisePreset: () => denoisePreset,
    setDebandEnabled(enabled) {
      debandEnabled = Boolean(enabled);
      storage.set(DEBAND_ENABLED_KEY, debandEnabled);
      notify();
    },
    setDebandPreset(preset) {
      debandPreset = parseDebandPreset(preset);
      storage.set(DEBAND_PRESET_KEY, debandPreset);
      notify();
    },
    setDenoiseEnabled(enabled) {
      denoiseEnabled = Boolean(enabled);
      storage.set(DENOISE_ENABLED_KEY, denoiseEnabled);
      notify();
    },
    setDenoisePreset(preset) {
      denoisePreset = parseDenoisePreset(preset);
      storage.set(DENOISE_PRESET_KEY, denoisePreset);
      notify();
    },
  };
}

export type DebandDenoiseController = {
  settings: DebandDenoiseSettings;
  /** Bring the deband options and the vf chain in line with the settings. */
  apply(): void;
  /** Return deband to the mpv defaults, drop our filter, stop reacting. */
  dispose(): void;
};

/**
 * Settings + mpv wiring shared by the extension and the tests. Every call is
 * fire-and-forget: a bridge/mpv reject is swallowed (issue: «ошибка mpv
 * изолирована — расширение не роняет плеер»).
 */
export function createDebandDenoiseController(
  mpv: MpvBridge,
  storage: ExtensionStorage,
  cpuCores: number,
): DebandDenoiseController {
  const settings = createDebandDenoiseSettings(storage);
  const run = (commands: DebandDenoiseCommand[]): void => {
    for (const command of commands) {
      if (command.op === "set") {
        void mpv.setProperty(command.name, command.value).catch(() => {});
      } else {
        void mpv.command(["vf", command.filterOp, command.entry]).catch(() => {});
      }
    }
  };
  const apply = (): void =>
    run(
      debandDenoiseCommands(
        {
          debandEnabled: settings.getDebandEnabled(),
          debandPreset: settings.getDebandPreset(),
          denoiseEnabled: settings.getDenoiseEnabled(),
          denoisePreset: settings.getDenoisePreset(),
        },
        cpuCores,
      ),
    );
  const stopSettings = settings.subscribe(apply);
  return {
    settings,
    apply,
    dispose() {
      stopSettings();
      run(debandDenoiseDisposeCommands());
    },
  };
}

const PRESET_LABELS: Record<DebandPreset, string> = {
  soft: "Мягкий",
  standard: "Стандарт",
  strong: "Сильный",
};

function DebandDenoiseSection({
  settings,
  cpuCores,
}: {
  settings: DebandDenoiseSettings;
  cpuCores: number;
}): ReactElement {
  const debandEnabled = useSyncExternalStore(
    settings.subscribe,
    settings.getDebandEnabled,
  );
  const debandPreset = useSyncExternalStore(
    settings.subscribe,
    settings.getDebandPreset,
  );
  const denoiseEnabled = useSyncExternalStore(
    settings.subscribe,
    settings.getDenoiseEnabled,
  );
  const denoisePreset = useSyncExternalStore(
    settings.subscribe,
    settings.getDenoisePreset,
  );
  const warning = denoiseWarning(denoisePreset, cpuCores);
  return (
    <section>
      <h4 className="player-menu-title">Deband</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={debandEnabled}
          className={`player-menu-item${debandEnabled ? " player-menu-item-active" : ""}`}
          onClick={() => settings.setDebandEnabled(!debandEnabled)}
        >
          {debandEnabled ? "Deband: включён" : "Deband: выключен"}
        </button>
      </div>
      {debandEnabled ? (
        <>
          <div
            className="player-menu-row"
            role="group"
            aria-label="Пресеты deband"
          >
            {DEBAND_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                role="menuitemradio"
                aria-checked={preset === debandPreset}
                className={`player-chip${preset === debandPreset ? " player-chip-active" : ""}`}
                onClick={() => settings.setDebandPreset(preset)}
              >
                {PRESET_LABELS[preset]}
              </button>
            ))}
          </div>
          <p className="player-menu-empty">
            Убирает полосы в тёмных сценах (GPU).
          </p>
        </>
      ) : null}
      <h4 className="player-menu-title">Шумоподавление</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={denoiseEnabled}
          className={`player-menu-item${denoiseEnabled ? " player-menu-item-active" : ""}`}
          onClick={() => settings.setDenoiseEnabled(!denoiseEnabled)}
        >
          {denoiseEnabled
            ? "Шумоподавление: включено"
            : "Шумоподавление: выключено"}
        </button>
      </div>
      {denoiseEnabled ? (
        <>
          <div
            className="player-menu-row"
            role="group"
            aria-label="Пресеты шумоподавления"
          >
            {DENOISE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                role="menuitemradio"
                aria-checked={preset === denoisePreset}
                className={`player-chip${preset === denoisePreset ? " player-chip-active" : ""}`}
                onClick={() => settings.setDenoisePreset(preset)}
              >
                {PRESET_LABELS[preset]}
              </button>
            ))}
          </div>
          <p className="player-menu-empty">
            hqdn3d работает на CPU — сильные пресеты нагружают слабые машины.
            {warning ? ` ${warning}` : ""}
          </p>
        </>
      ) : null}
    </section>
  );
}

/** `navigator.hardwareConcurrency`, defaulting to a comfortable 4. */
export function detectCpuCores(): number {
  return globalThis.navigator?.hardwareConcurrency ?? 4;
}

export const debandDenoise: PlayerExtension = {
  id: "deband-denoise",
  name: "Deband и шумоподавление",
  setup(ctx): Unsubscribe {
    const cpuCores = detectCpuCores();
    const controller = createDebandDenoiseController(
      ctx.mpv,
      ctx.storage,
      cpuCores,
    );
    const stopOpen = ctx.onOpen(() => controller.apply());
    const stopRow = ctx.ui.add("settings.menu", () => (
      <DebandDenoiseSection
        settings={controller.settings}
        cpuCores={cpuCores}
      />
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

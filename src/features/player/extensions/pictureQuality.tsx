/**
 * Picture quality extension (issue #11, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Upscaling and sharpening for old / low-bitrate rips — the picture controls
 * people know from mpv/PotPlayer:
 *
 * - "Масштабирование" presets set the mpv scalers `scale` / `cscale` / `dscale`
 *   through `ctx.mpv.setProperty` (issue vocabulary: bilinear / lanczos /
 *   spline36 / ewa_lanczos).
 * - "Резкость" — stepped `unsharp` as a NAMED video filter `@seans-sharpen`
 *   (`vf add` / `vf remove`, `lavfi=[unsharp=…]`), so the vf chain of other
 *   extensions is never overwritten: a new level replaces the filter in place
 *   and disabling removes it without traces.
 *
 * Settings apply on file open and instantly on change; `dispose` returns the
 * scalers to the mpv defaults and drops the sharpen filter. mpv errors are
 * swallowed — the extension must never break the player.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type {
  ExtensionStorage,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";

export type ScalePreset = "fast" | "quality" | "max";
export type SharpenLevel = "off" | "weak" | "medium" | "strong";

export const SCALE_PRESETS: readonly ScalePreset[] = ["fast", "quality", "max"];
export const SHARPEN_LEVELS: readonly SharpenLevel[] = [
  "off",
  "weak",
  "medium",
  "strong",
];

export type ScalerName = "scale" | "cscale" | "dscale";

export const SCALER_NAMES: readonly ScalerName[] = [
  "scale",
  "cscale",
  "dscale",
];

const SCALE_PRESET_KEY = "scalePreset";
const SHARPEN_KEY = "sharpen";

/** Filter label — the remove/toggle reference is `@<label>`. */
export const SHARPEN_LABEL = "seans-sharpen";

/** Label-only reference used by `vf remove`. */
export function labelRef(label: string): string {
  return `@${label}`;
}

/**
 * Scaler values per preset (issue #11 vocabulary). "Качество" mixes lanczos
 * (upscale — mpv's own default balance) with spline36 (downscale — softer,
 * fewer ringing artifacts); "Максимум" throws ewa_lanczos at everything and
 * warns about the load in the UI.
 */
export const SCALE_PRESET_SCALERS: Record<
  ScalePreset,
  Record<ScalerName, string>
> = {
  fast: { scale: "bilinear", cscale: "bilinear", dscale: "bilinear" },
  quality: { scale: "lanczos", cscale: "lanczos", dscale: "spline36" },
  max: {
    scale: "ewa_lanczos",
    cscale: "ewa_lanczos",
    dscale: "ewa_lanczos",
  },
};

/**
 * mpv defaults (DOCS/man/options.rst): `--scale` is `lanczos`, `--cscale` is
 * unset and follows `--scale`, `--dscale` is documented as "like --scale".
 * `dispose` returns the three properties here (issue #11: «возврат дефолтов»).
 */
export const MPV_DEFAULT_SCALERS: Record<ScalerName, string> = {
  scale: "lanczos",
  cscale: "lanczos",
  dscale: "lanczos",
};

/**
 * `unsharp` presets (issue #11: выкл/слабая/средняя/сильная). All levels share
 * the `@seans-sharpen` label, so switching a level replaces the filter in
 * place. The matrix is the standard 5×5 and only the amount steps; chroma is
 * left alone (filter default `chroma_amount=0`) — chroma noise on old rips
 * must not be amplified.
 */
const SHARPEN_FILTERS: Record<Exclude<SharpenLevel, "off">, string> = {
  weak: `@${SHARPEN_LABEL}:lavfi=[unsharp=luma_msize_x=5:luma_msize_y=5:` +
    `luma_amount=0.5]`,
  medium: `@${SHARPEN_LABEL}:lavfi=[unsharp=luma_msize_x=5:luma_msize_y=5:` +
    `luma_amount=1]`,
  strong: `@${SHARPEN_LABEL}:lavfi=[unsharp=luma_msize_x=5:luma_msize_y=5:` +
    `luma_amount=2]`,
};

export function sharpenFilter(level: Exclude<SharpenLevel, "off">): string {
  return SHARPEN_FILTERS[level];
}

export function parseScalePreset(raw: unknown): ScalePreset {
  return raw === "fast" || raw === "quality" || raw === "max" ? raw : "quality";
}

export function parseSharpenLevel(raw: unknown): SharpenLevel {
  return raw === "weak" || raw === "medium" || raw === "strong" ? raw : "off";
}

export type PictureState = {
  scalePreset: ScalePreset;
  sharpen: SharpenLevel;
};

export type PictureCommand =
  | { op: "set"; name: ScalerName; value: string }
  | { op: "filter"; filterOp: "add" | "remove"; entry: string };

/**
 * Desired mpv edits for a settings snapshot: the three scaler properties plus
 * the named unsharp filter. `add` with a used label replaces the filter, so
 * re-applying is idempotent; `remove` matches by label and touches no other
 * extension's filters.
 */
export function pictureCommands(state: PictureState): PictureCommand[] {
  const scalers = SCALE_PRESET_SCALERS[state.scalePreset];
  const commands: PictureCommand[] = SCALER_NAMES.map((name) => ({
    op: "set",
    name,
    value: scalers[name],
  }));
  commands.push(
    state.sharpen === "off"
      ? { op: "filter", filterOp: "remove", entry: labelRef(SHARPEN_LABEL) }
      : { op: "filter", filterOp: "add", entry: sharpenFilter(state.sharpen) },
  );
  return commands;
}

/** `dispose` edits: scalers back to mpv defaults, sharpen filter dropped. */
export function disposeCommands(): PictureCommand[] {
  const commands: PictureCommand[] = SCALER_NAMES.map((name) => ({
    op: "set",
    name,
    value: MPV_DEFAULT_SCALERS[name],
  }));
  commands.push({
    op: "filter",
    filterOp: "remove",
    entry: labelRef(SHARPEN_LABEL),
  });
  return commands;
}

/** Shared settings state for the menu row and the mpv sync. */
export type PictureSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getScalePreset(): ScalePreset;
  getSharpen(): SharpenLevel;
  setScalePreset(preset: ScalePreset): void;
  setSharpen(level: SharpenLevel): void;
};

export function createPictureSettings(
  storage: ExtensionStorage,
): PictureSettings {
  let scalePreset = parseScalePreset(storage.get(SCALE_PRESET_KEY, "quality"));
  let sharpen = parseSharpenLevel(storage.get(SHARPEN_KEY, "off"));
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
    getScalePreset: () => scalePreset,
    getSharpen: () => sharpen,
    setScalePreset(preset) {
      scalePreset = parseScalePreset(preset);
      storage.set(SCALE_PRESET_KEY, scalePreset);
      notify();
    },
    setSharpen(level) {
      sharpen = parseSharpenLevel(level);
      storage.set(SHARPEN_KEY, sharpen);
      notify();
    },
  };
}

export type PictureController = {
  settings: PictureSettings;
  /** Bring the scalers and the vf chain in line with the current settings. */
  apply(): void;
  /** Return the scalers to the mpv defaults, drop our filter, stop reacting. */
  dispose(): void;
};

/**
 * Settings + mpv wiring shared by the extension and the tests. Every call is
 * fire-and-forget: a bridge/mpv reject is swallowed (issue: «ошибка mpv
 * изолирована — расширение не роняет плеер»).
 */
export function createPictureController(
  mpv: MpvBridge,
  storage: ExtensionStorage,
): PictureController {
  const settings = createPictureSettings(storage);
  const run = (commands: PictureCommand[]): void => {
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
      pictureCommands({
        scalePreset: settings.getScalePreset(),
        sharpen: settings.getSharpen(),
      }),
    );
  const stopSettings = settings.subscribe(apply);
  return {
    settings,
    apply,
    dispose() {
      stopSettings();
      run(disposeCommands());
    },
  };
}

const SCALE_PRESET_LABELS: Record<ScalePreset, string> = {
  fast: "Быстрое",
  quality: "Качество",
  max: "Максимум",
};

const SHARPEN_LEVEL_LABELS: Record<SharpenLevel, string> = {
  off: "Выкл",
  weak: "Слабая",
  medium: "Средняя",
  strong: "Сильная",
};

function PictureQualityRow({
  settings,
}: {
  settings: PictureSettings;
}): ReactElement {
  const scalePreset = useSyncExternalStore(
    settings.subscribe,
    settings.getScalePreset,
  );
  const sharpen = useSyncExternalStore(settings.subscribe, settings.getSharpen);
  return (
    <section>
      <h4 className="player-menu-title">Масштабирование</h4>
      <div
        className="player-menu-row"
        role="group"
        aria-label="Пресеты масштабирования"
      >
        {SCALE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            role="menuitemradio"
            aria-checked={preset === scalePreset}
            className={`player-chip${preset === scalePreset ? " player-chip-active" : ""}`}
            onClick={() => settings.setScalePreset(preset)}
          >
            {SCALE_PRESET_LABELS[preset]}
          </button>
        ))}
      </div>
      <p className="player-menu-empty">«Максимум» — повышенная нагрузка на GPU.</p>
      <h4 className="player-menu-title">Резкость</h4>
      <div className="player-menu-row" role="group" aria-label="Уровни резкости">
        {SHARPEN_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            role="menuitemradio"
            aria-checked={level === sharpen}
            className={`player-chip${level === sharpen ? " player-chip-active" : ""}`}
            onClick={() => settings.setSharpen(level)}
          >
            {SHARPEN_LEVEL_LABELS[level]}
          </button>
        ))}
      </div>
    </section>
  );
}

export const pictureQuality: PlayerExtension = {
  id: "picture-quality",
  name: "Качество изображения",
  setup(ctx): Unsubscribe {
    const controller = createPictureController(ctx.mpv, ctx.storage);
    const stopOpen = ctx.onOpen(() => controller.apply());
    const stopRow = ctx.ui.add("settings.menu", () => (
      <PictureQualityRow settings={controller.settings} />
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

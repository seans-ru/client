/**
 * HDR tone mapping extension (issue #13, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * HDR rips on SDR monitors look dim or clipped; mpv tone-maps them, and this
 * extension exposes the knobs players ship for it:
 *
 * - mode «Авто» (default): `hdr-compute-peak=yes`, `tone-mapping=auto`,
 *   `target-peak=auto` — mpv measures the peak per frame and decides the curve.
 * - mode «Алгоритм»: the user pins `tone-mapping` (auto / bt.2390 / mobius /
 *   reinhard / clip); the peak stays auto-computed.
 * - mode «Ручная яркость»: the user pins `target-peak` in nits and peak
 *   detection is turned off, so the set value is what the display gets.
 *
 * On SDR output mpv enables tone mapping by itself — these settings are an
 * overlay on top of that. Everything runs through `ctx.mpv.setProperty` with
 * string values (choice properties parse `auto`/`yes`/`no`/nits from strings);
 * mpv errors are swallowed — the extension must never break the player.
 *
 * The read-only info line reports the source HDR/SDR state and tagged peak
 * from the mpv properties `video-params/gamma`, `video-params/max-luma`,
 * `video-params/max-cll` and `video-out-params/gamma`.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type {
  ExtensionStorage,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";

export type HdrMode = "auto" | "algorithm" | "manual";
export type ToneMapping = "auto" | "bt.2390" | "mobius" | "reinhard" | "clip";

export const HDR_MODES: readonly HdrMode[] = ["auto", "algorithm", "manual"];
export const TONE_MAPPINGS: readonly ToneMapping[] = [
  "auto",
  "bt.2390",
  "mobius",
  "reinhard",
  "clip",
];

/** Manual `target-peak` slider bounds (nits). */
export const TARGET_PEAK_MIN = 100;
export const TARGET_PEAK_MAX = 1000;
/** SDR reference white — what mpv itself targets for tone mapping. */
export const TARGET_PEAK_DEFAULT = 203;

const MODE_KEY = "mode";
const ALGORITHM_KEY = "algorithm";
const TARGET_PEAK_KEY = "targetPeak";

/** mpv properties the extension writes (issue #13 vocabulary). */
export type HdrPropertyName =
  | "tone-mapping"
  | "hdr-compute-peak"
  | "target-peak";

export const HDR_PROPERTY_NAMES: readonly HdrPropertyName[] = [
  "tone-mapping",
  "hdr-compute-peak",
  "target-peak",
];

export type HdrState = {
  mode: HdrMode;
  algorithm: ToneMapping;
  targetPeak: number;
};

export type HdrCommand = {
  op: "set";
  name: HdrPropertyName;
  /** String values: choice properties parse `auto` / `yes` / `no` / nits. */
  value: string;
};

/**
 * mpv defaults (DOCS/man/options.rst): `--tone-mapping=auto`,
 * `--hdr-compute-peak=auto`, `--target-peak=auto`. `dispose` writes them back.
 */
export const MPV_DEFAULT_HDR: Record<HdrPropertyName, string> = {
  "tone-mapping": "auto",
  "hdr-compute-peak": "auto",
  "target-peak": "auto",
};

export function parseHdrMode(raw: unknown): HdrMode {
  return raw === "algorithm" || raw === "manual" ? raw : "auto";
}

export function parseToneMapping(raw: unknown): ToneMapping {
  return (TONE_MAPPINGS as readonly unknown[]).includes(raw)
    ? (raw as ToneMapping)
    : "auto";
}

export function clampTargetPeak(value: unknown): number {
  // `Number(null)` is 0 — only real numbers and numeric strings count.
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) return TARGET_PEAK_DEFAULT;
  return Math.min(TARGET_PEAK_MAX, Math.max(TARGET_PEAK_MIN, Math.round(n)));
}

/**
 * Desired mpv edits for a settings snapshot. The three modes are exclusive
 * (issue #13 UI: режим Авто / Алгоритм / Ручная яркость): each adds exactly
 * one user control on top of mpv's own defaults.
 */
export function hdrCommands(state: HdrState): HdrCommand[] {
  if (state.mode === "algorithm") {
    return [
      { op: "set", name: "tone-mapping", value: parseToneMapping(state.algorithm) },
      { op: "set", name: "hdr-compute-peak", value: "yes" },
      { op: "set", name: "target-peak", value: "auto" },
    ];
  }
  if (state.mode === "manual") {
    return [
      { op: "set", name: "tone-mapping", value: "auto" },
      { op: "set", name: "hdr-compute-peak", value: "no" },
      {
        op: "set",
        name: "target-peak",
        value: String(clampTargetPeak(state.targetPeak)),
      },
    ];
  }
  // auto: peak detection on, everything else mpv's own choice.
  return [
    { op: "set", name: "tone-mapping", value: "auto" },
    { op: "set", name: "hdr-compute-peak", value: "yes" },
    { op: "set", name: "target-peak", value: "auto" },
  ];
}

/** `dispose` edits: the three properties back to the mpv defaults. */
export function hdrDisposeCommands(): HdrCommand[] {
  return HDR_PROPERTY_NAMES.map((name) => ({
    op: "set" as const,
    name,
    value: MPV_DEFAULT_HDR[name],
  }));
}

/** Shared settings state for the menu row and the mpv sync. */
export type HdrSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getMode(): HdrMode;
  getAlgorithm(): ToneMapping;
  getTargetPeak(): number;
  setMode(mode: HdrMode): void;
  setAlgorithm(algorithm: ToneMapping): void;
  setTargetPeak(nits: number): void;
};

export function createHdrSettings(storage: ExtensionStorage): HdrSettings {
  let mode = parseHdrMode(storage.get(MODE_KEY, "auto"));
  let algorithm = parseToneMapping(storage.get(ALGORITHM_KEY, "auto"));
  let targetPeak = clampTargetPeak(storage.get(TARGET_PEAK_KEY, null));
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
    getMode: () => mode,
    getAlgorithm: () => algorithm,
    getTargetPeak: () => targetPeak,
    setMode(next) {
      mode = parseHdrMode(next);
      storage.set(MODE_KEY, mode);
      notify();
    },
    setAlgorithm(next) {
      algorithm = parseToneMapping(next);
      storage.set(ALGORITHM_KEY, algorithm);
      notify();
    },
    setTargetPeak(nits) {
      targetPeak = clampTargetPeak(nits);
      storage.set(TARGET_PEAK_KEY, targetPeak);
      notify();
    },
  };
}

export type HdrController = {
  settings: HdrSettings;
  /** Bring the three properties in line with the current settings. */
  apply(): void;
  /** Return the properties to the mpv defaults, stop reacting. */
  dispose(): void;
};

/**
 * Settings + mpv wiring shared by the extension and the tests. Every write is
 * fire-and-forget: a bridge/mpv reject is swallowed (issue: «ошибка mpv
 * изолирована — расширение не роняет плеер»).
 */
export function createHdrController(
  mpv: MpvBridge,
  storage: ExtensionStorage,
): HdrController {
  const settings = createHdrSettings(storage);
  const run = (commands: HdrCommand[]): void => {
    for (const command of commands) {
      void mpv.setProperty(command.name, command.value).catch(() => {});
    }
  };
  const apply = (): void =>
    run(
      hdrCommands({
        mode: settings.getMode(),
        algorithm: settings.getAlgorithm(),
        targetPeak: settings.getTargetPeak(),
      }),
    );
  const stopSettings = settings.subscribe(apply);
  return {
    settings,
    apply,
    dispose() {
      stopSettings();
      run(hdrDisposeCommands());
    },
  };
}

/** Read-only HDR facts parsed out of the mpv property strings. */
export type HdrInfo = {
  /** Source transfer (`video-params/gamma`): "pq", "hlg", "srgb", … */
  transfer: string;
  /** Output transfer (`video-out-params/gamma`) after filters. */
  outputTransfer: string;
  /** Tagged source peak in nits (max-luma → max-cll); null when unknown. */
  peakNits: number | null;
};

export const HDR_INFO_UNKNOWN: HdrInfo = {
  transfer: "",
  outputTransfer: "",
  peakNits: null,
};

export function isHdrTransfer(transfer: string): boolean {
  return transfer === "pq" || transfer === "hlg";
}

export function parseNits(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Best-effort property read — unknown/absent values degrade to "". */
function readProp(mpv: MpvBridge, name: string): Promise<string> {
  return mpv.getProperty(name).catch(() => "");
}

export async function readHdrInfo(mpv: MpvBridge): Promise<HdrInfo> {
  const [transfer, outputTransfer, maxLuma, maxCll] = await Promise.all([
    readProp(mpv, "video-params/gamma"),
    readProp(mpv, "video-out-params/gamma"),
    readProp(mpv, "video-params/max-luma"),
    readProp(mpv, "video-params/max-cll"),
  ]);
  return {
    transfer,
    outputTransfer,
    peakNits: parseNits(maxLuma) ?? parseNits(maxCll),
  };
}

/** How the active mode talks about tone mapping (issue: «что происходит»). */
export function toneMappingSummary(state: HdrState): string {
  if (state.mode === "algorithm") {
    return `тонмаппинг: ${parseToneMapping(state.algorithm)}`;
  }
  if (state.mode === "manual") {
    return `тонмаппинг: авто, яркость ${clampTargetPeak(state.targetPeak)} нит`;
  }
  return "тонмаппинг: авто, подстройка пика";
}

/**
 * The read-only info line: source HDR/SDR state and peak (from mpv), then
 * what our tone-mapping settings do to it.
 */
export function hdrStatusLine(info: HdrInfo, state: HdrState): string {
  const source = isHdrTransfer(info.transfer)
    ? `HDR (${info.transfer.toUpperCase()})`
    : "SDR";
  const peak =
    info.peakNits != null ? `, пик ${info.peakNits} нит` : "";
  const output = isHdrTransfer(info.outputTransfer)
    ? `вывод: ${info.outputTransfer.toUpperCase()}`
    : "вывод: SDR";
  return `Источник: ${source}${peak} · ${output} · ${toneMappingSummary(state)}`;
}

export type HdrInfoStore = {
  subscribe(cb: () => void): Unsubscribe;
  get(): HdrInfo;
  refresh(): Promise<void>;
};

export function createHdrInfoStore(mpv: MpvBridge): HdrInfoStore {
  let info = HDR_INFO_UNKNOWN;
  const listeners = new Set<() => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => info,
    async refresh() {
      info = await readHdrInfo(mpv);
      for (const listener of [...listeners]) listener();
    },
  };
}

const HDR_MODE_LABELS: Record<HdrMode, string> = {
  auto: "Авто",
  algorithm: "Алгоритм",
  manual: "Ручная яркость",
};

const TONE_MAPPING_LABELS: Record<ToneMapping, string> = {
  auto: "Авто",
  "bt.2390": "BT.2390",
  mobius: "Mobius",
  reinhard: "Reinhard",
  clip: "Clip",
};

function HdrSection({
  settings,
  infoStore,
}: {
  settings: HdrSettings;
  infoStore: HdrInfoStore;
}): ReactElement {
  const mode = useSyncExternalStore(settings.subscribe, settings.getMode);
  const algorithm = useSyncExternalStore(
    settings.subscribe,
    settings.getAlgorithm,
  );
  const targetPeak = useSyncExternalStore(
    settings.subscribe,
    settings.getTargetPeak,
  );
  const info = useSyncExternalStore(infoStore.subscribe, infoStore.get);
  return (
    <section>
      <h4 className="player-menu-title">HDR</h4>
      <div className="player-menu-row" role="group" aria-label="Режим HDR">
        {HDR_MODES.map((value) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={value === mode}
            className={`player-chip${value === mode ? " player-chip-active" : ""}`}
            onClick={() => settings.setMode(value)}
          >
            {HDR_MODE_LABELS[value]}
          </button>
        ))}
      </div>
      {mode === "algorithm" ? (
        <div
          className="player-menu-row"
          role="group"
          aria-label="Алгоритм тонмаппинга"
        >
          {TONE_MAPPINGS.map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === algorithm}
              className={`player-chip${value === algorithm ? " player-chip-active" : ""}`}
              onClick={() => settings.setAlgorithm(value)}
            >
              {TONE_MAPPING_LABELS[value]}
            </button>
          ))}
        </div>
      ) : null}
      {mode === "manual" ? (
        <div className="player-menu-row">
          <input
            type="range"
            min={TARGET_PEAK_MIN}
            max={TARGET_PEAK_MAX}
            step={1}
            value={targetPeak}
            aria-label="Целевая яркость, нит"
            style={{ flex: 1, accentColor: "var(--accent)" }}
            onChange={(event) =>
              settings.setTargetPeak(Number(event.target.value))
            }
          />
          <span className="player-menu-item-meta">{targetPeak} нит</span>
        </div>
      ) : null}
      <p className="player-menu-empty">{hdrStatusLine(info, {
        mode,
        algorithm,
        targetPeak,
      })}</p>
    </section>
  );
}

export const hdr: PlayerExtension = {
  id: "hdr",
  name: "HDR",
  setup(ctx): Unsubscribe {
    const controller = createHdrController(ctx.mpv, ctx.storage);
    const infoStore = createHdrInfoStore(ctx.mpv);
    const stopOpen = ctx.onOpen(() => {
      controller.apply();
      void infoStore.refresh();
    });
    const stopRow = ctx.ui.add("settings.menu", () => (
      <HdrSection settings={controller.settings} infoStore={infoStore} />
    ));
    // A file may already be playing when the extension mounts.
    controller.apply();
    void infoStore.refresh();
    return () => {
      stopRow();
      stopOpen();
      controller.dispose();
    };
  },
};

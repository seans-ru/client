/**
 * Video geometry extension (issue #15, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Crop / zoom / rotate / aspect tools for imperfect rips, mapped straight
 * onto mpv properties through `ctx.mpv.setProperty` (issue #15 vocabulary):
 *
 *   - aspect presets «Оригинал / 16:9 / 4:3 / 2.39:1 / Растянуть /
 *     Заполнить» → `video-aspect-override`, `keepaspect`, `panscan`
 *     (Растянуть = `keepaspect=no` stretch-to-window, mpv ignores it in
 *     fullscreen — documented limitation; Заполнить = `panscan=1`);
 *   - zoom in ±10% steps → `video-zoom` (log2 scale);
 *   - rotate in 90° steps → `video-rotate` (hwdec supports 90° steps only);
 *   - panning → `video-pan-x` / `video-pan-y` (fractions of the scaled
 *     video; disabled by mpv while `keepaspect=no`);
 *   - manual crop → the NAMED video filter `@seans-crop` (`vf add` /
 *     `vf remove`), so the vf chain of other extensions (sharpen, denoise)
 *     is never overwritten.
 *
 * Smart memory (issue #15): every change is stored per file under
 * `file.<mediaKey>` in `ctx.storage` and restored on reopen; a separate
 * `global` entry is the default for files without their own record
 * («Сделать дефолтом»). «Сброс» returns the original look and clears the
 * file record; `dispose` resets the geometry so nothing leaks into the next
 * session.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import {
  mediaKeyFromSnapshot,
  mediaKeyFromUrl,
  needsSnapshotKey,
} from "./mediaKey";
import type { PlayerSnapshot } from "../playerTypes";
import type {
  ExtensionStorage,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";

export type AspectPreset =
  | "original"
  | "16:9"
  | "4:3"
  | "2.39:1"
  | "stretch"
  | "fill";

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  "original",
  "16:9",
  "4:3",
  "2.39:1",
  "stretch",
  "fill",
];

export const ASPECT_PRESET_LABELS: Record<AspectPreset, string> = {
  original: "Оригинал",
  "16:9": "16:9",
  "4:3": "4:3",
  "2.39:1": "2.39:1",
  stretch: "Растянуть",
  fill: "Заполнить",
};

/** `video-aspect-override` value per preset ("no" = mpv default handling). */
export const ASPECT_PRESET_VALUES: Record<AspectPreset, string> = {
  original: "no",
  "16:9": "16:9",
  "4:3": "4:3",
  "2.39:1": "2.39:1",
  stretch: "no",
  fill: "no",
};

/** Manual crop rectangle in decoded video pixels (issue #15). */
export type CropRect = { w: number; h: number; x: number; y: number };

export type GeometryState = {
  aspect: AspectPreset;
  /** Display scale in percent (100 = untouched); mpv `video-zoom` is log2. */
  zoomPercent: number;
  /** Clockwise degrees, 90° steps (issue #15). */
  rotate: number;
  /** `video-pan-x` / `video-pan-y` — fractions of the scaled video size. */
  panX: number;
  panY: number;
  /** Manual crop (null = no `@seans-crop` filter). */
  crop: CropRect | null;
};

export const GEOMETRY_DEFAULT: GeometryState = {
  aspect: "original",
  zoomPercent: 100,
  rotate: 0,
  panX: 0,
  panY: 0,
  crop: null,
};

export const ZOOM_STEP_PERCENT = 10;
export const ZOOM_MIN_PERCENT = 10;
export const ZOOM_MAX_PERCENT = 400;
export const PAN_STEP = 0.05;
export const PAN_MIN = -1;
export const PAN_MAX = 1;

/** Filter label — the remove/toggle reference is `@<label>`. */
export const CROP_LABEL = "seans-crop";

/** Label-only reference used by `vf remove`. */
export function labelRef(label: string): string {
  return `@${label}`;
}

/** Labeled crop filter: `vf add` replaces in place, so re-apply is idempotent. */
export function cropFilter(rect: CropRect): string {
  return `@${CROP_LABEL}:crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`;
}

export type GeometryPropertyName =
  | "video-aspect-override"
  | "keepaspect"
  | "panscan"
  | "video-zoom"
  | "video-rotate"
  | "video-pan-x"
  | "video-pan-y";

export type GeometryCommand =
  | { op: "set"; name: GeometryPropertyName; value: string | number | boolean }
  | { op: "filter"; filterOp: "add" | "remove"; entry: string };

export function parseAspectPreset(raw: unknown): AspectPreset {
  return (ASPECT_PRESETS as readonly unknown[]).includes(raw)
    ? (raw as AspectPreset)
    : "original";
}

export function clampZoomPercent(value: unknown): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : 100;
  return Math.min(ZOOM_MAX_PERCENT, Math.max(ZOOM_MIN_PERCENT, n));
}

export function clampPan(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(PAN_MAX, Math.max(PAN_MIN, n));
}

/** Normalize any degree value to the 90° grid in [0, 360). */
export function normalizeRotate(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return ((Math.round(n / 90) * 90) % 360 + 360) % 360;
}

export function parseCropRect(raw: unknown): CropRect | null {
  const r = (raw ?? {}) as Partial<CropRect>;
  const w = Number(r.w);
  const h = Number(r.h);
  const x = Number(r.x);
  const y = Number(r.y);
  if (![w, h, x, y].every((v) => Number.isFinite(v))) return null;
  if (!(w > 0) || !(h > 0)) return null;
  return {
    w: Math.round(w),
    h: Math.round(h),
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
  };
}

/** Clamp a crop to the decoded frame (when known) so mpv accepts it. */
export function clampCropRect(
  rect: CropRect,
  videoW: number | null | undefined,
  videoH: number | null | undefined,
): CropRect {
  const knownW =
    videoW != null && videoW > 0 ? Math.trunc(videoW) : null;
  const knownH =
    videoH != null && videoH > 0 ? Math.trunc(videoH) : null;
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  const clampedW = knownW != null ? Math.min(w, knownW) : w;
  const clampedH = knownH != null ? Math.min(h, knownH) : h;
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  return {
    w: clampedW,
    h: clampedH,
    x: knownW != null ? Math.min(x, Math.max(0, knownW - clampedW)) : x,
    y: knownH != null ? Math.min(y, Math.max(0, knownH - clampedH)) : y,
  };
}

/** mpv `video-zoom` is a log2 scale factor (0 = untouched). */
export function zoomPercentToVideoZoom(percent: number): number {
  return Math.log2(clampZoomPercent(percent) / 100);
}

export function parseGeometryState(raw: unknown): GeometryState {
  const r = (raw ?? {}) as Partial<GeometryState>;
  return {
    aspect: parseAspectPreset(r.aspect),
    zoomPercent: clampZoomPercent(r.zoomPercent ?? 100),
    rotate: normalizeRotate(r.rotate ?? 0),
    panX: clampPan(r.panX ?? 0),
    panY: clampPan(r.panY ?? 0),
    crop: parseCropRect(r.crop ?? null),
  };
}

/**
 * Desired mpv edits for a state snapshot. Aspect family first (it owns
 * `keepaspect`/`panscan`), then zoom/rotate/pan, then the crop filter —
 * `vf add` with the used label replaces the filter in place, so re-applying
 * is idempotent and never touches `@seans-sharpen` / `@seans-denoise`.
 */
export function geometryCommands(state: GeometryState): GeometryCommand[] {
  const commands: GeometryCommand[] = [
    {
      op: "set",
      name: "video-aspect-override",
      value: ASPECT_PRESET_VALUES[state.aspect],
    },
    {
      op: "set",
      name: "keepaspect",
      value: state.aspect !== "stretch",
    },
    { op: "set", name: "panscan", value: state.aspect === "fill" ? 1 : 0 },
    { op: "set", name: "video-zoom", value: zoomPercentToVideoZoom(state.zoomPercent) },
    { op: "set", name: "video-rotate", value: state.rotate },
    { op: "set", name: "video-pan-x", value: state.panX },
    { op: "set", name: "video-pan-y", value: state.panY },
  ];
  commands.push(
    state.crop
      ? { op: "filter", filterOp: "add", entry: cropFilter(state.crop) }
      : { op: "filter", filterOp: "remove", entry: labelRef(CROP_LABEL) },
  );
  return commands;
}

/** Reset edits: original geometry + drop the crop filter. */
export function geometryResetCommands(): GeometryCommand[] {
  return geometryCommands(GEOMETRY_DEFAULT);
}

const FILE_PREFIX = "file.";
const GLOBAL_KEY = "global";

/** Per-file record → global default → built-in default. */
export function loadGeometryState(
  storage: ExtensionStorage,
  mediaKey: string | null,
): GeometryState {
  const fileState =
    mediaKey != null ? storage.get<unknown>(FILE_PREFIX + mediaKey, null) : null;
  if (fileState != null) return parseGeometryState(fileState);
  return parseGeometryState(storage.get<unknown>(GLOBAL_KEY, null));
}

export function saveGeometryState(
  storage: ExtensionStorage,
  mediaKey: string | null,
  state: GeometryState,
): void {
  if (mediaKey == null) return;
  storage.set(FILE_PREFIX + mediaKey, state);
}

export function clearGeometryState(
  storage: ExtensionStorage,
  mediaKey: string | null,
): void {
  if (mediaKey == null) return;
  storage.set(FILE_PREFIX + mediaKey, null);
}

/** Shared settings state for the menu rows and the mpv sync. */
export type GeometrySettings = {
  subscribe(cb: () => void): Unsubscribe;
  getState(): GeometryState;
  getVideoSize(): { w: number; h: number };
  /** Bind a media key and restore its per-file (or default) geometry. */
  loadForFile(key: string | null): GeometryState;
  patch(next: Partial<GeometryState>): void;
  zoomBy(deltaPercent: number): void;
  rotateBy(degrees: number): void;
  panBy(dx: number, dy: number): void;
  /** «Сделать дефолтом» — remember the current geometry as the global one. */
  saveAsGlobalDefault(): void;
  /** «Сброс» — original look, file record cleared. */
  resetFile(): void;
  /** Restore the original look without touching storage (onClose/dispose). */
  restoreDefaults(): void;
  refreshVideoSize(snapshot: PlayerSnapshot): void;
};

export function createGeometrySettings(
  storage: ExtensionStorage,
): GeometrySettings {
  let state = loadGeometryState(storage, null);
  let mediaKey: string | null = null;
  // Cached identity for useSyncExternalStore: a fresh object per call would
  // re-render forever (React compares snapshots by reference).
  let videoSize: { w: number; h: number } = { w: 0, h: 0 };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const commit = (next: GeometryState): void => {
    state = next;
    notify();
  };
  const patch = (next: Partial<GeometryState>): void => {
    const merged = parseGeometryState({ ...state, ...next });
    commit(merged);
    saveGeometryState(storage, mediaKey, merged);
  };
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getState: () => state,
    getVideoSize: () => videoSize,
    loadForFile(key) {
      mediaKey = key;
      const next = loadGeometryState(storage, key);
      commit(next);
      return next;
    },
    patch,
    zoomBy(deltaPercent) {
      patch({ zoomPercent: clampZoomPercent(state.zoomPercent + deltaPercent) });
    },
    rotateBy(degrees) {
      patch({ rotate: normalizeRotate(state.rotate + degrees) });
    },
    panBy(dx, dy) {
      patch({
        panX: clampPan(state.panX + dx),
        panY: clampPan(state.panY + dy),
      });
    },
    saveAsGlobalDefault() {
      storage.set(GLOBAL_KEY, state);
    },
    resetFile() {
      clearGeometryState(storage, mediaKey);
      commit({ ...GEOMETRY_DEFAULT });
    },
    restoreDefaults() {
      commit({ ...GEOMETRY_DEFAULT });
    },
    refreshVideoSize(snapshot) {
      const w = Math.trunc(snapshot.video_w ?? 0);
      const h = Math.trunc(snapshot.video_h ?? 0);
      if (w === videoSize.w && h === videoSize.h) return;
      videoSize = { w, h };
      notify();
    },
  };
}

export type GeometryController = {
  settings: GeometrySettings;
  /** Bring the geometry properties + crop filter in line with the state. */
  apply(): void;
  /** Restore the original geometry (no storage writes). */
  reset(): void;
  /** `dispose`: reset geometry + drop the crop filter, stop reacting. */
  dispose(): void;
};

/**
 * Settings + mpv wiring shared by the extension and the tests. Every call is
 * fire-and-forget: a bridge/mpv reject is swallowed (issue: «ошибка mpv
 * изолирована — расширение не роняет плеер»).
 */
export function createGeometryController(
  mpv: MpvBridge,
  storage: ExtensionStorage,
): GeometryController {
  const settings = createGeometrySettings(storage);
  const run = (commands: GeometryCommand[]): void => {
    for (const command of commands) {
      if (command.op === "set") {
        void mpv.setProperty(command.name, command.value).catch(() => {});
      } else {
        void mpv
          .command(["vf", command.filterOp, command.entry])
          .catch(() => {});
      }
    }
  };
  const apply = (): void => run(geometryCommands(settings.getState()));
  const stopSettings = settings.subscribe(apply);
  return {
    settings,
    apply,
    reset() {
      settings.restoreDefaults();
      run(geometryResetCommands());
    },
    dispose() {
      stopSettings();
      run(geometryResetCommands());
    },
  };
}

function CropEditor({
  settings,
}: {
  settings: GeometrySettings;
}): ReactElement {
  const state = useSyncExternalStore(settings.subscribe, settings.getState);
  const size = useSyncExternalStore(settings.subscribe, settings.getVideoSize);
  const rect: CropRect = state.crop ?? {
    w: size.w > 0 ? size.w : 1920,
    h: size.h > 0 ? size.h : 1080,
    x: 0,
    y: 0,
  };
  const fields: Array<{ key: keyof CropRect; label: string }> = [
    { key: "w", label: "Ширина" },
    { key: "h", label: "Высота" },
    { key: "x", label: "Слева" },
    { key: "y", label: "Сверху" },
  ];
  return (
    <>
      <div className="player-menu-list">
        {fields.map((field) => (
          <label key={field.key} className="player-menu-item">
            <span className="player-menu-item-label">{field.label}</span>
            <input
              type="number"
              min={field.key === "w" || field.key === "h" ? 1 : 0}
              step={2}
              value={rect[field.key]}
              aria-label={field.label}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                settings.patch({
                  crop: clampCropRect({ ...rect, [field.key]: value }, size.w, size.h),
                });
              }}
            />
          </label>
        ))}
      </div>
      <div className="player-menu-row">
        <button
          type="button"
          role="menuitem"
          className={`player-chip${state.crop ? " player-chip-active" : ""}`}
          onClick={() =>
            settings.patch({ crop: clampCropRect(rect, size.w, size.h) })
          }
        >
          Применить кроп
        </button>
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => settings.patch({ crop: null })}
        >
          Снять кроп
        </button>
      </div>
    </>
  );
}

function GeometrySection({
  settings,
}: {
  settings: GeometrySettings;
}): ReactElement {
  const state = useSyncExternalStore(settings.subscribe, settings.getState);
  return (
    <section>
      <h4 className="player-menu-title">Геометрия видео</h4>
      <div className="player-menu-row" role="group" aria-label="Соотношение сторон">
        {ASPECT_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            role="menuitemradio"
            aria-checked={state.aspect === preset}
            className={`player-chip${state.aspect === preset ? " player-chip-active" : ""}`}
            onClick={() => settings.patch({ aspect: preset })}
          >
            {ASPECT_PRESET_LABELS[preset]}
          </button>
        ))}
      </div>
      <h4 className="player-menu-title">Зум</h4>
      <div className="player-menu-row">
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => settings.zoomBy(-ZOOM_STEP_PERCENT)}
        >
          −{ZOOM_STEP_PERCENT}%
        </button>
        <span className="player-chip player-chip-active" aria-live="polite">
          {Math.round(state.zoomPercent)}%
        </span>
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => settings.zoomBy(ZOOM_STEP_PERCENT)}
        >
          +{ZOOM_STEP_PERCENT}%
        </button>
      </div>
      <h4 className="player-menu-title">Поворот</h4>
      <div className="player-menu-row">
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => settings.rotateBy(90)}
        >
          Поворот 90°
        </button>
        <span className="player-chip player-chip-active" aria-live="polite">
          {state.rotate}°
        </span>
      </div>
      <h4 className="player-menu-title">Панорамирование</h4>
      <div className="player-menu-row">
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => settings.panBy(-PAN_STEP, 0)}
        >
          ←
        </button>
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => settings.panBy(PAN_STEP, 0)}
        >
          →
        </button>
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => settings.panBy(0, -PAN_STEP)}
        >
          ↑
        </button>
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => settings.panBy(0, PAN_STEP)}
        >
          ↓
        </button>
        <span className="player-chip player-chip-active" aria-live="polite">
          {state.panX.toFixed(2)} / {state.panY.toFixed(2)}
        </span>
      </div>
      <h4 className="player-menu-title">Ручной кроп</h4>
      <CropEditor settings={settings} />
      <h4 className="player-menu-title">Память</h4>
      <div className="player-menu-row">
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => settings.saveAsGlobalDefault()}
        >
          Сделать дефолтом
        </button>
        <button
          type="button"
          role="menuitem"
          className="player-chip"
          onClick={() => settings.resetFile()}
        >
          Сброс
        </button>
      </div>
      <p className="player-menu-empty">
        Настройки запоминаются для файла; «Растянуть» игнорируется mpv в
        полноэкранном режиме, сдвиг и зум при нём отключены.
      </p>
    </section>
  );
}

export const geometry: PlayerExtension = {
  id: "geometry",
  name: "Геометрия видео",
  setup(ctx): Unsubscribe {
    const controller = createGeometryController(ctx.mpv, ctx.storage);
    let pendingUrl: string | null = null;

    const resolveKey = (snapshot?: PlayerSnapshot): string | null => {
      if (pendingUrl == null) return null;
      if (needsSnapshotKey(pendingUrl)) {
        if (!snapshot || !snapshot.file_loaded) return null;
        const key = mediaKeyFromSnapshot(pendingUrl, snapshot);
        pendingUrl = null;
        return key;
      }
      const key = mediaKeyFromUrl(pendingUrl);
      pendingUrl = null;
      return key;
    };

    const stopOpen = ctx.onOpen((info) => {
      pendingUrl = info.url;
      const key = resolveKey();
      if (key != null) {
        controller.settings.loadForFile(key);
        controller.apply();
      }
    });
    const stopSnapshot = ctx.onSnapshot((snapshot) => {
      controller.settings.refreshVideoSize(snapshot);
      const key = resolveKey(snapshot);
      if (key != null) {
        controller.settings.loadForFile(key);
        controller.apply();
      }
    });
    const stopClose = ctx.onClose(() => {
      // Never leak geometry into the next file (issue #15: dispose resets).
      controller.settings.restoreDefaults();
      controller.apply();
    });
    const stopMenu = ctx.ui.add("settings.menu", () => (
      <GeometrySection settings={controller.settings} />
    ));
    return () => {
      stopMenu();
      stopOpen();
      stopSnapshot();
      stopClose();
      controller.dispose();
    };
  },
};

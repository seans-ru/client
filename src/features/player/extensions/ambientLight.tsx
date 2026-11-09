/**
 * Ambient light extension (issue #7, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * "Ambilight" for the app shell: the dominant color of the current frame
 * (≤32×32 sample from the frame tap, EMA-smoothed, ~10 fps cap) is published
 * as CSS variables (`--ambient-r/g/b/a`) and a soft glow layer tints the
 * window rim and the shell around the video zone.
 *
 * Visuals live entirely in this module (spec §S2.6: app-level effects are
 * built from a `ctx.frames` subscription + CSS variables, outside the core):
 * a body-level `position: fixed` layer with edge gradients reads the
 * variables, so per-frame work is only 4 tiny CSS writes.
 *
 * Settings (settings.menu): on/off, intensity, mode «По кадру» /
 * «Кадр + звук» (phase-1 sound reactivity from pause/mute/volume) and
 * «Не подсвечивать тёмные сцены» (brightness threshold with hysteresis).
 * State persists via `ctx.storage`.
 *
 * Teardown: `dispose` and `frameHub.reset()` (via `frameHub.onReset`) both
 * restore the default look — glow layer removed, variables zeroed.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import { frameHub } from "./frameHub";
import {
  AMBIENT_MAX_FPS,
  AMBIENT_MODES,
  createAmbientEngine,
  DEFAULT_SETTINGS,
  parseSettings,
  type AmbientEngine,
  type AmbientMode,
  type AmbientSettings,
  type AmbientVarWriter,
} from "./ambientLightPolicy";
import type {
  ExtensionStorage,
  PlayerExtension,
  Unsubscribe,
} from "./types";

const ENABLED_KEY = "enabled";
const INTENSITY_KEY = "intensity";
const MODE_KEY = "mode";
const DARK_SKIP_KEY = "darkSkip";

/** Intensity presets offered as chips (master glow strength). */
export const INTENSITY_PRESETS: readonly { label: string; value: number }[] = [
  { label: "Низкая", value: 0.35 },
  { label: "Средняя", value: 0.6 },
  { label: "Высокая", value: 1 },
];

export const MODE_LABELS: Record<AmbientMode, string> = {
  frame: "По кадру",
  "frame-sound": "Кадр + звук",
};

/** Shared settings state for the menu row and the effect pipeline. */
export type AmbientSettingsStore = {
  subscribe(cb: () => void): Unsubscribe;
  get(): AmbientSettings;
  set(patch: Partial<AmbientSettings>): void;
};

export function createAmbientSettings(
  storage: ExtensionStorage,
): AmbientSettingsStore {
  let settings = parseSettings({
    enabled: storage.get(ENABLED_KEY, DEFAULT_SETTINGS.enabled),
    intensity: storage.get(INTENSITY_KEY, DEFAULT_SETTINGS.intensity),
    mode: storage.get(MODE_KEY, DEFAULT_SETTINGS.mode),
    darkSkip: storage.get(DARK_SKIP_KEY, DEFAULT_SETTINGS.darkSkip),
  });
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => settings,
    set(patch) {
      settings = parseSettings({ ...settings, ...patch });
      storage.set(ENABLED_KEY, settings.enabled);
      storage.set(INTENSITY_KEY, settings.intensity);
      storage.set(MODE_KEY, settings.mode);
      storage.set(DARK_SKIP_KEY, settings.darkSkip);
      notify();
    },
  };
}

/**
 * CSS-variable sink on an element style (`document.documentElement` in the
 * app; a stub in tests).
 */
export function createRootVarWriter(root: {
  style: { setProperty(name: string, value: string): void };
}): AmbientVarWriter {
  return {
    setVar(name, value) {
      root.style.setProperty(name, value);
    },
  };
}

export const GLOW_LAYER_CLASS = "seans-ambient-glow";

/**
 * The glow layer: fixed full-viewport, pointer-transparent. The rim bands
 * («рамка вокруг плеера») bleed inward from the window edges and a soft
 * radial wash tints the shell («фон») — all outside the central video zone.
 * Colors come from the CSS variables, so the engine never re-creates DOM.
 */
function glowCss(): string {
  return [
    "position:fixed",
    "inset:0",
    "pointer-events:none",
    "z-index:2",
    "opacity:var(--ambient-a,0)",
    "transition:opacity 0.2s linear",
    "background:",
    "radial-gradient(120% 100% at 50% 50%, transparent 42%, rgba(var(--ambient-r,0),var(--ambient-g,0),var(--ambient-b,0),0.16) 100%),",
    "linear-gradient(to bottom, rgba(var(--ambient-r,0),var(--ambient-g,0),var(--ambient-b,0),0.7) 0%, transparent 13%),",
    "linear-gradient(to top, rgba(var(--ambient-r,0),var(--ambient-g,0),var(--ambient-b,0),0.7) 0%, transparent 13%),",
    "linear-gradient(to right, rgba(var(--ambient-r,0),var(--ambient-g,0),var(--ambient-b,0),0.55) 0%, transparent 9%),",
    "linear-gradient(to left, rgba(var(--ambient-r,0),var(--ambient-g,0),var(--ambient-b,0),0.55) 0%, transparent 9%)",
  ].join(";");
}

/** Appends the glow layer; the returned callback removes it. */
export function mountGlowLayer(doc: Document): Unsubscribe {
  const el = doc.createElement("div");
  el.className = GLOW_LAYER_CLASS;
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = glowCss();
  doc.body.appendChild(el);
  return () => {
    el.remove();
  };
}

function AmbientSettingsRow({
  store,
}: {
  store: AmbientSettingsStore;
}): ReactElement {
  const settings = useSyncExternalStore(store.subscribe, store.get);
  return (
    <section>
      <h4 className="player-menu-title">Ambient-подсветка</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={settings.enabled}
          className={`player-menu-item${settings.enabled ? " player-menu-item-active" : ""}`}
          onClick={() => store.set({ enabled: !settings.enabled })}
        >
          {settings.enabled ? "Включено" : "Выключено"}
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={settings.darkSkip}
          className={`player-menu-item${settings.darkSkip ? " player-menu-item-active" : ""}`}
          onClick={() => store.set({ darkSkip: !settings.darkSkip })}
        >
          {settings.darkSkip
            ? "Тёмные сцены: не подсвечивать"
            : "Тёмные сцены: подсвечивать"}
        </button>
      </div>
      <div className="player-menu-row">
        {INTENSITY_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            role="menuitemradio"
            aria-checked={Math.abs(preset.value - settings.intensity) < 0.01}
            className={`player-chip${Math.abs(preset.value - settings.intensity) < 0.01 ? " player-chip-active" : ""}`}
            onClick={() => store.set({ intensity: preset.value })}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="player-menu-row">
        {AMBIENT_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="menuitemradio"
            aria-checked={settings.mode === mode}
            className={`player-chip${settings.mode === mode ? " player-chip-active" : ""}`}
            onClick={() => store.set({ mode })}
          >
            {MODE_LABELS[mode]}
          </button>
        ))}
      </div>
    </section>
  );
}

export const ambientLight: PlayerExtension = {
  id: "ambient-light",
  name: "Ambient-подсветка",
  setup(ctx): Unsubscribe {
    const store = createAmbientSettings(ctx.storage);
    const engine: AmbientEngine = createAmbientEngine(
      createRootVarWriter(document.documentElement),
      store.get(),
    );
    const removeGlow = mountGlowLayer(document);

    // Frame tap (§S2.6): throttled downsampled frames — the hub caps at
    // ~10 fps and the engine reuses its accumulators (no per-frame garbage).
    const stopFrames = ctx.frames.subscribe(
      (sample) => {
        engine.handleFrame(sample);
      },
      { maxFps: AMBIENT_MAX_FPS },
    );
    // Sound reactivity, phase 1: intensity follows pause / mute / volume.
    const stopSound = ctx.onSnapshot((snapshot) => {
      engine.handleSound({
        pause: snapshot.pause,
        mute: snapshot.mute,
        volume: snapshot.volume,
      });
    });
    const stopClose = ctx.onClose(() => {
      engine.reset();
    });
    // frameHub.reset() tears the stream down at session end — the effect
    // must vanish with it (issue #7 acceptance).
    const stopReset = frameHub.onReset(() => {
      engine.reset();
    });
    const stopSettings = store.subscribe(() => {
      engine.setSettings(store.get());
    });
    const stopRow = ctx.ui.add("settings.menu", () => (
      <AmbientSettingsRow store={store} />
    ));

    return () => {
      stopRow();
      stopSettings();
      stopReset();
      stopClose();
      stopSound();
      stopFrames();
      engine.reset();
      removeGlow();
    };
  },
};

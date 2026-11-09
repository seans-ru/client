/**
 * Ambient light policy (issue #7) — pure logic behind `ambientLight.tsx`:
 * frame averaging over the ≤32×32 `FrameSample`, EMA smoothing (no flicker
 * on every frame), the dark-scene gate with hysteresis and the sound-reactive
 * intensity (phase 1: pause / mute / volume from the player snapshot).
 *
 * The visual contract is a set of CSS variables on `:root`
 * (`--ambient-r/g/b` 0..255, `--ambient-a` 0..1). The extension writes them
 * through an injected writer — no DOM here, so everything is unit-testable.
 */

import type { FrameSample } from "./types";

/** Delivery cap for the frame tap (~10 fps, spec §S2.6). */
export const AMBIENT_MAX_FPS = 10;

/** EMA weight per delivered sample — ~0.5 s time constant at 10 fps. */
export const EMA_ALPHA = 0.18;

/** Rec.709 luminance below this counts as a dark scene (0..1). */
export const DARK_LUMA = 0.1;

/** Hysteresis band around `DARK_LUMA` — no strobing on scene edges. */
export const DARK_HYSTERESIS = 0.03;

export const AMBIENT_VAR_R = "--ambient-r";
export const AMBIENT_VAR_G = "--ambient-g";
export const AMBIENT_VAR_B = "--ambient-b";
export const AMBIENT_VAR_A = "--ambient-a";

export const AMBIENT_VAR_NAMES = [
  AMBIENT_VAR_R,
  AMBIENT_VAR_G,
  AMBIENT_VAR_B,
  AMBIENT_VAR_A,
] as const;

export type Rgb = { r: number; g: number; b: number };

/** `a` is the final glow strength: 0..1. */
export type AmbientVars = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type AmbientMode = "frame" | "frame-sound";

export const AMBIENT_MODES: readonly AmbientMode[] = ["frame", "frame-sound"];

export type AmbientSettings = {
  enabled: boolean;
  /** Master strength, 0..1 (settings menu offers named presets). */
  intensity: number;
  /** «По кадру» / «Кадр + звук». */
  mode: AmbientMode;
  /** «Тёмные сцены не подсвечивать». */
  darkSkip: boolean;
};

/** Sound part of the player snapshot (phase 1 has no level envelope). */
export type SoundState = {
  pause: boolean;
  mute: boolean;
  volume: number;
};

export const DEFAULT_INTENSITY = 0.6;

export const DEFAULT_SETTINGS: AmbientSettings = {
  enabled: true,
  intensity: DEFAULT_INTENSITY,
  mode: "frame-sound",
  darkSkip: true,
};

export const ZERO_VARS: AmbientVars = { r: 0, g: 0, b: 0, a: 0 };

/** Minimal CSS-variable sink (documentElement.style in the app). */
export type AmbientVarWriter = {
  setVar(name: string, value: string): void;
};

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Average RGB of a stride-sampled frame (≤32×32 from frameHub). */
export function averageFrameRgbInto(sample: FrameSample, out: Rgb): Rgb {
  const pixels = sample.rgb;
  const count = sample.width * sample.height;
  if (count <= 0 || pixels.length < count * 3) {
    out.r = 0;
    out.g = 0;
    out.b = 0;
    return out;
  }
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < count * 3; i += 3) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
  }
  out.r = r / count;
  out.g = g / count;
  out.b = b / count;
  return out;
}

/** Convenience wrapper (tests, non-hot paths). */
export function averageFrameRgb(sample: FrameSample): Rgb {
  return averageFrameRgbInto(sample, { r: 0, g: 0, b: 0 });
}

/** Rec.709 luminance, 0..1. */
export function luminance(rgb: Rgb): number {
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

export function ema(prev: number, next: number, alpha: number): number {
  return prev + (next - prev) * alpha;
}

/**
 * Dark-scene gate with hysteresis: once dark, stays dark until the frame
 * clears `DARK_LUMA + DARK_HYSTERESIS`, and vice versa.
 */
export function darkGate(luma: number, wasDark: boolean): boolean {
  return wasDark
    ? luma < DARK_LUMA + DARK_HYSTERESIS
    : luma < DARK_LUMA - DARK_HYSTERESIS;
}

/**
 * Sound-reactive intensity multiplier (phase 1 — state only, no envelope):
 * pause dims hard, mute/silence dims, loudness scales the rest. Mode
 * «По кадру» ignores sound entirely.
 */
export function soundIntensityFactor(
  sound: SoundState,
  mode: AmbientMode,
): number {
  if (mode === "frame") return 1;
  if (sound.pause) return 0.3;
  if (sound.mute || sound.volume <= 0) return 0.45;
  const volume = Math.min(sound.volume, 100) / 100;
  return 0.55 + 0.45 * volume;
}

export type VarWrite = { name: string; value: string };

function valueOfVar(vars: AmbientVars, name: string): number {
  switch (name) {
    case AMBIENT_VAR_R:
      return vars.r;
    case AMBIENT_VAR_G:
      return vars.g;
    case AMBIENT_VAR_B:
      return vars.b;
    default:
      return vars.a;
  }
}

/** Quantized vars -> the minimal set of CSS writes (skip unchanged values). */
export function cssWrites(
  prev: AmbientVars | null,
  next: AmbientVars,
): VarWrite[] {
  const writes: VarWrite[] = [];
  const push = (name: string, value: number, digits: number): void => {
    const text = value.toFixed(digits);
    if (prev === null || text !== valueOfVar(prev, name).toFixed(digits)) {
      writes.push({ name, value: text });
    }
  };
  push(AMBIENT_VAR_R, Math.round(next.r), 0);
  push(AMBIENT_VAR_G, Math.round(next.g), 0);
  push(AMBIENT_VAR_B, Math.round(next.b), 0);
  push(AMBIENT_VAR_A, next.a, 2);
  return writes;
}

export type AmbientEngine = {
  handleFrame(sample: FrameSample): void;
  handleSound(sound: SoundState): void;
  setSettings(next: AmbientSettings): void;
  /** frameHub.reset() / session teardown — variables back to the default. */
  reset(): void;
};

/**
 * Stateful pipeline: sample -> average -> EMA -> (dark gate) -> CSS vars.
 * Only changed (quantized) values reach the writer — no per-frame churn and
 * no per-frame allocations on the hot path (the RGB accumulator is reused).
 */
export function createAmbientEngine(
  writer: AmbientVarWriter,
  initial: AmbientSettings = DEFAULT_SETTINGS,
): AmbientEngine {
  let settings = initial;
  let hasColor = false;
  const color: Rgb = { r: 0, g: 0, b: 0 };
  const avg: Rgb = { r: 0, g: 0, b: 0 };
  let sound: SoundState = { pause: false, mute: false, volume: 100 };
  let wasDark = false;
  let last: AmbientVars | null = null;

  const write = (): void => {
    let next: AmbientVars;
    if (!settings.enabled || !hasColor) {
      next = ZERO_VARS;
    } else {
      const luma = luminance(color);
      wasDark = settings.darkSkip ? darkGate(luma, wasDark) : false;
      next = {
        r: color.r,
        g: color.g,
        b: color.b,
        a: wasDark ? 0 : clamp01(settings.intensity * soundIntensityFactor(sound, settings.mode)),
      };
    }
    const writes = cssWrites(last, next);
    if (writes.length === 0) return;
    for (const { name, value } of writes) writer.setVar(name, value);
    last = next;
  };

  return {
    handleFrame(sample) {
      averageFrameRgbInto(sample, avg);
      if (!hasColor) {
        color.r = avg.r;
        color.g = avg.g;
        color.b = avg.b;
        hasColor = true;
      } else {
        color.r = ema(color.r, avg.r, EMA_ALPHA);
        color.g = ema(color.g, avg.g, EMA_ALPHA);
        color.b = ema(color.b, avg.b, EMA_ALPHA);
      }
      write();
    },
    handleSound(next) {
      sound = next;
      write();
    },
    setSettings(next) {
      settings = next;
      write();
    },
    reset() {
      hasColor = false;
      wasDark = false;
      sound = { pause: false, mute: false, volume: 100 };
      // Always write the defaults — the acceptance requires the effect to be
      // fully gone after frameHub.reset()/dispose, not merely untouched.
      last = null;
      for (const { name, value } of cssWrites(null, ZERO_VARS)) {
        writer.setVar(name, value);
      }
      last = ZERO_VARS;
    },
  };
}

export function parseMode(raw: unknown): AmbientMode {
  return raw === "frame" || raw === "frame-sound" ? raw : DEFAULT_SETTINGS.mode;
}

export function parseSettings(raw: {
  enabled?: unknown;
  intensity?: unknown;
  mode?: unknown;
  darkSkip?: unknown;
}): AmbientSettings {
  const intensity =
    typeof raw.intensity === "number" && Number.isFinite(raw.intensity)
      ? clamp01(raw.intensity)
      : DEFAULT_SETTINGS.intensity;
  return {
    enabled:
      typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
    intensity,
    mode: parseMode(raw.mode),
    darkSkip:
      typeof raw.darkSkip === "boolean"
        ? raw.darkSkip
        : DEFAULT_SETTINGS.darkSkip,
  };
}

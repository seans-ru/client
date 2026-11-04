/**
 * Frame tap hub (spec: docs/compose/spec/player-extensibility.md §S2.6).
 *
 * The `FrameStream` handler in `PlayerSurface` publishes every raw RGBA frame
 * here next to `renderer.push`. Video-effect extensions subscribe and get a
 * lazily computed stride-sampled RGB `FrameSample` (max side ≤ 32) with
 * per-subscriber fps throttling.
 *
 * The player session is a singleton — the default `frameHub` mirrors the Rust
 * session. Tests use `createFrameHub()` for isolated state.
 */

import type { FrameSample, Unsubscribe } from "./types";

/** Delivery cap when a subscriber does not ask for one. */
const DEFAULT_MAX_FPS = 10;

export type FrameHub = {
  publishFrame(frame: {
    width: number;
    height: number;
    pts: number;
    pixels: Uint8Array;
  }): void;
  subscribe(
    cb: (s: FrameSample) => void,
    opts?: { maxFps?: number },
  ): Unsubscribe;
  reset(): void;
};

/**
 * Uniform stride sample of an RGBA frame into RGB triples with
 * `max(sampleW, sampleH) <= maxSide`. Rows stay bottom-up as the stream
 * delivers them — extensions only need colors, not orientation. Alpha is
 * dropped. Never upscales: inputs already smaller than `maxSide` pass 1:1.
 */
export function downsampleRgb(
  width: number,
  height: number,
  pixels: Uint8Array,
  maxSide = 32,
): FrameSample {
  // Corrupt payload (bad dims or truncated buffer): a 1x1 black sample keeps
  // consumers simple — never read out of bounds, never throw on a bad frame.
  if (width <= 0 || height <= 0 || pixels.length !== width * height * 4) {
    return { width: 1, height: 1, pts: 0, rgb: new Uint8Array(3) };
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const sampleW = Math.max(1, Math.round(width * scale));
  const sampleH = Math.max(1, Math.round(height * scale));
  const rgb = new Uint8Array(sampleW * sampleH * 3);
  for (let y = 0; y < sampleH; y++) {
    const srcRow = Math.floor((y * height) / sampleH) * width;
    const outRow = y * sampleW;
    for (let x = 0; x < sampleW; x++) {
      const src = (srcRow + Math.floor((x * width) / sampleW)) * 4;
      const dst = (outRow + x) * 3;
      rgb[dst] = pixels[src];
      rgb[dst + 1] = pixels[src + 1];
      rgb[dst + 2] = pixels[src + 2];
    }
  }
  // pts is stamped by the hub — this helper is pure and frame-agnostic.
  return { width: sampleW, height: sampleH, pts: 0, rgb };
}

type Subscriber = {
  cb: (s: FrameSample) => void;
  /** Minimum ms between deliveries (`1000 / maxFps`). */
  windowMs: number;
  /** End-of-window flush timer; `null` while outside a throttle window. */
  timer: ReturnType<typeof setTimeout> | null;
  /** A newer sample arrived during the window — deliver it at window end. */
  pending: boolean;
};

/**
 * Deliver a sample to one subscriber. Errors are isolated here: a throwing
 * callback must never escape into the `FrameStream` read loop (spec §S2.3).
 */
function deliver(sub: Subscriber, sample: FrameSample): void {
  try {
    sub.cb(sample);
  } catch (error) {
    console.warn("[player.ext] frame callback", error);
  }
}

export function createFrameHub(): FrameHub {
  /** Latest cached sample (computed at most once per published frame). */
  let latest: FrameSample | null = null;
  const subscribers = new Set<Subscriber>();

  /** Close the window with a trailing delivery of the cached latest sample. */
  const armWindowEnd = (sub: Subscriber): void => {
    sub.timer = setTimeout(() => {
      sub.timer = null;
      if (!sub.pending || !latest) return;
      sub.pending = false;
      deliver(sub, latest);
      armWindowEnd(sub);
    }, sub.windowMs);
  };

  return {
    publishFrame(frame) {
      // Zero subscribers: keep publish cheap — no downsample, no cache update.
      // A subscriber that appears later gets the sample computed on the first
      // publish after subscribing (no cached-frame replay).
      if (subscribers.size === 0) return;
      const sample: FrameSample = {
        ...downsampleRgb(frame.width, frame.height, frame.pixels),
        pts: frame.pts,
      };
      latest = sample;
      for (const sub of [...subscribers]) {
        if (sub.timer === null) {
          // Leading edge: first frame after subscribe / after a quiet window.
          sub.pending = false;
          deliver(sub, sample);
          armWindowEnd(sub);
        } else {
          // Inside the window — latest wins, delivered at window end.
          sub.pending = true;
        }
      }
    },
    subscribe(cb, opts) {
      const fps =
        typeof opts?.maxFps === "number" &&
        Number.isFinite(opts.maxFps) &&
        opts.maxFps > 0
          ? opts.maxFps
          : DEFAULT_MAX_FPS;
      const sub: Subscriber = {
        cb,
        windowMs: 1000 / fps,
        timer: null,
        pending: false,
      };
      subscribers.add(sub);
      return () => {
        // Cancel any pending trailing delivery along with the subscription.
        if (sub.timer !== null) clearTimeout(sub.timer);
        sub.timer = null;
        sub.pending = false;
        subscribers.delete(sub);
      };
    },
    reset() {
      for (const sub of subscribers) {
        if (sub.timer !== null) clearTimeout(sub.timer);
      }
      subscribers.clear();
      latest = null;
    },
  };
}

/** Session-wide hub — the player session is a singleton. */
export const frameHub = createFrameHub();

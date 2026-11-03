import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFrameHub,
  downsampleRgb,
  frameHub,
} from "../src/features/player/extensions/frameHub";
import type { FrameSample } from "../src/features/player/extensions/types";

/** RGBA frame filled with one solid color. */
function solidRgba(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return pixels;
}

/** RGBA frame where red = pixel index (stride-pick assertions). */
function indexedRgba(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = i;
    pixels[i * 4 + 1] = 100;
    pixels[i * 4 + 2] = 200;
    pixels[i * 4 + 3] = 255 - i;
  }
  return pixels;
}

function makeFrame(pts: number, width = 4, height = 4) {
  return {
    width,
    height,
    pts,
    pixels: solidRgba(width, height, 10, 20, 30),
  };
}

describe("downsampleRgb (stride sample, max side)", () => {
  it("caps 64x64 at a 32x32 sample", () => {
    const s = downsampleRgb(64, 64, solidRgba(64, 64, 255, 128, 64));
    expect(s.width).toBe(32);
    expect(s.height).toBe(32);
    expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(32);
    expect(s.rgb.length).toBe(s.width * s.height * 3);
    // Solid input: every sample keeps the source RGB (alpha dropped).
    expect([...s.rgb.slice(0, 3)]).toEqual([255, 128, 64]);
    expect([...s.rgb.slice(-3)]).toEqual([255, 128, 64]);
  });

  it("preserves aspect ratio for non-square frames", () => {
    const wide = downsampleRgb(1280, 720, new Uint8Array(1280 * 720 * 4));
    expect(wide.width).toBe(32);
    expect(wide.height).toBe(18);
    expect(wide.rgb.length).toBe(32 * 18 * 3);

    const tall = downsampleRgb(720, 1280, new Uint8Array(720 * 1280 * 4));
    expect(tall.width).toBe(18);
    expect(tall.height).toBe(32);
    expect(tall.rgb.length).toBe(18 * 32 * 3);
  });

  it("picks stride pixels and ignores alpha", () => {
    // 4x4 -> 2x2 samples buffer cells (0,0) (2,0) (0,2) (2,2).
    const s = downsampleRgb(4, 4, indexedRgba(4, 4), 2);
    expect(s.width).toBe(2);
    expect(s.height).toBe(2);
    expect([...s.rgb]).toEqual([
      0, 100, 200, 2, 100, 200,
      8, 100, 200, 10, 100, 200,
    ]);
    // Alpha varies per pixel (255 - i) and never leaks into `rgb`.
    expect(s.rgb.length).toBe(2 * 2 * 3);
  });

  it("returns a 1x1 black sample for wrong-length pixel data", () => {
    for (const [w, h, pixels] of [
      [4, 4, new Uint8Array(10)],
      [0, 5, new Uint8Array(0)],
      [-1, 2, new Uint8Array(0)],
    ] as Array<[number, number, Uint8Array]>) {
      const s = downsampleRgb(w, h, pixels);
      expect(s.width).toBe(1);
      expect(s.height).toBe(1);
      expect([...s.rgb]).toEqual([0, 0, 0]);
    }
  });

  it("keeps a 1x1 input unchanged (alpha dropped)", () => {
    const s = downsampleRgb(1, 1, new Uint8Array([9, 8, 7, 0]));
    expect(s.width).toBe(1);
    expect(s.height).toBe(1);
    expect([...s.rgb]).toEqual([9, 8, 7]);
  });

  it("never upscales tiny inputs and honors a smaller maxSide", () => {
    const tiny = downsampleRgb(8, 8, solidRgba(8, 8, 1, 2, 3));
    expect(tiny.width).toBe(8);
    expect(tiny.height).toBe(8);

    const smaller = downsampleRgb(64, 64, solidRgba(64, 64, 1, 2, 3), 16);
    expect(smaller.width).toBe(16);
    expect(smaller.height).toBe(16);
    expect(smaller.rgb.length).toBe(16 * 16 * 3);
  });
});

describe("createFrameHub (throttled delivery)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses a quick burst into leading + trailing samples", () => {
    const hub = createFrameHub();
    const seen: FrameSample[] = [];
    hub.subscribe((s) => seen.push(s), { maxFps: 10 }); // 100 ms window

    for (let i = 1; i <= 5; i++) hub.publishFrame(makeFrame(i));
    expect(seen).toHaveLength(1);
    expect(seen[0].pts).toBe(1);

    vi.advanceTimersByTime(100);
    expect(seen).toHaveLength(2);
    expect(seen[1].pts).toBe(5); // latest wins at the window end

    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(2); // quiet — no extra deliveries
  });

  it("defaults to maxFps = 10 when opts are omitted", () => {
    const hub = createFrameHub();
    const seen: number[] = [];
    hub.subscribe((s) => seen.push(s.pts));

    hub.publishFrame(makeFrame(1));
    hub.publishFrame(makeFrame(2));
    expect(seen).toEqual([1]);

    vi.advanceTimersByTime(99);
    expect(seen).toEqual([1]); // window is 100 ms
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([1, 2]);
  });

  it("lets subscribers run at different maxFps", () => {
    const hub = createFrameHub();
    const fast: number[] = [];
    const slow: number[] = [];
    hub.subscribe((s) => fast.push(s.pts), { maxFps: 10 }); // 100 ms
    hub.subscribe((s) => slow.push(s.pts), { maxFps: 2 }); // 500 ms

    for (let i = 1; i <= 3; i++) hub.publishFrame(makeFrame(i));
    expect(fast).toEqual([1]);
    expect(slow).toEqual([1]);

    vi.advanceTimersByTime(100);
    expect(fast).toEqual([1, 3]);
    expect(slow).toEqual([1]);

    vi.advanceTimersByTime(400); // t = 500
    expect(fast).toEqual([1, 3]);
    expect(slow).toEqual([1, 3]);
  });

  it("stops delivery on unsubscribe (including pending trailing)", () => {
    const hub = createFrameHub();
    const seen: number[] = [];
    const unsub = hub.subscribe((s) => seen.push(s.pts), { maxFps: 10 });

    hub.publishFrame(makeFrame(1));
    hub.publishFrame(makeFrame(2)); // pending trailing
    expect(seen).toEqual([1]);

    unsub();
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([1]);

    hub.publishFrame(makeFrame(3));
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([1]);
  });

  it("reset drops subscribers and the cached sample", () => {
    const hub = createFrameHub();
    const seen: number[] = [];
    hub.subscribe((s) => seen.push(s.pts), { maxFps: 10 });

    hub.publishFrame(makeFrame(1));
    hub.publishFrame(makeFrame(2)); // pending trailing
    expect(seen).toEqual([1]);

    hub.reset();
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([1]); // pending trailing dropped

    hub.publishFrame(makeFrame(3));
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([1]); // subscriber gone

    // A fresh subscriber after reset works again.
    const seen2: number[] = [];
    hub.subscribe((s) => seen2.push(s.pts));
    hub.publishFrame(makeFrame(4));
    expect(seen2).toEqual([4]);
  });

  it("ignores publishes while nobody subscribes", () => {
    const hub = createFrameHub();
    expect(() => hub.publishFrame(makeFrame(1))).not.toThrow();

    const seen: number[] = [];
    hub.subscribe((s) => seen.push(s.pts));
    hub.publishFrame(makeFrame(2));
    expect(seen).toEqual([2]); // no replay of frames published before subscribe
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([2]);
  });
});

describe("frameHub singleton", () => {
  it("exposes the session hub API", () => {
    expect(typeof frameHub.publishFrame).toBe("function");
    expect(typeof frameHub.subscribe).toBe("function");
    expect(typeof frameHub.reset).toBe("function");
  });
});

import { describe, expect, it } from "vitest";
import {
  addPreviewFrame,
  captureStepSec,
  nearestPreview,
  parsePreviewCache,
  previewBucket,
  previewCacheBytes,
  serializePreviewCache,
  LOOKUP_TOLERANCE_SEC,
  MAX_CACHE_BYTES,
  MAX_PREVIEW_FRAMES,
  MIN_CAPTURE_STEP_SEC,
  type PreviewFrame,
} from "../src/features/player/extensions/scrubPreviewPolicy";

function frame(tSec: number): PreviewFrame {
  return { tSec, dataUrl: `data:image/png;base64,${"x".repeat(200)}${tSec}` };
}

describe("captureStepSec", () => {
  it("never goes below the 5 s floor", () => {
    expect(captureStepSec(0)).toBe(MIN_CAPTURE_STEP_SEC);
    expect(captureStepSec(30)).toBe(MIN_CAPTURE_STEP_SEC);
    expect(captureStepSec(Number.NaN)).toBe(MIN_CAPTURE_STEP_SEC);
  });

  it("stretches for long files so the frame cap is respected", () => {
    expect(captureStepSec(2 * 3600)).toBeCloseTo((2 * 3600) / MAX_PREVIEW_FRAMES);
  });
});

describe("previewBucket", () => {
  it("maps timestamps into fixed step windows", () => {
    expect(previewBucket(0, 5)).toBe(0);
    expect(previewBucket(4.9, 5)).toBe(0);
    expect(previewBucket(5, 5)).toBe(1);
    expect(previewBucket(12, 5)).toBe(2);
  });
});

describe("addPreviewFrame", () => {
  it("keeps one frame per bucket (cap frequency)", () => {
    let list: PreviewFrame[] | null = [];
    list = addPreviewFrame(list!, frame(1), 5) ?? list;
    expect(addPreviewFrame(list!, frame(3), 5)).toBeNull();
    list = addPreviewFrame(list!, frame(7), 5) ?? list;
    expect(list).toHaveLength(2);
  });

  it("rejects corrupt frames", () => {
    expect(addPreviewFrame([], { tSec: -1, dataUrl: "x" }, 5)).toBeNull();
    expect(addPreviewFrame([], { tSec: 1, dataUrl: "" }, 5)).toBeNull();
    expect(addPreviewFrame([], { tSec: Number.NaN, dataUrl: "x" }, 5)).toBeNull();
  });

  it("keeps the list sorted and trims the oldest over the cap", () => {
    let list: PreviewFrame[] = [];
    for (let i = 0; i < 8; i += 1) {
      list = addPreviewFrame(list, frame(i * 10), 5, 5) ?? list;
    }
    expect(list).toHaveLength(5);
    expect(list[0].tSec).toBe(30);
    expect(list[list.length - 1].tSec).toBe(70);
  });
});

describe("nearestPreview", () => {
  const list = [frame(10), frame(20), frame(30)];

  it("returns the closest frame", () => {
    expect(nearestPreview(list, 18)?.tSec).toBe(20);
    expect(nearestPreview(list, 31)?.tSec).toBe(30);
    expect(nearestPreview(list, 0.5)?.tSec).toBe(10);
  });

  it("returns null outside the tolerance (timecode-only fallback)", () => {
    expect(nearestPreview(list, 100)).toBeNull();
    expect(nearestPreview([frame(10)], 10 + LOOKUP_TOLERANCE_SEC + 1)).toBeNull();
    expect(nearestPreview([], 10)).toBeNull();
    expect(nearestPreview(list, Number.NaN)).toBeNull();
  });

  it("respects a custom tolerance", () => {
    expect(nearestPreview(list, 11, 2)?.tSec).toBe(10);
    expect(nearestPreview(list, 13, 2)).toBeNull();
  });
});

describe("serializePreviewCache / parsePreviewCache", () => {
  it("round-trips a cache", () => {
    const list = [frame(1), frame(2)];
    const raw = serializePreviewCache(list);
    expect(raw).not.toBeNull();
    const parsed = parsePreviewCache(JSON.parse(raw!));
    expect(parsed.map((f) => f.tSec)).toEqual([1, 2]);
  });

  it("drops frames until the size cap is met, keeping the newest", () => {
    const big: PreviewFrame[] = [];
    for (let i = 0; i < 50; i += 1) {
      big.push({ tSec: i, dataUrl: "x".repeat(5000) });
    }
    const raw = serializePreviewCache(big, 20_000);
    expect(raw).not.toBeNull();
    expect(raw!.length).toBeLessThanOrEqual(20_000);
    const parsed = parsePreviewCache(JSON.parse(raw!));
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[parsed.length - 1].tSec).toBe(49);
  });

  it("returns null when nothing fits the cap", () => {
    expect(serializePreviewCache([frame(1)], 4)).toBeNull();
    expect(serializePreviewCache([], MAX_CACHE_BYTES)).toBeNull();
  });

  it("degrades malformed payloads to empty", () => {
    expect(parsePreviewCache(null)).toEqual([]);
    expect(parsePreviewCache("nope")).toEqual([]);
    expect(parsePreviewCache([{ tSec: -1, dataUrl: "x" }, 42])).toEqual([]);
    const parsed = parsePreviewCache([{ tSec: 3, dataUrl: "d" }]);
    expect(parsed).toEqual([{ tSec: 3, dataUrl: "d" }]);
  });

  it("trims parsed caches to the frame cap", () => {
    const raw = Array.from({ length: MAX_PREVIEW_FRAMES + 20 }, (_, i) => ({
      tSec: i,
      dataUrl: "d",
    }));
    expect(parsePreviewCache(raw)).toHaveLength(MAX_PREVIEW_FRAMES);
  });
});

describe("previewCacheBytes", () => {
  it("accounts for the data URLs", () => {
    expect(previewCacheBytes([frame(1), frame(2)])).toBeGreaterThan(400);
    expect(previewCacheBytes([])).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import {
  clampMarksToDuration,
  isCaptureBusy,
  MIN_CLIP_SEC,
  moveHandle,
  moveSegment,
  previewActionAt,
  setMarkB,
  timelineSeconds,
  type ClipMarks,
} from "../src/features/player/extensions/captureHelpers";

describe("setMarkB equality guard (review)", () => {
  it("rejects an end mark equal to the start (no zero-length range)", () => {
    expect(setMarkB({ a: 20, b: null }, 20)).toEqual({ a: 20, b: null });
    expect(setMarkB({ a: 20, b: 25 }, 20)).toEqual({ a: 20, b: 25 });
    // Still swaps on a real back-click.
    expect(setMarkB({ a: 20, b: null }, 19.5)).toEqual({ a: 19.5, b: 20 });
  });
});

describe("isCaptureBusy", () => {
  it("locks the UI during working/progress only", () => {
    expect(isCaptureBusy({ kind: "working" })).toBe(true);
    expect(isCaptureBusy({ kind: "progress" })).toBe(true);
    expect(isCaptureBusy({ kind: "idle" })).toBe(false);
    expect(isCaptureBusy({ kind: "done" })).toBe(false);
    expect(isCaptureBusy({ kind: "error" })).toBe(false);
    expect(isCaptureBusy({ kind: "fallback" })).toBe(false);
  });
});

describe("clampMarksToDuration", () => {
  it("clamps both marks into the file and keeps the order", () => {
    expect(clampMarksToDuration({ a: -5, b: 500 }, 100)).toEqual({
      a: 0,
      b: 100,
    });
    expect(clampMarksToDuration({ a: 10, b: 20 }, 15)).toEqual({
      a: 10,
      b: 15,
    });
    // Unknown duration only floors at 0.
    expect(clampMarksToDuration({ a: -1, b: 5 }, null)).toEqual({ a: 0, b: 5 });
  });

  it("drops a reversed end instead of flipping silently", () => {
    expect(clampMarksToDuration({ a: 30, b: 30 }, 100)).toEqual({
      a: 30,
      b: null,
    });
    expect(clampMarksToDuration({ a: 30, b: 10 }, 100)).toEqual({
      a: 30,
      b: null,
    });
  });
});

describe("moveHandle", () => {
  it("drags one handle and keeps the other in place", () => {
    const marks = moveHandle({ a: 10, b: 20 }, "a", 15, 100);
    expect(marks).toEqual({ a: 15, b: 20 });
    expect(moveHandle({ a: 10, b: 20 }, "b", 25, 100)).toEqual({ a: 10, b: 25 });
  });

  it("never collapses the segment below the minimum length", () => {
    // Dragging A right past B stops at B - MIN_CLIP_SEC.
    expect(moveHandle({ a: 10, b: 12 }, "a", 30, 100)).toEqual({
      a: 12 - MIN_CLIP_SEC,
      b: 12,
    });
    expect(moveHandle({ a: 10, b: 12 }, "b", 2, 100)).toEqual({
      a: 10,
      b: 10 + MIN_CLIP_SEC,
    });
  });

  it("clamps handles to the file edges", () => {
    expect(moveHandle({ a: 10, b: 20 }, "a", -4, 100)).toEqual({ a: 0, b: 20 });
    expect(moveHandle({ a: 10, b: 20 }, "b", 400, 100)).toEqual({
      a: 10,
      b: 100,
    });
    // Incomplete marks: B alone may sit anywhere ≥ 0.
    expect(moveHandle({ a: null, b: null }, "b", 55, 100)).toEqual({
      a: null,
      b: 55,
    });
    // A dragged past a lone B stops at B - MIN (segment survives).
    expect(moveHandle({ a: null, b: 5 }, "a", 8, 100)).toEqual({
      a: 5 - MIN_CLIP_SEC,
      b: 5,
    });
  });
});

describe("moveSegment", () => {
  it("moves A and B together keeping the length", () => {
    const moved = moveSegment({ a: 10, b: 20 }, 5, 100);
    expect(moved).toEqual({ a: 15, b: 25 });
    expect(moveSegment({ a: 10, b: 20 }, -8, 100)).toEqual({ a: 2, b: 12 });
  });

  it("pins at the file edges without squashing", () => {
    expect(moveSegment({ a: 10, b: 20 }, -50, 100)).toEqual({ a: 0, b: 10 });
    expect(moveSegment({ a: 90, b: 98 }, 50, 100)).toEqual({ a: 92, b: 100 });
    expect(moveSegment({ a: 0, b: 100 }, 10, 100)).toEqual({ a: 0, b: 100 });
  });

  it("ignores incomplete ranges and garbage deltas", () => {
    const marks: ClipMarks = { a: 10, b: null };
    expect(moveSegment(marks, 5, 100)).toBe(marks);
    expect(moveSegment({ a: 10, b: 20 }, Number.NaN, 100)).toEqual({
      a: 10,
      b: 20,
    });
  });
});

describe("timelineSeconds", () => {
  it("maps pixels to seconds across the track", () => {
    // 200px track, 100s file.
    expect(timelineSeconds(50, 0, 200, 100)).toBe(25);
    expect(timelineSeconds(0, 10, 200, 100)).toBe(0);
    expect(timelineSeconds(300, 0, 200, 100)).toBe(100);
  });

  it("degrades to 0 on degenerate tracks", () => {
    expect(timelineSeconds(50, 0, 0, 100)).toBe(0);
    expect(timelineSeconds(50, 0, 200, 0)).toBe(0);
    expect(timelineSeconds(50, 0, 200, null)).toBe(0);
  });
});

describe("previewActionAt", () => {
  const marks = { a: 10, b: 20 };

  it("stops at the segment end without a loop", () => {
    expect(previewActionAt(15, marks, false)).toBe(null);
    expect(previewActionAt(19.99, marks, false)).toBe(null);
    expect(previewActionAt(20, marks, false)).toBe("stop");
  });

  it("loops back to A when the loop flag is on", () => {
    expect(previewActionAt(21, marks, true)).toBe("loop");
    expect(previewActionAt(9, marks, true)).toBe("loop");
    expect(previewActionAt(15, marks, true)).toBe(null);
  });

  it("stops when the range is incomplete", () => {
    expect(previewActionAt(5, { a: null, b: 10 }, true)).toBe("stop");
    expect(previewActionAt(5, { a: 10, b: 10 }, true)).toBe("stop");
  });
});

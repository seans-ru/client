import { describe, expect, it } from "vitest";
import {
  BRIGHTNESS_PER_PX,
  clampBrightness,
  clampSensitivity,
  clampVolume,
  classifySwipe,
  classifyTap,
  DOUBLE_TAP_MS,
  deltaFromSwipe,
  isLeftEdge,
  isRightEdge,
  SWIPE_THRESHOLD_PX,
  tapZoneForX,
  VOLUME_PER_PX,
} from "../src/features/player/extensions/gesturePolicy";

describe("tap zones and edges", () => {
  it("splits the video area into thirds", () => {
    expect(tapZoneForX(10, 300)).toBe("left");
    expect(tapZoneForX(150, 300)).toBe("center");
    expect(tapZoneForX(290, 300)).toBe("right");
    expect(tapZoneForX(5, 0)).toBe("center");
  });

  it("marks the 20% edge strips", () => {
    expect(isLeftEdge(50, 1000)).toBe(true);
    expect(isLeftEdge(250, 1000)).toBe(false);
    expect(isRightEdge(900, 1000)).toBe(true);
    expect(isRightEdge(700, 1000)).toBe(false);
    expect(isLeftEdge(0, 0)).toBe(false);
  });
});

describe("classifyTap", () => {
  it("needs the same zone inside the window for a double", () => {
    const t0 = { zone: "left" as const, time: 1000 };
    expect(classifyTap(t0, { zone: "left", time: 1200 })).toBe("double");
    expect(classifyTap(t0, { zone: "right", time: 1200 })).toBe("single");
    expect(classifyTap(t0, { zone: "left", time: 1000 + DOUBLE_TAP_MS + 1 })).toBe("single");
    expect(classifyTap(null, { zone: "left", time: 1200 })).toBe("single");
  });
});

describe("classifySwipe", () => {
  const base = {
    startX: 100,
    width: 1000,
    fullscreen: false,
    threshold: SWIPE_THRESHOLD_PX,
  };

  it("left edge vertical drag = volume", () => {
    expect(classifySwipe({ ...base, dx: 4, dy: -80 })).toBe("volume");
  });

  it("right edge vertical drag = brightness", () => {
    expect(
      classifySwipe({ ...base, startX: 950, dx: -4, dy: 80 }),
    ).toBe("brightness");
  });

  it("center downward flick exits fullscreen only in fullscreen", () => {
    expect(
      classifySwipe({ ...base, startX: 500, dx: 2, dy: 120, fullscreen: true }),
    ).toBe("exit-fullscreen");
    expect(
      classifySwipe({ ...base, startX: 500, dx: 2, dy: 120, fullscreen: false }),
    ).toBeNull();
  });

  it("horizontal / small / center-up drags are not gestures", () => {
    expect(classifySwipe({ ...base, startX: 500, dx: 200, dy: 10 })).toBeNull();
    expect(classifySwipe({ ...base, dx: 2, dy: 10 })).toBeNull();
    expect(
      classifySwipe({ ...base, startX: 500, dx: 2, dy: -120, fullscreen: true }),
    ).toBeNull();
  });

  it("vertical wins over horizontal past the threshold", () => {
    expect(classifySwipe({ ...base, dx: 30, dy: 60 })).toBe("volume");
  });
});

describe("swipe deltas and clamps", () => {
  it("upward drags increase the value, downward decrease", () => {
    expect(deltaFromSwipe(-100, 1, VOLUME_PER_PX)).toBeCloseTo(15);
    expect(deltaFromSwipe(100, 1, VOLUME_PER_PX)).toBeCloseTo(-15);
    expect(deltaFromSwipe(-100, 2, BRIGHTNESS_PER_PX)).toBeCloseTo(20);
    expect(deltaFromSwipe(100, 0, BRIGHTNESS_PER_PX)).toBeCloseTo(-10); // 0 → 1
  });

  it("clamps volume / brightness ranges", () => {
    expect(clampVolume(120)).toBe(100);
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(Number.NaN)).toBe(100);
    expect(clampBrightness(150)).toBe(100);
    expect(clampBrightness(-150)).toBe(-100);
  });

  it("snaps sensitivity to the nearest option", () => {
    expect(clampSensitivity(1)).toBe(1);
    expect(clampSensitivity(0.6)).toBe(0.5);
    expect(clampSensitivity(1.8)).toBe(2);
    expect(clampSensitivity(null)).toBe(1);
    expect(clampSensitivity(Number.NaN)).toBe(1);
  });
});

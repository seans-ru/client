import { describe, expect, it } from "vitest";
import {
  countdownSeconds,
  createPositionTrack,
  parseTriggerMode,
  parseWatchedPolicy,
  shouldOffer,
  trackPosition,
  triggerWindowSec,
  watchedDecision,
  EOF_GRACE_SEC,
  SEEK_JUMP_SLACK_SEC,
  TRIGGER_MODES,
  type PositionTrack,
} from "../src/features/player/extensions/autoNextPolicy";

describe("parseTriggerMode / parseWatchedPolicy", () => {
  it("keeps known values and falls back to defaults", () => {
    expect(parseTriggerMode("10")).toBe("10");
    expect(parseTriggerMode("5p")).toBe("5p");
    expect(parseTriggerMode("99")).toBe("15");
    expect(parseWatchedPolicy("skip")).toBe("skip");
    expect(parseWatchedPolicy("offer")).toBe("offer");
    expect(parseWatchedPolicy(undefined)).toBe("offer");
  });
});

describe("triggerWindowSec", () => {
  it("returns fixed windows for the seconds modes", () => {
    expect(triggerWindowSec(3600, "10")).toBe(10);
    expect(triggerWindowSec(3600, "15")).toBe(15);
    expect(triggerWindowSec(3600, "30")).toBe(30);
    expect(triggerWindowSec(0, "30")).toBe(30);
  });

  it("computes percent windows from the duration", () => {
    expect(triggerWindowSec(1000, "5p")).toBeCloseTo(50);
    expect(triggerWindowSec(1000, "10p")).toBeCloseTo(100);
    // Unknown duration: percentage modes degrade to a sane default.
    expect(triggerWindowSec(0, "5p")).toBe(15);
    expect(triggerWindowSec(0, "10p")).toBe(30);
    for (const mode of TRIGGER_MODES) {
      expect(triggerWindowSec(600, mode)).toBeGreaterThan(0);
    }
  });
});

describe("trackPosition", () => {
  const base = {
    durationSec: 100,
    windowSec: 15,
    eof: false,
    speed: 1,
  };

  it("treats smooth playback advance as viewing (no suppression)", () => {
    let track = createPositionTrack();
    let r = trackPosition(track, { ...base, positionSec: 84, nowMs: 1000 });
    track = r.track;
    expect(r.jumped).toBe(false);
    // 2 s of playback enters the window (100 - 15 = 85 s).
    r = trackPosition(track, { ...base, positionSec: 86, nowMs: 3000 });
    expect(r.jumped).toBe(false);
    expect(r.track.suppress).toBe(false);
    expect(r.inWindow).toBe(true);
  });

  it("suppresses when a seek lands inside the end zone", () => {
    let track = createPositionTrack();
    track = trackPosition(track, { ...base, positionSec: 50, nowMs: 1000 }).track;
    const r = trackPosition(track, { ...base, positionSec: 97, nowMs: 1500 });
    expect(r.jumped).toBe(true);
    expect(r.track.suppress).toBe(true);
    expect(r.inWindow).toBe(true);
  });

  it("does not suppress a seek outside the end zone and resets after", () => {
    let track: PositionTrack = {
      ...createPositionTrack(),
      suppress: true,
      lastPos: 97,
      lastTimeMs: 1000,
    };
    const r = trackPosition(track, { ...base, positionSec: 40, nowMs: 1500 });
    expect(r.jumped).toBe(true);
    expect(r.track.suppress).toBe(false);
    expect(r.inWindow).toBe(false);
  });

  it("treats a backward jump as a seek", () => {
    let track = createPositionTrack();
    track = trackPosition(track, { ...base, positionSec: 90, nowMs: 1000 }).track;
    const r = trackPosition(track, { ...base, positionSec: 20, nowMs: 1200 });
    expect(r.jumped).toBe(true);
    expect(r.track.suppress).toBe(false);
  });

  it("natural playback into the zone never suppresses", () => {
    let track = createPositionTrack();
    track = trackPosition(track, { ...base, positionSec: 84, nowMs: 0 }).track;
    // 2 s of playback crosses the 85 s boundary (window = 15 s).
    const r = trackPosition(track, { ...base, positionSec: 86, nowMs: 2000 });
    expect(r.jumped).toBe(false);
    expect(r.track.suppress).toBe(false);
    expect(r.inWindow).toBe(true);
  });

  it("high playback speed does not fake a seek", () => {
    let track = createPositionTrack();
    track = trackPosition(track, {
      ...base,
      speed: 2,
      positionSec: 10,
      nowMs: 0,
    }).track;
    const r = trackPosition(track, {
      ...base,
      speed: 2,
      positionSec: 14,
      nowMs: 2000,
    });
    expect(r.jumped).toBe(false);
  });

  it("first sample never counts as a seek", () => {
    const r = trackPosition(createPositionTrack(), {
      ...base,
      positionSec: 98,
      nowMs: 5000,
    });
    expect(r.jumped).toBe(false);
  });

  it("slack constant keeps tiny jitter out of seek detection", () => {
    expect(SEEK_JUMP_SLACK_SEC).toBeGreaterThanOrEqual(2);
  });
});

describe("shouldOffer", () => {
  const track: PositionTrack = {
    lastPos: 0,
    lastTimeMs: 0,
    lastSpeed: 1,
    suppress: false,
    dismissed: false,
  };

  it("offers in the window / at eof", () => {
    expect(
      shouldOffer({
        enabled: true,
        hasPlayableNext: true,
        track,
        inWindow: true,
        remainingSec: 10,
        eof: false,
      }),
    ).toBe(true);
    expect(
      shouldOffer({
        enabled: true,
        hasPlayableNext: true,
        track,
        inWindow: true,
        remainingSec: 0,
        eof: true,
      }),
    ).toBe(true);
  });

  it("does not offer outside the window, without a next episode, or when off", () => {
    expect(
      shouldOffer({
        enabled: true,
        hasPlayableNext: true,
        track,
        inWindow: false,
        remainingSec: 300,
        eof: false,
      }),
    ).toBe(false);
    expect(
      shouldOffer({
        enabled: true,
        hasPlayableNext: false,
        track,
        inWindow: true,
        remainingSec: 5,
        eof: false,
      }),
    ).toBe(false);
    expect(
      shouldOffer({
        enabled: false,
        hasPlayableNext: true,
        track,
        inWindow: true,
        remainingSec: 5,
        eof: false,
      }),
    ).toBe(false);
  });

  it("honours user-seek suppression and dismissal", () => {
    expect(
      shouldOffer({
        enabled: true,
        hasPlayableNext: true,
        track: { ...track, suppress: true },
        inWindow: true,
        remainingSec: 5,
        eof: true,
      }),
    ).toBe(false);
    expect(
      shouldOffer({
        enabled: true,
        hasPlayableNext: true,
        track: { ...track, dismissed: true },
        inWindow: true,
        remainingSec: 5,
        eof: false,
      }),
    ).toBe(false);
  });
});

describe("countdownSeconds", () => {
  it("counts the remaining file seconds and uses the eof grace at the end", () => {
    expect(countdownSeconds(12.4, false)).toBe(12.4);
    expect(countdownSeconds(0, false)).toBe(0);
    expect(countdownSeconds(0, true)).toBe(EOF_GRACE_SEC);
    expect(countdownSeconds(-3, true)).toBe(EOF_GRACE_SEC);
  });
});

describe("watchedDecision", () => {
  it("offers unseen episodes and follows the watched policy", () => {
    expect(watchedDecision(false, "offer")).toBe("offer");
    expect(watchedDecision(false, "skip")).toBe("offer");
    expect(watchedDecision(true, "offer")).toBe("offer-watched");
    expect(watchedDecision(true, "skip")).toBe("skip");
  });
});

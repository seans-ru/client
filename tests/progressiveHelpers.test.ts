import { describe, expect, it } from "vitest";
import {
  BUFFER_WAITING_LABEL,
  checkSeek,
  downloadedRailRatio,
  formatProgressLabels,
  formatSeekableUntil,
  isRangeAvailable,
  mapByteRangeToSlices,
  resolveDownloadProgress,
  resolveDurationSec,
  resolvePlaybackMode,
  resolveSeekLimit,
  resolveSeekableRatio,
  SEEK_BLOCKED_TOAST,
  seekableRailRatio,
  seekLimitFromPlayback,
  shouldAutoResumeAfterGrowth,
  shouldPauseAtSeekEdge,
} from "../src/features/player/progressiveHelpers";

describe("resolvePlaybackMode", () => {
  it("maps ready/complete flags", () => {
    expect(resolvePlaybackMode({ ready: true, complete: true })).toBe("vod");
    expect(resolvePlaybackMode({ ready: true, complete: false })).toBe(
      "progressive",
    );
    expect(resolvePlaybackMode({ ready: false, complete: false })).toBe(
      "waiting",
    );
    expect(resolvePlaybackMode(null)).toBe("waiting");
  });
});

describe("resolveSeekableRatio", () => {
  it("prefers max_seekable_bytes / size_bytes", () => {
    expect(
      resolveSeekableRatio({
        maxSeekableBytes: 50,
        sizeBytes: 200,
        percentSeekable: 99,
      }),
    ).toBeCloseTo(0.25);
  });

  it("falls back to percent_seekable", () => {
    expect(resolveSeekableRatio({ percentSeekable: 32 })).toBeCloseTo(0.32);
  });

  it("returns null when unknown", () => {
    expect(resolveSeekableRatio({})).toBeNull();
    expect(
      resolveSeekableRatio({ maxSeekableBytes: 10, sizeBytes: 0 }),
    ).toBeNull();
  });
});

describe("resolveDurationSec", () => {
  it("uses duration_sec / duration / duration_ms", () => {
    expect(resolveDurationSec({ durationSec: 120 })).toBe(120);
    expect(resolveDurationSec({ duration: 90 })).toBe(90);
    expect(resolveDurationSec({ durationMs: 61000 })).toBeCloseTo(61);
    expect(resolveDurationSec({ durationMs: 0 })).toBeNull();
    expect(resolveDurationSec({})).toBeNull();
  });
});

describe("resolveSeekLimit", () => {
  it("computes maxSeekableSec = duration * seekableRatio", () => {
    const limit = resolveSeekLimit({
      durationMs: 100_000,
      maxSeekableBytes: 25,
      sizeBytes: 100,
    });
    expect(limit.durationSec).toBeCloseTo(100);
    expect(limit.seekableRatio).toBeCloseTo(0.25);
    expect(limit.maxSeekableSec).toBeCloseTo(25);
  });

  it("matches contract formula duration_ms * percent_seekable / 100", () => {
    const limit = resolveSeekLimit({
      durationMs: 200_000,
      percentSeekable: 3.2,
    });
    expect(limit.maxSeekableSec).toBeCloseTo(200 * 3.2 / 100);
  });
});

describe("seekLimitFromPlayback", () => {
  it("unlocks full duration when complete", () => {
    const limit = seekLimitFromPlayback(
      {
        ready: true,
        complete: true,
        max_seekable_bytes: 1,
        percent_seekable: 1,
      },
      { size_bytes: 100, duration_ms: 80_000 },
    );
    expect(limit.maxSeekableSec).toBeCloseTo(80);
    expect(limit.seekableRatio).toBe(1);
  });

  it("keeps progressive ceiling when incomplete", () => {
    const limit = seekLimitFromPlayback(
      {
        ready: true,
        complete: false,
        max_seekable_bytes: 80,
        percent_seekable: 10,
      },
      { size_bytes: 800, duration_ms: 100_000 },
    );
    expect(limit.seekableRatio).toBeCloseTo(0.1);
    expect(limit.maxSeekableSec).toBeCloseTo(10);
  });
});

describe("resolveDownloadProgress", () => {
  it("reports downloaded and seekable independently", () => {
    const p = resolveDownloadProgress({
      percent_downloaded: 48,
      percent_seekable: 32,
      complete: false,
    });
    expect(p.percentDownloaded).toBe(48);
    expect(p.percentSeekable).toBe(32);
    expect(p.percentDownloaded).not.toBe(p.percentSeekable);
  });

  it("is 100/100 when complete", () => {
    expect(
      resolveDownloadProgress({
        percent_downloaded: 10,
        percent_seekable: 5,
        complete: true,
      }),
    ).toEqual({ percentDownloaded: 100, percentSeekable: 100 });
  });
});

describe("checkSeek", () => {
  const limit = {
    maxSeekableSec: 25,
    seekableRatio: 0.25,
    durationSec: 100,
  };

  it("allows seeks inside the prefix", () => {
    expect(checkSeek(25, limit, { mode: "progressive" })).toEqual({
      ok: true,
      seconds: 25,
    });
    expect(checkSeek(10, limit, { mode: "progressive" })).toEqual({
      ok: true,
      seconds: 10,
    });
  });

  it("blocks seeks past max_seekable_bytes without sending them", () => {
    const decision = checkSeek(80, limit, { mode: "progressive" });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("beyond_seekable");
      expect(decision.seconds).toBe(25);
    }
  });

  it("blocks seeks when not ready", () => {
    const decision = checkSeek(5, limit, { mode: "waiting" });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not_ready");
  });

  it("allows full range in vod mode", () => {
    expect(checkSeek(90, limit, { mode: "vod" })).toEqual({
      ok: true,
      seconds: 90,
    });
    const past = checkSeek(120, limit, { mode: "vod" });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.reason).toBe("beyond_duration");
  });
});

describe("seek bar ratios", () => {
  it("caps progressive scrub at the seekable prefix", () => {
    expect(
      seekableRailRatio(
        { maxSeekableSec: 25, seekableRatio: 0.25, durationSec: 100 },
        "progressive",
      ),
    ).toBeCloseTo(0.25);
    expect(
      seekableRailRatio(
        { maxSeekableSec: null, seekableRatio: null, durationSec: 100 },
        "vod",
      ),
    ).toBe(1);
  });

  it("downloaded ratio can exceed seekable ratio", () => {
    const progress = {
      percentDownloaded: 48,
      percentSeekable: 32,
    };
    expect(downloadedRailRatio(progress)).toBeCloseTo(0.48);
  });
});

describe("edge pause / auto-resume", () => {
  const limit = { maxSeekableSec: 25, seekableRatio: 0.25, durationSec: 100 };

  it("pauses at the contiguous prefix edge", () => {
    expect(shouldPauseAtSeekEdge(24.8, limit, "progressive")).toBe(true);
    expect(shouldPauseAtSeekEdge(10, limit, "progressive")).toBe(false);
    expect(shouldPauseAtSeekEdge(90, limit, "vod")).toBe(false);
  });

  it("resumes only when the prefix grows and we are waiting at the edge", () => {
    const prev = limit;
    const next = { ...limit, maxSeekableSec: 40, seekableRatio: 0.4 };
    expect(
      shouldAutoResumeAfterGrowth(prev, next, {
        mode: "progressive",
        waitingAtEdge: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoResumeAfterGrowth(prev, next, {
        mode: "progressive",
        waitingAtEdge: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoResumeAfterGrowth(next, next, {
        mode: "progressive",
        waitingAtEdge: true,
      }),
    ).toBe(false);
  });
});

describe("labels", () => {
  it("formats dual progress", () => {
    expect(
      formatProgressLabels({ percentDownloaded: 4.8, percentSeekable: 3.2 }),
    ).toEqual({
      downloaded: "Скачано 4.8%",
      seekable: "Доступно 3.2%",
    });
  });

  it("formats seekable-until and toasts", () => {
    expect(
      formatSeekableUntil({
        maxSeekableSec: 65,
        seekableRatio: 0.1,
        durationSec: 650,
      }),
    ).toBe("смотрите до 01:05");
    expect(SEEK_BLOCKED_TOAST).toContain("ещё скачивается");
    expect(BUFFER_WAITING_LABEL).toContain("Загрузка продолжается");
  });
});

describe("byte range mapping", () => {
  const segments = [
    { index: 0, start: 0, end: 100, url: "u0", available: true },
    { index: 1, start: 100, end: 200, url: "u1", available: true },
    { index: 2, start: 200, end: 300, url: "u2", available: false },
    { index: 3, start: 300, end: 400, url: "u3", available: true },
  ];

  it("clips to max_seekable_bytes and skips holes", () => {
    const slices = mapByteRangeToSlices(segments, 50, 350, 250);
    expect(slices).toEqual([
      { fileStart: 50, fileEnd: 100, segmentIndex: 0, url: "u0" },
      { fileStart: 100, fileEnd: 200, segmentIndex: 1, url: "u1" },
    ]);
  });

  it("detects holes in coverage", () => {
    expect(isRangeAvailable(segments, 0, 150, 400)).toBe(true);
    expect(isRangeAvailable(segments, 0, 250, 400)).toBe(false);
  });
});

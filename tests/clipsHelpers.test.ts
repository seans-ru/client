import { describe, expect, it, vi } from "vitest";
import {
  formatCloudStatus,
  generateShortCode,
  isMediaWatched,
  isShortCode,
  markMediaWatched,
  openClipsForMedia,
  resolveMomentSource,
  selectBestMoments,
  shareUrlForCode,
  shouldRevealSpoiler,
  watchedFromProgress,
  assetFromRecord,
} from "../src/features/clips/helpers";
import type { LocalCloudAsset } from "../src/features/clips/types";

describe("short codes and share urls", () => {
  it("generates 8-char [a-z0-9] codes", () => {
    const code = generateShortCode();
    expect(isShortCode(code)).toBe(true);
    expect(code).toHaveLength(8);
    expect(generateShortCode(() => 0)).toBe("aaaaaaaa");
  });

  it("validates code shapes", () => {
    expect(isShortCode("abcd1234")).toBe(true);
    expect(isShortCode("ABCD1234")).toBe(false);
    expect(isShortCode("abc-1234")).toBe(false);
    expect(isShortCode("short")).toBe(false);
    expect(isShortCode(42)).toBe(false);
  });

  it("builds the public share url", () => {
    expect(shareUrlForCode("abcd1234")).toBe(
      "https://seans.tedeshi.ru/c/abcd1234",
    );
  });
});

describe("watched flags", () => {
  it("uses the 95% history rule and the completed flag", () => {
    expect(watchedFromProgress(95, 100)).toBe(true);
    expect(watchedFromProgress(94, 100)).toBe(false);
    expect(watchedFromProgress(100, 100)).toBe(true);
    expect(watchedFromProgress(0, 100, true)).toBe(true);
    expect(watchedFromProgress(50, 0)).toBe(false);
    expect(watchedFromProgress(null, null)).toBe(false);
  });

  it("round-trips the local seans.watch.* flag", () => {
    const store = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
      configurable: true,
    });
    try {
      expect(isMediaWatched("42")).toBe(false);
      markMediaWatched("42");
      expect(isMediaWatched("42")).toBe(true);
      expect(isMediaWatched("43")).toBe(false);
      expect(store.get("seans.watch.42")).toBe("1");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: original,
        configurable: true,
      });
    }
  });
});

describe("spoiler gate", () => {
  it("hides spoilers from viewers who have not finished", () => {
    expect(shouldRevealSpoiler(false, false)).toBe(true);
    expect(shouldRevealSpoiler(true, false)).toBe(false);
    expect(shouldRevealSpoiler(true, null)).toBe(false);
    expect(shouldRevealSpoiler(true, true)).toBe(true);
  });
});

type Candidate = {
  kind: string;
  mediaId: string;
  spoiler: boolean;
  startSec: number | null;
  localId: string;
};

function candidate(partial: Partial<Candidate>): Candidate {
  return {
    kind: "clip",
    mediaId: "m1",
    spoiler: false,
    startSec: 0,
    localId: "x",
    ...partial,
  };
}

describe("selectBestMoments", () => {
  it("takes only clips of this media, sorted by start timecode", () => {
    const assets = [
      candidate({ localId: "finale", startSec: 3000 }),
      candidate({ localId: "intro", startSec: 10 }),
      candidate({ localId: "shot", kind: "screenshot", startSec: 5 }),
      candidate({ localId: "other", mediaId: "m2", startSec: 1 }),
    ];
    const best = selectBestMoments(assets, { mediaId: "m1", watched: true });
    expect(best.map((c) => c.localId)).toEqual(["intro", "finale"]);
  });

  it("keeps spoiler clips away from unwatched viewers", () => {
    const assets = [
      candidate({ localId: "spoiled", startSec: 50, spoiler: true }),
      candidate({ localId: "safe", startSec: 10 }),
    ];
    expect(
      selectBestMoments(assets, { mediaId: "m1", watched: false }).map(
        (c) => c.localId,
      ),
    ).toEqual(["safe"]);
    expect(
      selectBestMoments(assets, { mediaId: "m1", watched: true }).map(
        (c) => c.localId,
      ),
    ).toEqual(["safe", "spoiled"]);
  });

  it("orders clips without a start last", () => {
    const assets = [
      candidate({ localId: "late", startSec: 100 }),
      candidate({ localId: "nostart", startSec: null }),
      candidate({ localId: "early", startSec: 1 }),
    ];
    expect(
      selectBestMoments(assets, { mediaId: "m1", watched: true }).map(
        (c) => c.localId,
      ),
    ).toEqual(["early", "late", "nostart"]);
  });
});

describe("openClipsForMedia", () => {
  it("filters by media and spoiler only (visibility is the server's job)", () => {
    const assets = [
      candidate({ localId: "a" }),
      candidate({ localId: "b", spoiler: true }),
      candidate({ localId: "c", mediaId: "m2" }),
    ];
    expect(
      openClipsForMedia(assets, { mediaId: "m1", watched: true }).map(
        (c) => c.localId,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("formatCloudStatus / resolveMomentSource / assetFromRecord", () => {
  it("labels every registry status", () => {
    expect(formatCloudStatus("pending")).toBe("Ожидает загрузки");
    expect(formatCloudStatus("uploading")).toBe("Загрузка…");
    expect(formatCloudStatus("uploaded")).toBe("В облаке");
    expect(formatCloudStatus("failed", "boom")).toContain("boom");
  });

  it("prefers the local file while it exists", () => {
    expect(
      resolveMomentSource({
        localPath: "C:/clip.mp4",
        fileUrl: "https://cdn/clip.mp4",
        localExists: true,
      }),
    ).toBe("C:/clip.mp4");
    expect(
      resolveMomentSource({
        localPath: "C:/clip.mp4",
        fileUrl: "https://cdn/clip.mp4",
        localExists: false,
      }),
    ).toBe("https://cdn/clip.mp4");
    expect(
      resolveMomentSource({ localPath: null, fileUrl: null }),
    ).toBeNull();
  });

  it("merges a server record into the local entry", () => {
    const base = {
      localId: "l1",
      kind: "clip",
      mediaId: "m1",
      title: null,
      spoiler: false,
      visibility: "by_link",
      status: "uploading",
      error: null,
      localPath: "C:/x.mp4",
      startSec: 1,
      endSec: 2,
      atSec: null,
      id: null,
      code: "local0001",
      url: null,
      fileUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies LocalCloudAsset;
    const merged = assetFromRecord(
      base,
      {
        id: "cl_9",
        code: "abcd1234",
        url: "https://seans.tedeshi.ru/c/abcd1234",
        visibility: "open",
        spoiler: true,
        createdAt: "2026-02-02T00:00:00Z",
        mediaId: "m1",
        startSec: 1,
        endSec: 2,
        atSec: null,
        title: null,
        fileUrl: "https://cdn/9.mp4",
      },
      new Date("2026-03-03T00:00:00Z"),
    );
    expect(merged.status).toBe("uploaded");
    expect(merged.id).toBe("cl_9");
    expect(merged.code).toBe("abcd1234");
    expect(merged.visibility).toBe("open");
    expect(merged.spoiler).toBe(true);
    expect(merged.updatedAt).toBe("2026-03-03T00:00:00.000Z");
  });

  it("never throws on clipboard-less environments", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => markMediaWatched("no-store")).not.toThrow();
    spy.mockRestore();
  });
});

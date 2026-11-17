import { describe, expect, it } from "vitest";
import {
  clipUploadMeta,
  isCloudAssetKind,
  parseCloudAssetList,
  parseCloudAssetRecord,
  parseVisibility,
  screenshotUploadMeta,
  CLIP_VISIBILITIES,
} from "../src/features/clips/types";

describe("parseVisibility", () => {
  it("keeps known values and falls back to closed", () => {
    for (const v of CLIP_VISIBILITIES) expect(parseVisibility(v)).toBe(v);
    expect(parseVisibility("open ")).toBe("closed");
    expect(parseVisibility(null)).toBe("closed");
    expect(parseVisibility(42)).toBe("closed");
  });
});

describe("isCloudAssetKind", () => {
  it("accepts clip and screenshot only", () => {
    expect(isCloudAssetKind("clip")).toBe(true);
    expect(isCloudAssetKind("screenshot")).toBe(true);
    expect(isCloudAssetKind("video")).toBe(false);
    expect(isCloudAssetKind(null)).toBe(false);
  });
});

describe("parseCloudAssetRecord", () => {
  it("normalizes the snake_case contract payload", () => {
    const record = parseCloudAssetRecord({
      id: "cl_1",
      code: "a1b2c3d4",
      url: "https://seans.tedeshi.ru/c/a1b2c3d4",
      visibility: "by_link",
      spoiler: true,
      created_at: "2026-11-17T12:00:00Z",
      media_id: "123",
      start_sec: 12.5,
      end_sec: 45,
      title: "Момент",
      file_url: "https://cdn/x.mp4",
    });
    expect(record).toEqual({
      id: "cl_1",
      code: "a1b2c3d4",
      url: "https://seans.tedeshi.ru/c/a1b2c3d4",
      visibility: "by_link",
      spoiler: true,
      createdAt: "2026-11-17T12:00:00Z",
      mediaId: "123",
      startSec: 12.5,
      endSec: 45,
      atSec: null,
      title: "Момент",
      fileUrl: "https://cdn/x.mp4",
    });
  });

  it("accepts camelCase too and synthesizes the share url", () => {
    const record = parseCloudAssetRecord({
      id: "cl_2",
      code: "zzzz9999",
      visibility: "open",
      createdAt: "2026-01-01T00:00:00Z",
      mediaId: "5",
      atSec: 3,
    });
    expect(record?.url).toBe("https://seans.tedeshi.ru/c/zzzz9999");
    expect(record?.atSec).toBe(3);
    expect(record?.spoiler).toBe(false);
  });

  it("rejects junk rows instead of throwing", () => {
    expect(parseCloudAssetRecord(null)).toBeNull();
    expect(parseCloudAssetRecord("x")).toBeNull();
    expect(parseCloudAssetRecord({})).toBeNull();
  });
});

describe("parseCloudAssetList", () => {
  it("accepts items / clips / bare arrays and skips junk", () => {
    const row = { id: "1", code: "abcd1234" };
    expect(parseCloudAssetList({ items: [row, null] })).toHaveLength(1);
    expect(parseCloudAssetList({ clips: [row] })).toHaveLength(1);
    expect(parseCloudAssetList([row, 42])).toHaveLength(1);
    expect(parseCloudAssetList(null)).toEqual([]);
    expect(parseCloudAssetList({ items: "nope" })).toEqual([]);
  });
});

describe("upload meta builders", () => {
  it("builds the clip meta (snake_case per contract)", () => {
    expect(
      clipUploadMeta({
        mediaId: "9",
        startSec: 1,
        endSec: 2.5,
        title: "  ",
        spoiler: true,
        visibility: "open",
      }),
    ).toEqual({
      media_id: "9",
      start_sec: 1,
      end_sec: 2.5,
      spoiler: true,
      visibility: "open",
    });
    expect(
      clipUploadMeta({
        mediaId: "9",
        startSec: 0,
        endSec: 1,
        title: "Т",
        spoiler: false,
        visibility: "bad-garbage" as never,
      }).visibility,
    ).toBe("closed");
  });

  it("builds the screenshot meta", () => {
    expect(
      screenshotUploadMeta({
        mediaId: "9",
        atSec: 88.2,
        spoiler: false,
        visibility: "by_link",
      }),
    ).toEqual({
      media_id: "9",
      at_sec: 88.2,
      spoiler: false,
      visibility: "by_link",
    });
  });
});

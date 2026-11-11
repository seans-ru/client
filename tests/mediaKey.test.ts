import { describe, expect, it } from "vitest";
import {
  hashString,
  mediaKeyFromSnapshot,
  mediaKeyFromUrl,
  needsSnapshotKey,
  PROGRESSIVE_MEDIA_KEY,
} from "../src/features/player/extensions/mediaKey";

describe("mediaKeyFromUrl", () => {
  it("keeps the stable object path and drops the presigned query", () => {
    const a = mediaKeyFromUrl(
      "https://cdn.example.com/bucket/show/s01e02.mkv?X-Amz-Signature=abc",
    );
    const b = mediaKeyFromUrl(
      "https://cdn.example.com/bucket/show/s01e02.mkv?X-Amz-Signature=zzz",
    );
    expect(a).toBe(b);
    expect(a).toBe("cdn.example.com/bucket/show/s01e02.mkv");
  });

  it("distinguishes different object paths", () => {
    expect(mediaKeyFromUrl("https://cdn.example.com/a/s01e01.mkv")).not.toBe(
      mediaKeyFromUrl("https://cdn.example.com/a/s01e02.mkv"),
    );
  });

  it("collapses the progressive loopback URL to a placeholder", () => {
    expect(mediaKeyFromUrl("http://127.0.0.1:41235/")).toBe(
      PROGRESSIVE_MEDIA_KEY,
    );
    expect(mediaKeyFromUrl("http://localhost:8080")).toBe(
      PROGRESSIVE_MEDIA_KEY,
    );
  });

  it("handles empty / unparseable URLs", () => {
    expect(mediaKeyFromUrl("")).toBe("unknown");
    expect(mediaKeyFromUrl("   ")).toBe("unknown");
    expect(mediaKeyFromUrl("not a url")).toBe("not a url");
  });

  it("needsSnapshotKey is true only for the loopback placeholder", () => {
    expect(needsSnapshotKey("http://127.0.0.1:1/")).toBe(true);
    expect(needsSnapshotKey("https://cdn.example.com/a.mkv?sig=1")).toBe(false);
  });
});

describe("mediaKeyFromSnapshot", () => {
  const snapshot = {
    duration: 1425.6,
    video_w: 1920,
    video_h: 1080,
    tracks: [
      { kind: "video", lang: "", title: "" },
      { kind: "audio", lang: "ja", title: "" },
      { kind: "sub", lang: "ru", title: "Full" },
    ],
  };

  it("keeps the URL key for VOD sources", () => {
    expect(
      mediaKeyFromSnapshot("https://cdn.example.com/a.mkv?sig=1", snapshot),
    ).toBe("cdn.example.com/a.mkv");
  });

  it("builds a content signature for the progressive placeholder", () => {
    const key = mediaKeyFromSnapshot("http://127.0.0.1:41235/", snapshot);
    expect(key).toContain(PROGRESSIVE_MEDIA_KEY);
    expect(key).toContain("1920x1080");
    expect(key).toContain("1426");
    // Stable for the same file shape.
    expect(
      mediaKeyFromSnapshot("http://127.0.0.1:9/", { ...snapshot }),
    ).toBe(key);
  });

  it("separates files with different duration or tracks", () => {
    const base = mediaKeyFromSnapshot("http://127.0.0.1:1/", snapshot);
    const otherDuration = mediaKeyFromSnapshot("http://127.0.0.1:1/", {
      ...snapshot,
      duration: 2000,
    });
    const otherTracks = mediaKeyFromSnapshot("http://127.0.0.1:1/", {
      ...snapshot,
      tracks: [{ kind: "audio", lang: "en", title: "" }],
    });
    expect(otherDuration).not.toBe(base);
    expect(otherTracks).not.toBe(base);
  });
});

describe("hashString", () => {
  it("is stable and hex-padded", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashString("abc")).not.toBe(hashString("abd"));
    expect(hashString("")).toMatch(/^[0-9a-f]{8}$/);
  });
});

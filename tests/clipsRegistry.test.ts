import { describe, expect, it, vi } from "vitest";
import {
  createCloudRegistry,
  makeLocalAsset,
} from "../src/features/clips/registry";

function withFakeLocalStorage<T>(run: () => T): T {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      value: original,
      configurable: true,
    });
  }
}

describe("makeLocalAsset", () => {
  it("creates a pending row with the contract defaults", () => {
    const asset = makeLocalAsset({
      kind: "clip",
      mediaId: "m1",
      localPath: "C:/clip.mp4",
      startSec: 1,
      endSec: 2,
      localId: "l1",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(asset).toMatchObject({
      localId: "l1",
      kind: "clip",
      mediaId: "m1",
      status: "pending",
      spoiler: false,
      visibility: "closed",
      startSec: 1,
      endSec: 2,
      code: null,
    });
    expect(asset.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("normalizes garbage visibility", () => {
    const asset = makeLocalAsset({
      kind: "screenshot",
      mediaId: "",
      localPath: null,
      atSec: 5,
      localId: "l2",
      visibility: "nope" as never,
    });
    expect(asset.visibility).toBe("closed");
    expect(asset.atSec).toBe(5);
  });
});

describe("createCloudRegistry", () => {
  it("upserts, patches and removes entries per kind", () => {
    withFakeLocalStorage(() => {
      const registry = createCloudRegistry();
      const clip = makeLocalAsset({
        kind: "clip",
        mediaId: "m1",
        localPath: "C:/a.mp4",
        localId: "l1",
      });
      registry.upsert(clip);
      registry.upsert(
        makeLocalAsset({
          kind: "screenshot",
          mediaId: "m1",
          localPath: "C:/s.png",
          atSec: 3,
          localId: "l2",
        }),
      );
      expect(registry.list()).toHaveLength(2);
      expect(registry.listByKind("clip").map((a) => a.localId)).toEqual(["l1"]);

      const patched = registry.patch("l1", {
        status: "uploaded",
        code: "abcd1234",
        visibility: "open",
      });
      expect(patched?.status).toBe("uploaded");
      expect(patched?.code).toBe("abcd1234");
      expect(registry.get("l1")?.visibility).toBe("open");
      expect(registry.patch("missing", { status: "failed" })).toBeNull();

      registry.remove("l1");
      expect(registry.listByKind("clip")).toHaveLength(0);
      expect(registry.list()).toHaveLength(1);
    });
  });

  it("persists to seans.player.ext.capture.cloud.* and survives a reload", () => {
    withFakeLocalStorage(() => {
      const registry = createCloudRegistry();
      registry.upsert(
        makeLocalAsset({
          kind: "clip",
          mediaId: "m1",
          localPath: "C:/a.mp4",
          localId: "l1",
        }),
      );
      // A fresh registry instance reads the same localStorage keys.
      const second = createCloudRegistry();
      expect(second.get("l1")?.localPath).toBe("C:/a.mp4");
      expect(globalThis.localStorage?.getItem(
        "seans.player.ext.capture.cloud.clips",
      )).toContain("l1");
    });
  });

  it("notifies subscribers once per change and unsubscribes", () => {
    withFakeLocalStorage(() => {
      const registry = createCloudRegistry();
      const cb = vi.fn();
      const stop = registry.subscribe(cb);
      registry.upsert(
        makeLocalAsset({
          kind: "clip",
          mediaId: "m1",
          localPath: null,
          localId: "l1",
        }),
      );
      registry.patch("l1", { spoiler: true });
      stop();
      registry.patch("l1", { spoiler: false });
      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  it("degrades to in-memory when localStorage throws", () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("quota");
        },
      },
      configurable: true,
    });
    try {
      const registry = createCloudRegistry();
      expect(() =>
        registry.upsert(
          makeLocalAsset({
            kind: "clip",
            mediaId: "m1",
            localPath: "C:/a.mp4",
            localId: "l1",
          }),
        ),
      ).not.toThrow();
      expect(registry.get("l1")?.localId).toBe("l1");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: original,
        configurable: true,
      });
    }
  });
});

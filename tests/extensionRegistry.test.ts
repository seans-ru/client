import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionRuntime,
  type ExtensionRuntimeDeps,
} from "../src/features/player/extensions/registry";
import {
  createExtensionStorage,
  extensionStorageKey,
} from "../src/features/player/extensions/storage";
import { DEFAULT_SNAPSHOT } from "../src/features/player/playerTypes";
import type {
  OpenInfo,
  PlayerExtension,
} from "../src/features/player/extensions/types";

function makeDeps(overrides: Partial<ExtensionRuntimeDeps> = {}): ExtensionRuntimeDeps {
  return {
    transport: {
      play: async () => {},
      pause: async () => {},
      togglePause: async () => {},
      seek: async () => {},
      setSpeed: async () => {},
      setVolume: async () => {},
      setMute: async () => {},
      setFullscreen: async () => {},
    },
    getSnapshot: () => DEFAULT_SNAPSHOT,
    mpv: {
      getProperty: async () => "",
      setProperty: async () => {},
      command: async () => null,
    },
    frames: { subscribe: () => () => {} },
    storageFor: (extId) => createExtensionStorage(extId),
    setChromeHidden: () => {},
    ...overrides,
  };
}

function ext(
  id: string,
  setup: PlayerExtension["setup"],
): PlayerExtension {
  return { id, name: id, setup };
}

describe("createExtensionRuntime (lifecycle)", () => {
  it("runs setup in declaration order and dispose in reverse", () => {
    const order: string[] = [];
    const runtime = createExtensionRuntime(
      [
        ext("a", () => {
          order.push("setup:a");
          return () => order.push("dispose:a");
        }),
        ext("b", () => {
          order.push("setup:b");
          return () => order.push("dispose:b");
        }),
        ext("c", () => {
          order.push("setup:c");
        }),
      ],
      makeDeps(),
    );
    expect(order).toEqual(["setup:a", "setup:b", "setup:c"]);
    runtime.dispose();
    expect(order).toEqual([
      "setup:a",
      "setup:b",
      "setup:c",
      "dispose:b",
      "dispose:a",
    ]);
  });

  it("ignores duplicate ids (first registration wins)", () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setups: string[] = [];
    const runtime = createExtensionRuntime(
      [
        ext("dup", () => {
          setups.push("first");
        }),
        ext("dup", () => {
          setups.push("second");
        }),
      ],
      makeDeps(),
    );
    expect(setups).toEqual(["first"]);
    expect(runtime.extensions.map((e) => e.id)).toEqual(["dup"]);
    warns.mockRestore();
  });

  it("isolates a throwing setup from other extensions", () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reached: string[] = [];
    const runtime = createExtensionRuntime(
      [
        ext("boom", () => {
          throw new Error("setup failed");
        }),
        ext("ok", () => {
          reached.push("ok");
        }),
      ],
      makeDeps(),
    );
    expect(reached).toEqual(["ok"]);
    // Dispose of the half-registered extension must not throw either.
    expect(() => runtime.dispose()).not.toThrow();
    warns.mockRestore();
  });
});

describe("createExtensionRuntime (events)", () => {
  it("fans events out to subscribers with payloads", () => {
    const info: OpenInfo = {
      url: "http://x/v.mkv",
      startAt: 12,
      source: "vod",
    };
    const open: OpenInfo[] = [];
    const closes: number[] = [];
    const snaps: number[] = [];
    const runtime = createExtensionRuntime(
      [
        ext("a", (ctx) => {
          ctx.onOpen((i) => open.push(i));
          ctx.onClose(() => closes.push(1));
          ctx.onSnapshot((s) => snaps.push(s.position));
        }),
      ],
      makeDeps(),
    );
    runtime.notifyOpen(info);
    runtime.notifyClose();
    runtime.notifySnapshot({ ...DEFAULT_SNAPSHOT, position: 42 });
    expect(open).toEqual([info]);
    expect(closes).toEqual([1]);
    expect(snaps).toEqual([42]);
    runtime.dispose();
  });

  it("stops delivery after unsubscribe and isolates throwing listeners", () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    const runtime = createExtensionRuntime(
      [
        ext("thrower", (ctx) => {
          ctx.onSnapshot(() => {
            throw new Error("listener failed");
          });
        }),
        ext("normal", (ctx) => {
          const off = ctx.onSnapshot(() => seen.push("tick"));
          ctx.onSnapshot(() => seen.push("once"));
          // Unsubscribe the first listener immediately.
          off();
          return () => seen.push("disposed");
        }),
      ],
      makeDeps(),
    );
    runtime.notifySnapshot(DEFAULT_SNAPSHOT);
    // Only the still-subscribed listener fired; the throw was isolated.
    expect(seen).toEqual(["once"]);
    runtime.dispose();
    expect(seen).toEqual(["once", "disposed"]);
    warns.mockRestore();
  });
});

describe("createExtensionRuntime (slots)", () => {
  it("collects slot entries in registration order and renders them", () => {
    const runtime = createExtensionRuntime(
      [
        ext("a", (ctx) => {
          ctx.ui.add("settings.menu", () => "A1");
          ctx.ui.add("overlay", () => "A2");
        }),
        ext("b", (ctx) => {
          ctx.ui.add("settings.menu", () => "B1");
        }),
      ],
      makeDeps(),
    );
    const menu = runtime.getSlotEntries("settings.menu");
    expect(menu.map((e) => e.extId)).toEqual(["a", "b"]);
    expect(menu.map((e) => e.render())).toEqual(["A1", "B1"]);
    expect(runtime.getSlotEntries("overlay").map((e) => e.render())).toEqual([
      "A2",
    ]);
    expect(runtime.getSlotEntries("controls.primary")).toEqual([]);
    runtime.dispose();
  });

  it("ui.add unsubscribe removes the entry and notifies listeners", () => {
    const offs: Array<() => void> = [];
    let changed = 0;
    const runtime = createExtensionRuntime(
      [
        ext("a", (ctx) => {
          offs.push(ctx.ui.add("sidecar", () => "X"));
          ctx.ui.add("sidecar", () => "Y");
        }),
      ],
      makeDeps(),
    );
    runtime.subscribeSlots(() => {
      changed += 1;
    });
    expect(runtime.getSlotEntries("sidecar")).toHaveLength(2);
    const before = changed;
    offs[0]();
    expect(runtime.getSlotEntries("sidecar").map((e) => e.render())).toEqual([
      "Y",
    ]);
    expect(changed).toBe(before + 1);
    // Double-unsubscribe is a no-op.
    offs[0]();
    expect(changed).toBe(before + 1);
    runtime.dispose();
  });

  it("wraps slot render errors without breaking the host", () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createExtensionRuntime(
      [
        ext("bad", (ctx) => {
          ctx.ui.add("overlay", () => {
            throw new Error("render failed");
          });
        }),
      ],
      makeDeps(),
    );
    const entries = runtime.getSlotEntries("overlay");
    expect(entries).toHaveLength(1);
    expect(entries[0].render()).toBeNull();
    warns.mockRestore();
    runtime.dispose();
  });
});

describe("createExtensionRuntime (chrome)", () => {
  it("routes ctx.ui.setChromeHidden to the host actuator", () => {
    const calls: boolean[] = [];
    const runtime = createExtensionRuntime(
      [
        ext("a", (ctx) => {
          ctx.ui.setChromeHidden(true);
          ctx.ui.setChromeHidden(false);
        }),
      ],
      makeDeps({ setChromeHidden: (hidden) => calls.push(hidden) }),
    );
    expect(calls).toEqual([true, false]);
    runtime.dispose();
  });
});

describe("createExtensionStorage", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds namespaced keys", () => {
    expect(extensionStorageKey("my-ext", "enabled")).toBe(
      "seans.player.ext.my-ext.enabled",
    );
  });

  it("round-trips JSON values under the extension namespace", () => {
    const storage = createExtensionStorage("ambient");
    storage.set("enabled", true);
    storage.set("profile", { gain: -3 });
    expect(store.has("seans.player.ext.ambient.enabled")).toBe(true);
    expect(storage.get("enabled", false)).toBe(true);
    expect(storage.get("profile", null)).toEqual({ gain: -3 });
    // Other namespace is untouched.
    expect(createExtensionStorage("other").get("enabled", "none")).toBe(
      "none",
    );
  });

  it("returns the fallback for missing or corrupt values", () => {
    const storage = createExtensionStorage("ext");
    expect(storage.get("missing", 7)).toBe(7);
    store.set("seans.player.ext.ext.broken", "{not json");
    expect(storage.get("broken", "fallback")).toBe("fallback");
  });

  it("degrades gracefully without localStorage", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", undefined);
    const storage = createExtensionStorage("ext");
    expect(storage.get("k", 1)).toBe(1);
    expect(() => storage.set("k", 2)).not.toThrow();
  });
});

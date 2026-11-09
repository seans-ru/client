import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterCommands,
  getCommand,
  listCommands,
  orderForPalette,
  registerCommand,
  resetCommandBus,
  runCommand,
  subscribeCommands,
} from "../src/features/player/extensions/commands";
import { createExtensionRuntime } from "../src/features/player/extensions/registry";
import type { PlayerExtension } from "../src/features/player/extensions/types";
import { DEFAULT_SNAPSHOT } from "../src/features/player/playerTypes";

afterEach(() => {
  resetCommandBus();
  vi.restoreAllMocks();
});

describe("command bus", () => {
  it("registers, lists and runs commands", () => {
    const run = vi.fn();
    registerCommand("ext-a", { id: "demo", title: "Демо", run });
    expect(listCommands().map((c) => c.id)).toEqual(["demo"]);
    expect(getCommand("demo")?.extId).toBe("ext-a");
    runCommand("demo");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("first registration wins for duplicate ids", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = vi.fn();
    const second = vi.fn();
    registerCommand("a", { id: "dup", title: "Первый", run: first });
    registerCommand("b", { id: "dup", title: "Второй", run: second });
    expect(listCommands()).toHaveLength(1);
    runCommand("dup");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("unsubscribe removes the command and is idempotent", () => {
    const off = registerCommand("a", { id: "x", title: "X", run: () => {} });
    off();
    off();
    expect(listCommands()).toHaveLength(0);
  });

  it("errors in run are isolated (sync throw and rejected promise)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCommand("a", {
      id: "boom",
      title: "Boom",
      run: () => {
        throw new Error("nope");
      },
    });
    registerCommand("a", {
      id: "reject",
      title: "Reject",
      run: () => Promise.reject(new Error("later")),
    });
    expect(() => runCommand("boom")).not.toThrow();
    runCommand("reject");
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("unknown ids warn and do not throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => runCommand("missing")).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("notifies subscribers on register/unregister", () => {
    const cb = vi.fn();
    const stop = subscribeCommands(cb);
    const off = registerCommand("a", { id: "n", title: "N", run: () => {} });
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(cb).toHaveBeenCalledTimes(2);
    stop();
    registerCommand("a", { id: "m", title: "M", run: () => {} });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe("ctx.registerCommand", () => {
  const ext: PlayerExtension = {
    id: "cmd-ext",
    name: "cmd-ext",
    setup(ctx) {
      ctx.registerCommand({ id: "from-ctx", title: "Из контекста", run: () => {} });
    },
  };

  const deps = {
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
    storageFor: () => ({
      get: <T,>(_key: string, fallback: T) => fallback,
      set: () => {},
    }),
    setChromeHidden: () => {},
  };

  it("wires commands through the bus and auto-drops them at dispose", () => {
    const runtime = createExtensionRuntime([ext], deps);
    expect(getCommand("from-ctx")?.extId).toBe("cmd-ext");
    runtime.dispose();
    expect(getCommand("from-ctx")).toBeUndefined();
    expect(listCommands()).toHaveLength(0);
  });
});

describe("filterCommands", () => {
  const list = [
    { id: "1", extId: "e", title: "Пауза / воспроизведение", category: "Воспроизведение", keywords: ["play", "pause"], run: () => {} },
    { id: "2", extId: "e", title: "Громкость +5", category: "Звук", keywords: ["volume"], run: () => {} },
  ];

  it("returns everything for an empty query", () => {
    expect(filterCommands(list, "")).toHaveLength(2);
    expect(filterCommands(list, "   ")).toHaveLength(2);
  });

  it("matches title, category and keywords case-insensitively", () => {
    expect(filterCommands(list, "ПАУЗА").map((c) => c.id)).toEqual(["1"]);
    expect(filterCommands(list, "звук").map((c) => c.id)).toEqual(["2"]);
    expect(filterCommands(list, "play").map((c) => c.id)).toEqual(["1"]);
  });

  it("ANDs multiple words", () => {
    expect(filterCommands(list, "громкость volume").map((c) => c.id)).toEqual(["2"]);
    expect(filterCommands(list, "громкость play")).toHaveLength(0);
  });
});

describe("orderForPalette", () => {
  const list = [
    { id: "a", extId: "e", title: "A", run: () => {} },
    { id: "b", extId: "e", title: "B", run: () => {} },
    { id: "c", extId: "e", title: "C", run: () => {} },
  ];

  it("floats recent commands to the top in recency order", () => {
    const ordered = orderForPalette(list, ["c", "a"]);
    expect(ordered.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps registration order when nothing is recent", () => {
    expect(orderForPalette(list, []).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

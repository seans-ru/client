import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BEST_MOMENTS_COUNTDOWN_SEC,
  createBestMomentsController,
  loadFileArgs,
} from "../src/features/player/extensions/bestMoments";
import { createCloudRegistry, makeLocalAsset } from "../src/features/clips/registry";
import { setActiveMediaId } from "../src/features/clips/activeMedia";
import type { ClipsNative } from "../src/features/clips/api";
import type { MpvBridge } from "../src/features/player/extensions/types";
import {
  DEFAULT_SNAPSHOT,
  type PlayerSnapshot,
} from "../src/features/player/playerTypes";

function makeMpv(): MpvBridge & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    getProperty: async () => "",
    setProperty: async () => {},
    command: async (args: string[]) => {
      calls.push([...args]);
      return null;
    },
  };
}

function makeNative(exists: boolean): ClipsNative & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async uploadFile() {
      return { status: 201, body: "{}" };
    },
    async openUrl(url) {
      opened.push(url);
    },
    async fileExists() {
      return exists;
    },
  };
}

function seedRegistry(): ReturnType<typeof createCloudRegistry> {
  const registry = createCloudRegistry();
  registry.upsert({
    ...makeLocalAsset({
      kind: "clip",
      mediaId: "m1",
      localPath: "C:/clips/b.mp4",
      startSec: 300,
      endSec: 310,
      localId: "late",
    }),
    code: "late0001",
    fileUrl: "https://cdn/b.mp4",
    status: "uploaded",
  });
  registry.upsert({
    ...makeLocalAsset({
      kind: "clip",
      mediaId: "m1",
      localPath: "C:/clips/a.mp4",
      startSec: 5,
      endSec: 12,
      localId: "early",
    }),
    code: "early001",
    fileUrl: "https://cdn/a.mp4",
    status: "uploaded",
  });
  registry.upsert({
    ...makeLocalAsset({
      kind: "screenshot",
      mediaId: "m1",
      localPath: "C:/clips/s.png",
      atSec: 1,
      localId: "shot",
    }),
    code: "shot0001",
    status: "uploaded",
  });
  return registry;
}

function makeController(args: {
  exists?: boolean;
  registry?: ReturnType<typeof createCloudRegistry>;
}) {
  const mpv = makeMpv();
  const native = makeNative(args.exists ?? true);
  let snapshot: PlayerSnapshot = { ...DEFAULT_SNAPSHOT, file_loaded: true };
  const controller = createBestMomentsController({
    mpv,
    registry: args.registry ?? seedRegistry(),
    native,
    getSnapshot: () => snapshot,
  });
  return {
    controller,
    mpv,
    native,
    setSnapshot(next: Partial<PlayerSnapshot>) {
      snapshot = { ...snapshot, ...next };
    },
  };
}

describe("loadFileArgs", () => {
  it("replaces the current playlist entry (generic command bridge)", () => {
    expect(loadFileArgs("C:/clip.mp4")).toEqual([
      "loadfile",
      "C:/clip.mp4",
      "replace",
    ]);
  });
});

describe("createBestMomentsController", () => {
  beforeEach(() => {
    setActiveMediaId("m1");
    // Wipe the watched flag between tests (in-memory fallback is fine).
    setActiveMediaId("m1");
  });

  it("stays idle when this media has no clips", () => {
    const { controller } = makeController({
      registry: createCloudRegistry(),
    });
    controller.onEof();
    expect(controller.store.get().phase).toBe("idle");
  });

  it("shows the countdown card on EOF with clips sorted by start", () => {
    const { controller } = makeController({});
    controller.onEof();
    const state = controller.store.get();
    expect(state.phase).toBe("countdown");
    expect(state.secondsLeft).toBe(BEST_MOMENTS_COUNTDOWN_SEC);
    // Screenshots never take part; order is by startSec (finale after intro).
    expect(state.assets.map((a) => a.localId)).toEqual(["early", "late"]);
  });

  it("plays the local file when it exists, otherwise the cloud url", async () => {
    const local = makeController({ exists: true });
    local.controller.onEof();
    await local.controller.start();
    expect(local.mpv.calls[0]).toEqual([
      "loadfile",
      "C:/clips/a.mp4",
      "replace",
    ]);

    const remote = makeController({ exists: false });
    remote.controller.onEof();
    await remote.controller.start();
    expect(remote.mpv.calls[0]).toEqual([
      "loadfile",
      "https://cdn/a.mp4",
      "replace",
    ]);
  });

  it("advances the reel on clip EOF and on skip; finishes after the last", async () => {
    const { controller, mpv } = makeController({});
    controller.onEof();
    await controller.start();
    expect(controller.store.get().index).toBe(0);

    // Clip ended → next clip loads (playIndex is async — let it settle).
    controller.onTick({ ...DEFAULT_SNAPSHOT, eof: true, file_loaded: true });
    expect(controller.store.get().index).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mpv.calls.at(-1)?.[1]).toBe("C:/clips/b.mp4");

    await controller.skip();
    expect(controller.store.get().phase).toBe("finished");
  });

  it("exit closes the card and countdown never restarts it", () => {
    const { controller } = makeController({});
    controller.onEof();
    controller.exit();
    expect(controller.store.get().phase).toBe("idle");
    controller.tickCountdown();
    expect(controller.store.get().phase).toBe("idle");
  });

  it("skips broken entries without stalling the reel", async () => {
    const registry = createCloudRegistry();
    registry.upsert({
      ...makeLocalAsset({
        kind: "clip",
        mediaId: "m1",
        localPath: "C:/missing.mp4",
        startSec: 1,
        endSec: 2,
        localId: "broken",
      }),
      code: "broken01",
      fileUrl: null,
      status: "uploaded",
    });
    registry.upsert({
      ...makeLocalAsset({
        kind: "clip",
        mediaId: "m1",
        localPath: "C:/good.mp4",
        startSec: 3,
        endSec: 4,
        localId: "good",
      }),
      code: "good0001",
      fileUrl: "https://cdn/good.mp4",
      status: "uploaded",
    });
    const mpv = makeMpv();
    const controller = createBestMomentsController({
      mpv,
      registry,
      native: makeNative(false),
      getSnapshot: () => ({ ...DEFAULT_SNAPSHOT, file_loaded: true }),
    });
    controller.onEof();
    await controller.start();
    // "broken" has no fileUrl and no local file → skipped to "good".
    expect(mpv.calls[0]?.[1]).toBe("https://cdn/good.mp4");
    expect(controller.store.get().index).toBe(1);
  });

  it("is inert after dispose", async () => {
    const { controller, mpv } = makeController({});
    controller.onEof();
    controller.dispose();
    controller.onEof();
    await controller.start();
    expect(controller.store.get().phase).toBe("countdown");
    mpv.calls.length = 0;
    controller.onTick({ ...DEFAULT_SNAPSHOT, eof: true, file_loaded: true });
    expect(mpv.calls).toEqual([]);
  });

  it("ignores repeated EOF edges while the card is open", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { controller } = makeController({});
    controller.onEof();
    const first = controller.store.get();
    controller.onEof();
    expect(controller.store.get()).toBe(first);
    spy.mockRestore();
  });
});

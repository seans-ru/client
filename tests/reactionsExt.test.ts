import { describe, expect, it, vi } from "vitest";
import {
  createReactionsController,
  createReactionsSettings,
  reactions,
} from "../src/features/player/extensions/reactions";
import { roomChat } from "../src/features/player/extensions/roomChat";
import {
  createExtensionRuntime,
} from "../src/features/player/extensions/registry";
import { createExtensionStorage } from "../src/features/player/extensions/storage";
import { DEFAULT_SNAPSHOT } from "../src/features/player/playerTypes";
import {
  dropBubble,
  laneLeftPercent,
  pickLane,
  pushBubble,
  REACTION_BUBBLE_TTL_MS,
  REACTION_MAX_BUBBLES,
  type ReactionBubble,
} from "../src/features/player/extensions/reactionsHelpers";
import type {
  ExtensionStorage,
  PlayerExtension,
  RoomSocialPort,
} from "../src/features/player/extensions/types";

function makeStorage(initial: Record<string, unknown> = {}): ExtensionStorage {
  const store = new Map(Object.entries(initial));
  return {
    get: <T,>(key: string, fallback: T): T =>
      store.has(key) ? (store.get(key) as T) : fallback,
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

function makeRoom(overrides: Partial<RoomSocialPort> = {}): RoomSocialPort & {
  sent: string[];
  setRoomEnabled: (v: boolean) => void;
} {
  let roomEnabled = true;
  const sent: string[] = [];
  return {
    sent,
    setRoomEnabled: (v) => {
      roomEnabled = v;
    },
    roomCode: () => "ABCD2345",
    selfUserId: () => "self",
    selfName: () => "Me",
    isHost: () => false,
    sendReaction: (emoji) => {
      sent.push(emoji);
      return roomEnabled;
    },
    sendChat: () => true,
    onReaction: () => () => {},
    getChat: () => [],
    subscribe: () => () => {},
    getReactionsEnabled: () => roomEnabled,
    setReactionsEnabled: () => {},
    ...overrides,
  };
}

function bubble(key: number): ReactionBubble {
  return { key, emoji: "x", senderName: null, lane: 0 };
}

describe("reaction bubble pool", () => {
  it("caps the pool by dropping the oldest", () => {
    let list: ReactionBubble[] = [];
    for (let i = 1; i <= REACTION_MAX_BUBBLES + 3; i += 1) {
      list = pushBubble(list, bubble(i));
    }
    expect(list).toHaveLength(REACTION_MAX_BUBBLES);
    expect(list[0].key).toBe(4);
    expect(list[list.length - 1].key).toBe(REACTION_MAX_BUBBLES + 3);
  });

  it("drops a bubble by key and ignores missing keys", () => {
    const list = pushBubble(pushBubble([], bubble(1)), bubble(2));
    expect(dropBubble(list, 1).map((b) => b.key)).toEqual([2]);
    expect(dropBubble(list, 99)).toHaveLength(2);
  });

  it("assigns lanes within range", () => {
    expect(pickLane(() => 0)).toBe(0);
    expect(pickLane(() => 0.999)).toBe(5);
    expect(pickLane(() => 1.5)).toBe(5);
    expect(pickLane(() => -1)).toBe(0);
    expect(pickLane(() => 0.5)).toBeGreaterThanOrEqual(0);
    expect(pickLane(() => 0.5)).toBeLessThan(6);
  });

  it("spreads lanes across the layer", () => {
    expect(laneLeftPercent(0)).toBeGreaterThanOrEqual(0);
    expect(laneLeftPercent(5)).toBeLessThanOrEqual(100);
    expect(laneLeftPercent(3)).toBeGreaterThan(laneLeftPercent(1));
    expect(laneLeftPercent(99)).toBeLessThanOrEqual(100);
  });
});

describe("reactions settings", () => {
  it("defaults to showing reactions and persists the toggle", () => {
    const storage = makeStorage();
    const settings = createReactionsSettings(storage);
    expect(settings.getShow()).toBe(true);
    settings.setShow(false);
    expect(settings.getShow()).toBe(false);
    // A fresh reader (new session) sees the persisted value.
    expect(createReactionsSettings(storage).getShow()).toBe(false);
  });

  it("notifies subscribers on change only", () => {
    const settings = createReactionsSettings(makeStorage());
    const spy = vi.fn();
    settings.subscribe(spy);
    settings.setShow(true); // unchanged
    expect(spy).not.toHaveBeenCalled();
    settings.setShow(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("reactions controller", () => {
  it("pushes bubbles and expires them after the TTL", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const controller = createReactionsController({
      room: makeRoom(),
      storage: makeStorage(),
      rand: () => 0.5,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });

    controller.push({ emoji: "\u{1F44D}", userId: "u2", name: "Ann" });
    expect(controller.getBubbles()).toHaveLength(1);
    expect(controller.getBubbles()[0].emoji).toBe("\u{1F44D}");
    expect(controller.getBubbles()[0].senderName).toBe("Ann");
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(REACTION_BUBBLE_TTL_MS);

    timers[0].fn();
    expect(controller.getBubbles()).toHaveLength(0);
  });

  it("caps simultaneous bubbles and keeps names for hover", () => {
    const controller = createReactionsController({
      room: makeRoom(),
      storage: makeStorage(),
      rand: () => 0,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    for (let i = 0; i < REACTION_MAX_BUBBLES + 5; i += 1) {
      controller.push({ emoji: "e", userId: `u${i}`, name: `N${i}` });
    }
    const bubbles = controller.getBubbles();
    expect(bubbles).toHaveLength(REACTION_MAX_BUBBLES);
    expect(bubbles[bubbles.length - 1].senderName).toBe(
      `N${REACTION_MAX_BUBBLES + 4}`,
    );
  });

  it("hides incoming reactions when the local toggle is off", () => {
    const controller = createReactionsController({
      room: makeRoom(),
      storage: makeStorage(),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    controller.settings.setShow(false);
    controller.push({ emoji: "x", userId: "u2", name: null });
    expect(controller.getBubbles()).toHaveLength(0);
  });

  it("hides incoming reactions when the room flag is off", () => {
    const room = makeRoom();
    const controller = createReactionsController({
      room,
      storage: makeStorage(),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    room.setRoomEnabled(false);
    controller.push({ emoji: "x", userId: "u2", name: null });
    expect(controller.getBubbles()).toHaveLength(0);
  });

  it("sends through the room port and disposes cleanly", () => {
    const room = makeRoom();
    const controller = createReactionsController({
      room,
      storage: makeStorage(),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    expect(controller.send("\u{1F389}")).toBe(true);
    expect(room.sent).toEqual(["\u{1F389}"]);
    controller.push({ emoji: "x", userId: "u2", name: null });
    controller.dispose();
    expect(controller.getBubbles()).toHaveLength(0);
  });
});

describe("extensions register only in room mode", () => {
  function run(exts: PlayerExtension[], room: RoomSocialPort | null) {
    return createExtensionRuntime(exts, {
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
      room,
    });
  }

  it("adds panel/overlay/menu slots when a room channel is present", () => {
    const room = makeRoom();
    const runtime = run([reactions, roomChat], room);
    expect(runtime.getSlotEntries("controls.secondary")).toHaveLength(1);
    expect(runtime.getSlotEntries("overlay")).toHaveLength(1);
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(1);
    expect(runtime.getSlotEntries("sidecar")).toHaveLength(1);
    runtime.dispose();
    expect(runtime.getSlotEntries("overlay")).toHaveLength(0);
  });

  it("stays inert without a room channel", () => {
    const runtime = run([reactions, roomChat], null);
    expect(runtime.getSlotEntries("controls.secondary")).toHaveLength(0);
    expect(runtime.getSlotEntries("overlay")).toHaveLength(0);
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
    expect(runtime.getSlotEntries("sidecar")).toHaveLength(0);
    runtime.dispose();
  });
});

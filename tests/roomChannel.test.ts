import { describe, expect, it } from "vitest";
import {
  createRoomChannel,
  deriveEffectiveReady,
  expectedPosition,
  AUTO_READY_BUFFER_SEC,
} from "../src/features/rooms/roomChannel";
import { createInitialRoomState } from "../src/features/rooms/roomReducer";
import type { RoomState } from "../src/features/rooms/roomReducer";

function seededRoom(partial: Partial<RoomState> = {}): RoomState {
  return { ...createInitialRoomState(), ...partial };
}

describe("expectedPosition", () => {
  it("interpolates a playing host reference to now", () => {
    expect(
      expectedPosition(
        { position: 10, isPlaying: true, receivedAt: 1000 },
        4000,
      ),
    ).toBe(13);
  });

  it("holds a paused host reference", () => {
    expect(
      expectedPosition(
        { position: 10, isPlaying: false, receivedAt: 1000 },
        9000,
      ),
    ).toBe(10);
  });

  it("is 0 without a reference", () => {
    expect(expectedPosition(null, 5)).toBe(0);
    expect(
      expectedPosition({ position: 2, isPlaying: true, receivedAt: 0 }, 5),
    ).toBe(2);
  });
});

describe("deriveEffectiveReady", () => {
  it("lets a manual override win in both directions", () => {
    expect(
      deriveEffectiveReady({ manualReady: true, bufferedAhead: 0 }),
    ).toBe(true);
    expect(
      deriveEffectiveReady({
        manualReady: false,
        bufferedAhead: AUTO_READY_BUFFER_SEC + 5,
      }),
    ).toBe(false);
  });

  it("auto-readies from buffer telemetry when no override", () => {
    expect(
      deriveEffectiveReady({ manualReady: null, bufferedAhead: 0 }),
    ).toBe(false);
    expect(
      deriveEffectiveReady({
        manualReady: null,
        bufferedAhead: AUTO_READY_BUFFER_SEC,
      }),
    ).toBe(true);
  });
});

describe("createRoomChannel", () => {
  it("is inert until a session begins", () => {
    const channel = createRoomChannel();
    expect(channel.get().session).toBeNull();
    channel.syncRoom(seededRoom({ started: true }));
    expect(channel.get().phase).toBe("lobby");
  });

  it("mirrors members, presence, phase and host identity", () => {
    const channel = createRoomChannel();
    channel.beginSession({ code: "AB12CD34", selfUserId: "u1", taskFileId: "f1" });
    channel.syncRoom(
      seededRoom({
        hostId: "u1",
        members: [
          { userId: "u1", name: "Анна" },
          { userId: "u2", name: "Борис" },
        ],
        presence: {
          u2: { ready: true, bufferedAhead: 8 },
        },
        started: true,
        trackMode: "free",
        hostTracks: { audioId: 2, subId: null },
      }),
    );
    const state = channel.get();
    expect(state.session?.isHost).toBe(true);
    expect(state.phase).toBe("watching");
    expect(state.trackMode).toBe("free");
    expect(state.hostTracks).toEqual({ audioId: 2, subId: null });
    expect(state.members).toEqual([
      {
        userId: "u1",
        name: "Анна",
        ready: null,
        bufferedAhead: null,
        isHost: true,
        isSelf: true,
      },
      {
        userId: "u2",
        name: "Борис",
        ready: true,
        bufferedAhead: 8,
        isHost: false,
        isSelf: false,
      },
    ]);
  });

  it("toasts joins and leaves after the initial roster", () => {
    const channel = createRoomChannel();
    channel.beginSession({ code: "AB12CD34", selfUserId: "u1", taskFileId: "f1" });
    channel.syncRoom(
      seededRoom({
        members: [
          { userId: "u1", name: "Анна" },
          { userId: "u2", name: "Борис" },
        ],
      }),
    );
    expect(channel.get().toasts).toEqual([]);

    channel.syncRoom(
      seededRoom({
        members: [
          { userId: "u1", name: "Анна" },
          { userId: "u2", name: "Борис" },
          { userId: "u3", name: "Вита" },
        ],
      }),
    );
    expect(channel.get().toasts.map((t) => t.text)).toEqual([
      "Вита — в комнате",
    ]);

    channel.syncRoom(
      seededRoom({
        members: [
          { userId: "u1", name: "Анна" },
          { userId: "u3", name: "Вита" },
        ],
      }),
    );
    expect(channel.get().toasts.map((t) => t.text)).toEqual([
      "Вита — в комнате",
      "Борис вышел из комнаты",
    ]);

    channel.dismissToast(channel.get().toasts[0].id);
    expect(channel.get().toasts.map((t) => t.text)).toEqual([
      "Борис вышел из комнаты",
    ]);
  });

  it("sends readiness only when the effective flag flips", () => {
    const channel = createRoomChannel();
    const sent: Array<{ ready: boolean; bufferedAhead: number }> = [];
    channel.bindSenders({
      setReady: (ready, bufferedAhead) => sent.push({ ready, bufferedAhead }),
      setTracks: () => {},
      setTrackMode: () => {},
      syncRef: () => {},
      seekToGroup: () => {},
    });
    channel.beginSession({ code: "AB12CD34", selfUserId: "u1", taskFileId: "f1" });

    channel.setBufferedAhead(1);
    expect(sent).toEqual([]);
    channel.setBufferedAhead(AUTO_READY_BUFFER_SEC + 2);
    expect(sent).toEqual([
      { ready: true, bufferedAhead: AUTO_READY_BUFFER_SEC + 2 },
    ]);
    channel.setBufferedAhead(AUTO_READY_BUFFER_SEC + 3);
    expect(sent).toHaveLength(1);

    channel.actions.setReady(false);
    expect(sent).toEqual([
      { ready: true, bufferedAhead: AUTO_READY_BUFFER_SEC + 2 },
      { ready: false, bufferedAhead: AUTO_READY_BUFFER_SEC + 3 },
    ]);
  });

  it("routes track actions through the bound senders", () => {
    const channel = createRoomChannel();
    const tracks: unknown[] = [];
    const modes: unknown[] = [];
    const refs: number[] = [];
    channel.bindSenders({
      setReady: () => {},
      setTracks: (t) => tracks.push(t),
      setTrackMode: (m) => modes.push(m),
      syncRef: (p) => refs.push(p),
      seekToGroup: () => {},
    });
    channel.actions.setTracks({ audioId: 2, subId: null });
    channel.actions.setTrackMode("free");
    channel.actions.sendSyncRef(77);
    expect(tracks).toEqual([{ audioId: 2, subId: null }]);
    expect(modes).toEqual(["free"]);
    expect(refs).toEqual([77]);
  });

  it("seekToGroup interpolates the target to now", () => {
    const channel = createRoomChannel();
    let seeked: number | null = null;
    channel.bindSenders({
      setReady: () => {},
      setTracks: () => {},
      setTrackMode: () => {},
      syncRef: () => {},
      seekToGroup: (p) => {
        seeked = p;
      },
    });
    channel.beginSession({ code: "AB12CD34", selfUserId: "u1", taskFileId: "f1" });
    channel.syncRoom(
      seededRoom({
        syncTarget: {
          position: 100,
          isPlaying: true,
          receivedAt: Date.now() - 2000,
        },
      }),
    );
    channel.actions.seekToGroup();
    expect(seeked).toBeDefined();
    expect(Math.abs((seeked ?? 0) - 102)).toBeLessThan(1.5);
  });

  it("markStarted and room playback both leave the lobby", () => {
    const channel = createRoomChannel();
    channel.beginSession({ code: "AB12CD34", selfUserId: "u1", taskFileId: "f1" });
    channel.markStarted();
    expect(channel.get().phase).toBe("watching");
    // A later syncRoom must not drag the phase back to the lobby.
    channel.syncRoom(seededRoom({ started: false }));
    expect(channel.get().phase).toBe("watching");
  });

  it("keeps accumulated state when the same session is re-begun", () => {
    const channel = createRoomChannel();
    channel.beginSession({ code: "AB12CD34", selfUserId: "u1", taskFileId: "f1" });
    channel.markStarted();
    channel.beginSession({ code: "AB12CD34", selfUserId: "u1x", taskFileId: "f1" });
    const state = channel.get();
    expect(state.phase).toBe("watching");
    expect(state.session?.selfUserId).toBe("u1x");
  });

  it("endSession resets everything", () => {
    const channel = createRoomChannel();
    channel.beginSession({ code: "AB12CD34", selfUserId: "u1", taskFileId: "f1" });
    channel.markStarted();
    channel.endSession();
    expect(channel.get()).toMatchObject({
      session: null,
      phase: "lobby",
      members: [],
      hostTracks: null,
      target: null,
      toasts: [],
      ready: false,
    });
  });
});

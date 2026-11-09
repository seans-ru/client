import { describe, expect, it } from "vitest";
import {
  createInitialRoomState,
  isRoomStarted,
  roomReducer,
} from "../src/features/rooms/roomReducer";
import type { RoomAction, RoomState } from "../src/features/rooms/roomReducer";

function apply(actions: RoomAction[], initial?: Partial<RoomState>): RoomState {
  let state = createInitialRoomState(
    initial
      ? {
          members: initial.members?.map((m) => ({
            user_id: m.userId,
            name: m.name,
          })),
          hostId: initial.hostId ?? null,
          status: initial.status ?? "idle",
        }
      : {},
  );
  if (initial && !initial.members) {
    state = { ...state, ...initial, members: state.members };
  }
  for (const action of actions) {
    state = roomReducer(state, action);
  }
  return state;
}

describe("createInitialRoomState", () => {
  it("starts idle with empty room fields", () => {
    const state = createInitialRoomState();
    expect(state.status).toBe("idle");
    expect(state.hostId).toBeNull();
    expect(state.position).toBe(0);
    expect(state.isPlaying).toBe(false);
    expect(state.members).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.closeCode).toBeNull();
  });

  it("seeds REST members and host", () => {
    const state = createInitialRoomState({
      members: [
        { user_id: "u1", name: "Анна" },
        { user_id: "u2" },
      ],
      hostId: "u1",
    });
    expect(state.members).toEqual([
      { userId: "u1", name: "Анна" },
      { userId: "u2", name: null },
    ]);
    expect(state.hostId).toBe("u1");
  });
});

describe("roomReducer lifecycle", () => {
  it("connected clears error and close code", () => {
    const state = apply([
      { type: "error", detail: "boom" },
      { type: "closed", code: 4001 },
      { type: "connected" },
    ]);
    expect(state.status).toBe("connected");
    expect(state.error).toBeNull();
    expect(state.closeCode).toBeNull();
  });

  it("closed stores the close code", () => {
    const state = apply([{ type: "closed", code: 4004 }]);
    expect(state.status).toBe("closed");
    expect(state.closeCode).toBe(4004);
  });

  it("closed tolerates a missing code", () => {
    const state = apply([{ type: "closed", code: null }]);
    expect(state.status).toBe("closed");
    expect(state.closeCode).toBeNull();
  });
});

describe("roomReducer playback frames", () => {
  it("room_state replaces host, position and isPlaying", () => {
    const state = apply([
      {
        type: "room_state",
        hostId: "host-1",
        position: 12.5,
        isPlaying: true,
        ts: 1710000000,
      },
    ]);
    expect(state.hostId).toBe("host-1");
    expect(state.position).toBe(12.5);
    expect(state.isPlaying).toBe(true);
    expect(state.status).toBe("connected");
    expect(state.error).toBeNull();
  });

  it("room_state keeps the previous host when hostId is null", () => {
    const state = apply([
      { type: "room_state", hostId: "host-1", position: 1, isPlaying: false },
      { type: "room_state", hostId: null, position: 2, isPlaying: true },
    ]);
    expect(state.hostId).toBe("host-1");
    expect(state.position).toBe(2);
  });

  it("state play/pause/seek updates position and playing flag", () => {
    let state = apply([
      { type: "state", action: "play", position: 10, by: "host" },
    ]);
    expect(state.isPlaying).toBe(true);
    expect(state.position).toBe(10);

    state = roomReducer(state, {
      type: "state",
      action: "pause",
      position: 11,
      by: "host",
    });
    expect(state.isPlaying).toBe(false);
    expect(state.position).toBe(11);

    state = roomReducer(state, {
      type: "state",
      action: "seek",
      position: 40,
      by: "host",
    });
    // seek keeps the current playing flag
    expect(state.isPlaying).toBe(false);
    expect(state.position).toBe(40);
  });

  it("state clears a previous error", () => {
    const state = apply([
      { type: "error", detail: "Only host can control playback" },
      { type: "state", action: "play", position: 3, by: "host" },
    ]);
    expect(state.error).toBeNull();
  });
});

describe("roomReducer members", () => {
  it("member_joined appends and member_left removes", () => {
    const state = apply([
      { type: "member_joined", user: { user_id: "u1", name: "Анна" } },
      { type: "member_joined", user: { user_id: "u2", name: "Борис" } },
      { type: "member_left", user: { user_id: "u1", name: "Анна" } },
    ]);
    expect(state.members).toEqual([{ userId: "u2", name: "Борис" }]);
  });

  it("member_joined upserts by user_id and keeps the last name", () => {
    const state = apply([
      { type: "member_joined", user: { user_id: "u1", name: "Анна" } },
      { type: "member_joined", user: { user_id: "u1", name: null } },
    ]);
    expect(state.members).toEqual([{ userId: "u1", name: "Анна" }]);
  });

  it("member_left is a no-op for unknown users", () => {
    const state = apply([
      { type: "member_joined", user: { user_id: "u1", name: "Анна" } },
      { type: "member_left", user: { user_id: "ghost" } },
    ]);
    expect(state.members).toHaveLength(1);
  });
});

describe("roomReducer errors", () => {
  it("error keeps the detail text", () => {
    const state = apply([
      { type: "error", detail: "Only host can control playback" },
    ]);
    expect(state.error).toBe("Only host can control playback");
    expect(state.status).toBe("idle");
  });

  it("error falls back for empty detail", () => {
    const state = apply([{ type: "error", detail: "" }]);
    expect(state.error).toBe("Ошибка комнаты");
  });

  it("invalid numeric positions degrade to 0", () => {
    const state = apply([
      {
        type: "room_state",
        hostId: "h",
        position: Number.NaN,
        isPlaying: true,
      },
    ]);
    expect(state.position).toBe(0);
  });
});

describe("roomReducer room-sync additions (#27/#30/#31)", () => {
  it("member_ready tracks readiness and buffered-ahead per member", () => {
    const state = apply([
      { type: "member_joined", user: { user_id: "u2", name: "Boris" } },
      {
        type: "member_ready",
        user: { user_id: "u2", name: "Boris" },
        ready: true,
        bufferedAhead: 12,
      },
    ]);
    expect(state.presence["u2"]).toEqual({ ready: true, bufferedAhead: 12 });
    expect(state.members).toContainEqual({ userId: "u2", name: "Boris" });
  });

  it("member_ready keeps the previous buffered value when absent", () => {
    const state = apply([
      {
        type: "member_ready",
        user: { user_id: "u2" },
        ready: true,
        bufferedAhead: 12,
      },
      { type: "member_ready", user: { user_id: "u2" }, ready: false },
    ]);
    expect(state.presence["u2"]).toEqual({ ready: false, bufferedAhead: 12 });
  });

  it("member_joined seeds unknown presence, member_left drops it", () => {
    let state = apply([
      { type: "member_joined", user: { user_id: "u2", name: "Boris" } },
    ]);
    expect(state.presence["u2"]).toEqual({ ready: null, bufferedAhead: null });
    state = roomReducer(state, {
      type: "member_left",
      user: { user_id: "u2" },
    });
    expect(state.presence["u2"]).toBeUndefined();
  });

  it("set_tracks stores host tracks and track_mode switches modes", () => {
    const state = apply([
      { type: "set_tracks", audioId: 3, subId: null, by: "host" },
      { type: "track_mode", mode: "free", by: "host" },
    ]);
    expect(state.hostTracks).toEqual({ audioId: 3, subId: null });
    expect(state.trackMode).toBe("free");
  });

  it("defaults to the synchronous-from-host track mode", () => {
    expect(createInitialRoomState().trackMode).toBe("host");
    expect(createInitialRoomState().hostTracks).toBeNull();
  });

  it("sync stores a timestamped drift reference without touching isPlaying", () => {
    const state = apply([
      { type: "state", action: "pause", position: 5, by: "h" },
      { type: "sync", position: 42, by: "h", receivedAt: 1000 },
    ]);
    expect(state.isPlaying).toBe(false);
    expect(state.position).toBe(42);
    expect(state.syncTarget).toEqual({
      position: 42,
      isPlaying: false,
      receivedAt: 1000,
    });
  });

  it("state and room_state stamp the sync target when receivedAt is known", () => {
    let state = apply([
      {
        type: "state",
        action: "play",
        position: 10,
        by: "h",
        receivedAt: 500,
      },
    ]);
    expect(state.syncTarget).toEqual({
      position: 10,
      isPlaying: true,
      receivedAt: 500,
    });
    state = roomReducer(state, {
      type: "room_state",
      hostId: "h",
      position: 20,
      isPlaying: true,
      receivedAt: 900,
    });
    expect(state.syncTarget).toEqual({
      position: 20,
      isPlaying: true,
      receivedAt: 900,
    });
  });

  it("room_state without receivedAt keeps the previous sync target", () => {
    const state = apply([
      { type: "sync", position: 4, by: "h", receivedAt: 7 },
      {
        type: "room_state",
        hostId: "h",
        position: 9,
        isPlaying: true,
      },
    ]);
    expect(state.syncTarget).toEqual({
      position: 4,
      isPlaying: false,
      receivedAt: 7,
    });
  });

  it("started flips on play and on an already-playing room_state", () => {
    let state = apply([
      { type: "state", action: "pause", position: 0, by: "h" },
    ]);
    expect(state.started).toBe(false);
    state = roomReducer(state, {
      type: "state",
      action: "play",
      position: 0,
      by: "h",
    });
    expect(state.started).toBe(true);

    const joined = apply([
      {
        type: "room_state",
        hostId: "h",
        position: 90,
        isPlaying: false,
      },
    ]);
    expect(joined.started).toBe(true);
  });

  it("started action marks the local start (host force-start)", () => {
    const state = apply([{ type: "started" }]);
    expect(state.started).toBe(true);
  });
});

describe("isRoomStarted", () => {
  it("is false for a paused room at the beginning", () => {
    expect(isRoomStarted({ isPlaying: false, position: 0 })).toBe(false);
    expect(isRoomStarted({ isPlaying: false, position: 3 })).toBe(false);
  });

  it("is true while playing or past the opening seconds", () => {
    expect(isRoomStarted({ isPlaying: true, position: 0 })).toBe(true);
    expect(isRoomStarted({ isPlaying: false, position: 3.1 })).toBe(true);
  });
});

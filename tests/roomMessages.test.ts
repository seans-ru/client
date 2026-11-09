import { describe, expect, it } from "vitest";
import {
  encodeHeartbeat,
  encodeReady,
  encodeRoomMessage,
  encodeSetTracks,
  encodeState,
  encodeSync,
  encodeTrackMode,
  normalizeTrackId,
  normalizeTrackMode,
  parseRoomMessage,
  serverMessageToAction,
} from "../src/features/rooms/roomMessages";

describe("encode extended client frames", () => {
  it("keeps the legacy state wire shape for play/pause/seek", () => {
    expect(JSON.parse(encodeState("play", 12.5))).toEqual({
      type: "state",
      action: "play",
      position: 12.5,
    });
  });

  it("encodes sync as a relay-compatible state action", () => {
    expect(JSON.parse(encodeSync(64))).toEqual({
      type: "state",
      action: "sync",
      position: 64,
    });
  });

  it("rides setTracks payloads in the position field", () => {
    expect(JSON.parse(encodeSetTracks(2, 1))).toEqual({
      type: "state",
      action: "set_tracks",
      position: { audio_id: 2, sub_id: 1 },
    });
  });

  it("encodes null track ids as null (off)", () => {
    expect(JSON.parse(encodeSetTracks(null, null))).toEqual({
      type: "state",
      action: "set_tracks",
      position: { audio_id: null, sub_id: null },
    });
  });

  it("encodes track_mode payloads", () => {
    expect(JSON.parse(encodeTrackMode("free"))).toEqual({
      type: "state",
      action: "track_mode",
      position: { mode: "free" },
    });
  });

  it("encodes ready with buffered-ahead telemetry", () => {
    expect(JSON.parse(encodeReady(true, 12))).toEqual({
      type: "ready",
      ready: true,
      buffered_ahead: 12,
    });
  });

  it("adds heartbeat telemetry only when provided (old-wire shape preserved)", () => {
    expect(JSON.parse(encodeHeartbeat(3))).toEqual({
      type: "heartbeat",
      position: 3,
    });
    expect(
      JSON.parse(encodeHeartbeat(3, { bufferedAhead: 8, ready: true })),
    ).toEqual({
      type: "heartbeat",
      position: 3,
      buffered_ahead: 8,
      ready: true,
    });
  });

  it("clamps negative positions to zero", () => {
    const frame = JSON.parse(
      encodeRoomMessage({ type: "sync", position: -5 }),
    );
    expect(frame.position).toBe(0);
  });
});

describe("parse extended server frames", () => {
  it("parses the relay-compatible sync state frame", () => {
    expect(
      parseRoomMessage(
        JSON.stringify({ type: "state", action: "sync", position: 10, by: "u1" }),
      ),
    ).toEqual({ type: "sync", position: 10, by: "u1" });
  });

  it("parses set_tracks payloads out of the position field", () => {
    expect(
      parseRoomMessage(
        JSON.stringify({
          type: "state",
          action: "set_tracks",
          position: { audio_id: 3, sub_id: 0 },
          by: "u1",
        }),
      ),
    ).toEqual({ type: "set_tracks", audioId: 3, subId: null, by: "u1" });
  });

  it("parses track_mode payloads", () => {
    expect(
      parseRoomMessage(
        JSON.stringify({
          type: "state",
          action: "track_mode",
          position: { mode: "free" },
          by: "u1",
        }),
      ),
    ).toEqual({ type: "track_mode", mode: "free", by: "u1" });
  });

  it("parses native set_tracks / track_mode / ready / sync frames", () => {
    expect(
      parseRoomMessage(
        JSON.stringify({ type: "set_tracks", audio_id: 2, sub_id: 1, by: "u9" }),
      ),
    ).toEqual({ type: "set_tracks", audioId: 2, subId: 1, by: "u9" });
    expect(
      parseRoomMessage(JSON.stringify({ type: "track_mode", mode: "host", by: "u9" })),
    ).toEqual({ type: "track_mode", mode: "host", by: "u9" });
    expect(
      parseRoomMessage(
        JSON.stringify({
          type: "ready",
          user_id: "u2",
          ready: true,
          buffered_ahead: 7,
          name: "Анна",
        }),
      ),
    ).toEqual({
      type: "ready",
      userId: "u2",
      ready: true,
      bufferedAhead: 7,
      name: "Анна",
    });
    expect(
      parseRoomMessage(JSON.stringify({ type: "sync", position: 3, by: "u1" })),
    ).toEqual({ type: "sync", position: 3, by: "u1" });
  });

  it("accepts the member_joined user wrapper on ready frames", () => {
    expect(
      parseRoomMessage(
        JSON.stringify({
          type: "ready",
          ready: false,
          buffered_ahead: 0,
          user: { user_id: "u3", name: "Борис" },
        }),
      ),
    ).toEqual({
      type: "ready",
      userId: "u3",
      ready: false,
      bufferedAhead: 0,
      name: "Борис",
    });
  });

  it("drops unknown state actions (old clients / malformed frames)", () => {
    expect(
      parseRoomMessage(JSON.stringify({ type: "state", action: "boom", position: 1 })),
    ).toBeNull();
  });

  it("keeps parsing legacy frames unchanged", () => {
    expect(
      parseRoomMessage(
        JSON.stringify({
          type: "state",
          action: "seek",
          position: 4.5,
          by: "u1",
        }),
      ),
    ).toEqual({ type: "state", action: "seek", position: 4.5, by: "u1" });
    expect(
      parseRoomMessage(
        JSON.stringify({
          type: "room_state",
          host_id: "u1",
          position: 2,
          is_playing: true,
          ts: 100,
        }),
      ),
    ).toEqual({
      type: "room_state",
      hostId: "u1",
      position: 2,
      isPlaying: true,
      ts: 100,
    });
  });
});

describe("normalize helpers", () => {
  it("normalizes track ids (positive ints or null)", () => {
    expect(normalizeTrackId(3)).toBe(3);
    expect(normalizeTrackId("4")).toBe(4);
    expect(normalizeTrackId(0)).toBeNull();
    expect(normalizeTrackId(-2)).toBeNull();
    expect(normalizeTrackId(null)).toBeNull();
    expect(normalizeTrackId("x")).toBeNull();
    expect(normalizeTrackId(2.6)).toBe(3);
  });

  it("normalizes track mode (anything but free is host)", () => {
    expect(normalizeTrackMode("free")).toBe("free");
    expect(normalizeTrackMode("host")).toBe("host");
    expect(normalizeTrackMode("?")).toBe("host");
    expect(normalizeTrackMode(undefined)).toBe("host");
  });
});

describe("serverMessageToAction", () => {
  it("maps ready frames onto member_ready actions", () => {
    expect(
      serverMessageToAction({
        type: "ready",
        userId: "u2",
        ready: true,
        bufferedAhead: 9,
        name: "Анна",
      }),
    ).toEqual({
      type: "member_ready",
      user: { user_id: "u2", name: "Анна" },
      ready: true,
      bufferedAhead: 9,
    });
  });

  it("maps set_tracks / track_mode / sync without touching playback state", () => {
    expect(
      serverMessageToAction({
        type: "set_tracks",
        audioId: 1,
        subId: null,
        by: "u1",
      }),
    ).toEqual({ type: "set_tracks", audioId: 1, subId: null, by: "u1" });
    expect(
      serverMessageToAction({ type: "track_mode", mode: "free", by: "u1" }),
    ).toEqual({ type: "track_mode", mode: "free", by: "u1" });
    expect(
      serverMessageToAction({ type: "sync", position: 5, by: "u1" }),
    ).toEqual({ type: "sync", position: 5, by: "u1" });
  });
});

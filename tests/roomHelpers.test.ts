import { describe, expect, it } from "vitest";
import {
  buildRoomWsUrl,
  isHost,
  memberLabel,
  resolveRoomWsUrl,
  roomCloseMessage,
  roomShareUrl,
  shouldApplyRemoteState,
  toWebSocketBase,
  ROOM_CLOSE_NOT_FOUND,
  ROOM_CLOSE_UNAUTHORIZED,
  ROOM_HEARTBEAT_INTERVAL_MS,
  ROOM_SHARE_BASE_URL,
} from "../src/features/rooms/roomHelpers";
import {
  encodeHeartbeat,
  encodeJoin,
  encodeLeave,
  encodeRoomMessage,
  encodeState,
  encodeSyncRequest,
  parseRoomMessage,
  serverMessageToAction,
} from "../src/features/rooms/roomMessages";

describe("isHost / shouldApplyRemoteState", () => {
  it("matches host and self as strings", () => {
    expect(isHost("u1", "u1")).toBe(true);
    expect(isHost("u1", 1)).toBe(false);
    expect(isHost(1, "1")).toBe(true);
    expect(isHost(null, "u1")).toBe(false);
    expect(isHost("u1", null)).toBe(false);
    expect(isHost("", "")).toBe(false);
  });

  it("host never applies remote frames (incl. optional echoes)", () => {
    expect(
      shouldApplyRemoteState({
        selfUserId: "host",
        hostUserId: "host",
        byUserId: "host",
      }),
    ).toBe(false);
    expect(
      shouldApplyRemoteState({
        selfUserId: "host",
        hostUserId: "host",
        byUserId: "other",
      }),
    ).toBe(false);
  });

  it("guests apply remote frames from anyone else", () => {
    expect(
      shouldApplyRemoteState({
        selfUserId: "guest",
        hostUserId: "host",
        byUserId: "host",
      }),
    ).toBe(true);
    expect(
      shouldApplyRemoteState({
        selfUserId: "guest",
        hostUserId: "host",
      }),
    ).toBe(true);
  });

  it("guests ignore frames that claim to be from themselves", () => {
    expect(
      shouldApplyRemoteState({
        selfUserId: "guest",
        hostUserId: "host",
        byUserId: "guest",
      }),
    ).toBe(false);
  });

  it("without host info, non-self frames still apply", () => {
    expect(
      shouldApplyRemoteState({
        selfUserId: "guest",
        hostUserId: null,
        byUserId: "host",
      }),
    ).toBe(true);
  });
});

describe("room copy helpers", () => {
  it("maps close codes to Russian UI copy", () => {
    expect(roomCloseMessage(ROOM_CLOSE_UNAUTHORIZED)).toBe("Нет доступа");
    expect(roomCloseMessage(ROOM_CLOSE_NOT_FOUND)).toBe("Комната не найдена");
    expect(roomCloseMessage(1000)).toBe("Соединение с комнатой закрыто");
    expect(roomCloseMessage(null)).toBe("Соединение с комнатой закрыто");
    expect(roomCloseMessage(undefined)).toBe("Соединение с комнатой закрыто");
  });

  it("builds the public share URL", () => {
    expect(roomShareUrl("ABCD2345")).toBe(
      `${ROOM_SHARE_BASE_URL}/room/ABCD2345`,
    );
  });

  it("member labels fall back to a short id", () => {
    expect(memberLabel({ userId: "u1", name: "Анна" })).toBe("Анна");
    expect(memberLabel({ userId: "abcdef12-3456", name: null })).toBe(
      "Участник abcdef12",
    );
    expect(memberLabel({ userId: "u1", name: "" })).toBe("Участник u1");
  });
});

describe("buildRoomWsUrl", () => {
  it("appends the JWT token to a server-provided ws URL", () => {
    const url = buildRoomWsUrl({
      code: "ABCD2345",
      token: "jwt-token",
      wsUrl: "wss://api.seans.tedeshi.ru/ws/rooms/ABCD2345",
    });
    expect(url).toContain("wss://api.seans.tedeshi.ru/ws/rooms/ABCD2345");
    expect(url).toContain("token=jwt-token");
  });

  it("derives wss from the API base when wsUrl is missing", () => {
    const url = buildRoomWsUrl({
      code: "ABCD2345",
      token: "t",
      apiBaseUrl: "https://api.seans.tedeshi.ru",
    });
    expect(url.startsWith("wss://api.seans.tedeshi.ru/ws/rooms/ABCD2345")).toBe(
      true,
    );
    expect(url).toContain("token=t");
  });

  it("derives ws for local dev bases", () => {
    const url = buildRoomWsUrl({
      code: "ABCD2345",
      token: "t",
      apiBaseUrl: "http://localhost:8000",
    });
    expect(url.startsWith("ws://localhost:8000/ws/rooms/ABCD2345")).toBe(true);
  });

  it("replaces an existing token query", () => {
    const url = buildRoomWsUrl({
      code: "ABCD2345",
      token: "new",
      wsUrl: "wss://api.seans.tedeshi.ru/ws/rooms/ABCD2345?token=old",
    });
    expect(url).toContain("token=new");
    expect(url).not.toContain("token=old");
  });

  it("omits the query when token is empty", () => {
    const url = buildRoomWsUrl({
      code: "ABCD2345",
      token: null,
      wsUrl: "wss://api.seans.tedeshi.ru/ws/rooms/ABCD2345",
    });
    expect(url).toBe("wss://api.seans.tedeshi.ru/ws/rooms/ABCD2345");
  });

  it("resolves a relative server ws_url against the API WS origin", () => {
    // Backend POST /api/rooms returns "/ws/rooms/CODE" — never use as-is.
    const url = buildRoomWsUrl({
      code: "ABCD2345",
      token: "t",
      wsUrl: "/ws/rooms/ABCD2345",
      apiBaseUrl: "https://api.seans.tedeshi.ru",
    });
    expect(url.startsWith("wss://api.seans.tedeshi.ru/ws/rooms/ABCD2345")).toBe(
      true,
    );
    expect(url).toContain("token=t");
  });

  it("ignores empty ws_url and derives from the API base", () => {
    const url = buildRoomWsUrl({
      code: "ABCD2345",
      token: null,
      wsUrl: "",
      apiBaseUrl: "https://api.seans.tedeshi.ru",
    });
    expect(url).toBe("wss://api.seans.tedeshi.ru/ws/rooms/ABCD2345");
  });

  it("resolveRoomWsUrl maps absolute http(s) to ws(s)", () => {
    expect(resolveRoomWsUrl("https://api.example/ws/rooms/C", "https://x")).toBe(
      "wss://api.example/ws/rooms/C",
    );
    expect(resolveRoomWsUrl("http://localhost:8000/ws/rooms/C", "https://x")).toBe(
      "ws://localhost:8000/ws/rooms/C",
    );
  });

  it("toWebSocketBase maps http(s) to ws(s)", () => {
    expect(toWebSocketBase("https://api.example")).toBe("wss://api.example");
    expect(toWebSocketBase("http://localhost:8000/")).toBe("ws://localhost:8000");
    expect(toWebSocketBase("ws://localhost:8000")).toBe("ws://localhost:8000");
  });
});

describe("heartbeat interval", () => {
  it("is inside the 5–10s contract window", () => {
    expect(ROOM_HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
    expect(ROOM_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("encodeRoomMessage", () => {
  it("encodes join / sync_request / leave as bare type frames", () => {
    expect(JSON.parse(encodeJoin())).toEqual({ type: "join" });
    expect(JSON.parse(encodeSyncRequest())).toEqual({ type: "sync_request" });
    expect(JSON.parse(encodeLeave())).toEqual({ type: "leave" });
    expect(JSON.parse(encodeRoomMessage({ type: "leave" }))).toEqual({
      type: "leave",
    });
  });

  it("encodes heartbeat with a finite position", () => {
    expect(JSON.parse(encodeHeartbeat(12.5))).toEqual({
      type: "heartbeat",
      position: 12.5,
    });
    expect(JSON.parse(encodeHeartbeat(Number.NaN))).toEqual({
      type: "heartbeat",
      position: 0,
    });
    expect(JSON.parse(encodeHeartbeat(-3))).toEqual({
      type: "heartbeat",
      position: 0,
    });
  });

  it("encodes state frames", () => {
    expect(JSON.parse(encodeState("play", 3))).toEqual({
      type: "state",
      action: "play",
      position: 3,
    });
    expect(JSON.parse(encodeState("seek", 1))).toEqual({
      type: "state",
      action: "seek",
      position: 1,
    });
  });
});

describe("parseRoomMessage", () => {
  it("parses room_state (snake_case, tolerant)", () => {
    const msg = parseRoomMessage(
      JSON.stringify({
        type: "room_state",
        host_id: "host-1",
        position: 12.5,
        is_playing: true,
        ts: 1710000000,
        extra: "ignored",
      }),
    );
    expect(msg).toEqual({
      type: "room_state",
      hostId: "host-1",
      position: 12.5,
      isPlaying: true,
      ts: 1710000000,
    });
  });

  it("parses state with by", () => {
    const msg = parseRoomMessage(
      JSON.stringify({
        type: "state",
        action: "pause",
        position: 8,
        by: "host-1",
      }),
    );
    expect(msg).toEqual({
      type: "state",
      action: "pause",
      position: 8,
      by: "host-1",
    });
  });

  it("rejects state frames with an unknown action", () => {
    expect(
      parseRoomMessage(
        JSON.stringify({ type: "state", action: "stop", position: 1 }),
      ),
    ).toBeNull();
  });

  it("parses member_joined / member_left with nested user", () => {
    expect(
      parseRoomMessage(
        JSON.stringify({
          type: "member_joined",
          user: { user_id: "u1", name: "Анна", extra: 1 },
        }),
      ),
    ).toEqual({ type: "member_joined", userId: "u1", name: "Анна" });
    expect(
      parseRoomMessage(
        JSON.stringify({ type: "member_left", user_id: "u2" }),
      ),
    ).toEqual({ type: "member_left", userId: "u2", name: null });
  });

  it("parses error detail and falls back to message", () => {
    expect(
      parseRoomMessage(
        JSON.stringify({ type: "error", detail: "Only host can control playback" }),
      ),
    ).toEqual({ type: "error", detail: "Only host can control playback" });
    expect(parseRoomMessage(JSON.stringify({ type: "error", message: "x" }))).toEqual(
      { type: "error", detail: "x" },
    );
    expect(parseRoomMessage(JSON.stringify({ type: "error" }))).toEqual({
      type: "error",
      detail: "Ошибка комнаты",
    });
  });

  it("returns null for garbage and unknown types", () => {
    expect(parseRoomMessage("")).toBeNull();
    expect(parseRoomMessage("not-json")).toBeNull();
    expect(parseRoomMessage(JSON.stringify({ type: "ping" }))).toBeNull();
    expect(parseRoomMessage(JSON.stringify({ no_type: 1 }))).toBeNull();
    expect(parseRoomMessage(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseRoomMessage(JSON.stringify(null))).toBeNull();
    expect(
      parseRoomMessage(JSON.stringify({ type: "member_joined", user: {} })),
    ).toBeNull();
  });

  it("coerces is_playing variants", () => {
    expect(
      parseRoomMessage(
        JSON.stringify({ type: "room_state", host_id: "h", is_playing: "true", position: "2.5" }),
      ),
    ).toMatchObject({ isPlaying: true, position: 2.5 });
    expect(
      parseRoomMessage(
        JSON.stringify({ type: "room_state", host_id: "h", is_playing: 0 }),
      ),
    ).toMatchObject({ isPlaying: false });
  });
});

describe("serverMessageToAction", () => {
  it("maps frames onto reducer actions", () => {
    const parsed = parseRoomMessage(
      JSON.stringify({
        type: "member_joined",
        user: { user_id: "u1", name: "Анна" },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(serverMessageToAction(parsed!)).toEqual({
      type: "member_joined",
      user: { user_id: "u1", name: "Анна" },
    });

    const state = parseRoomMessage(
      JSON.stringify({ type: "state", action: "seek", position: 4, by: "h" }),
    );
    expect(serverMessageToAction(state!)).toEqual({
      type: "state",
      action: "seek",
      position: 4,
      by: "h",
    });
  });
});

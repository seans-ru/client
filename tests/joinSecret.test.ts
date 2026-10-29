import { describe, expect, it } from "vitest";
import {
  encodeJoinSecret,
  extractRoomCode,
  getOrCreateJoinNonce,
  parseJoinSecret,
} from "../src/features/discord/joinSecret";

const ROOM = "ABCD2345";

describe("encodeJoinSecret / parseJoinSecret", () => {
  it("roundtrips user:room:nonce", () => {
    const secret = encodeJoinSecret({
      inviterUserId: "128734",
      roomCode: ROOM,
      nonce: "abc123xyz909",
    });
    expect(parseJoinSecret(secret)).toEqual({
      inviterUserId: "128734",
      roomCode: ROOM,
      nonce: "abc123xyz909",
    });
  });

  it("emits URL-safe base64 without padding", () => {
    const secret = encodeJoinSecret({
      inviterUserId: "128734",
      roomCode: ROOM,
      nonce: "n",
    });
    expect(secret).not.toMatch(/[+/=]/);
  });

  it("rejects payloads without a valid room code", () => {
    const bogus = btoa("128734:notacode:nonce").replace(/=+$/, "");
    expect(parseJoinSecret(bogus)).toBeNull();
    expect(parseJoinSecret("garbage")).toBeNull();
    expect(parseJoinSecret("")).toBeNull();
  });

  it("accepts standard base64 with padding (mock example shape)", () => {
    // base64("128734:ABCD2345:123123")
    const secret = btoa("128734:ABCD2345:123123");
    expect(parseJoinSecret(secret)).toEqual({
      inviterUserId: "128734",
      roomCode: ROOM,
      nonce: "123123",
    });
  });
});

describe("getOrCreateJoinNonce", () => {
  it("is stable per room and differs across rooms", () => {
    const a = getOrCreateJoinNonce(ROOM);
    expect(getOrCreateJoinNonce(ROOM)).toBe(a);
    expect(getOrCreateJoinNonce("ZZZZ2222")).not.toBe(a);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe("extractRoomCode", () => {
  it("reads a bare room code", () => {
    expect(extractRoomCode(ROOM)).toBe(ROOM);
  });

  it("reads a seans:// room deep link", () => {
    expect(extractRoomCode("seans://room/ABCD2345")).toBe(ROOM);
  });

  it("reads the canonical join secret", () => {
    const secret = encodeJoinSecret({
      inviterUserId: "1",
      roomCode: ROOM,
      nonce: "x",
    });
    expect(extractRoomCode(secret)).toBe(ROOM);
  });

  it("reads a cold-launch protocol URL wrapping the secret", () => {
    const secret = encodeJoinSecret({
      inviterUserId: "1",
      roomCode: ROOM,
      nonce: "x",
    });
    expect(
      extractRoomCode(`discord-1565313293747494932://${secret}`),
    ).toBe(ROOM);
    expect(
      extractRoomCode(`discord-1565313293747494932://seans://room/${ROOM}`),
    ).toBe(ROOM);
  });

  it("reads ?secret= and --secret= launch forms", () => {
    const secret = encodeJoinSecret({
      inviterUserId: "1",
      roomCode: ROOM,
      nonce: "x",
    });
    expect(
      extractRoomCode(`discord-1://host?secret=${secret}&x=1`),
    ).toBe(ROOM);
    expect(extractRoomCode(`--secret=${secret}`)).toBe(ROOM);
  });

  it("ignores payloads without a room code", () => {
    expect(extractRoomCode("")).toBeNull();
    expect(extractRoomCode("discord-1://")).toBeNull();
    expect(extractRoomCode("https://example.com/")).toBeNull();
    expect(extractRoomCode("seans://room/badcode")).toBeNull();
  });
});

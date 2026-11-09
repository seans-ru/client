import { describe, expect, it } from "vitest";
import { parseDeepLink, ROOM_CODE_PATTERN } from "../src/lib/deepLink";

describe("parseDeepLink", () => {
  it("parses seans:// as home", () => {
    expect(parseDeepLink("seans://")).toEqual({ kind: "home" });
  });

  it("parses seans:/// as home", () => {
    expect(parseDeepLink("seans:///")).toEqual({ kind: "home" });
  });

  it("parses triple-slash auth callback and room forms", () => {
    expect(
      parseDeepLink("seans:///auth/callback?access_token=tok&state=st"),
    ).toEqual({
      kind: "authCallback",
      accessToken: "tok",
      state: "st",
    });
    expect(parseDeepLink("seans:///room/ABCD2345")).toEqual({
      kind: "room",
      roomCode: "ABCD2345",
      startAt: null,
    });
  });

  it("parses auth callback with tokens", () => {
    expect(
      parseDeepLink("seans://auth/callback?access_token=tok123&state=st456"),
    ).toEqual({
      kind: "authCallback",
      accessToken: "tok123",
      state: "st456",
    });
  });

  it("parses auth callback with empty token values as empty strings", () => {
    expect(parseDeepLink("seans://auth/callback?access_token=&state=")).toEqual({
      kind: "authCallback",
      accessToken: "",
      state: "",
    });
  });

  it("parses auth callback with missing params as null", () => {
    expect(parseDeepLink("seans://auth/callback")).toEqual({
      kind: "authCallback",
      accessToken: null,
      state: null,
    });
  });

  it("does not store tokens — result is a plain payload object", () => {
    const payload = parseDeepLink(
      "seans://auth/callback?access_token=secret&state=s",
    );
    expect(payload).not.toBeNull();
    expect(payload).toHaveProperty("kind", "authCallback");
    // No module-level cache: two parses are independent.
    const again = parseDeepLink("seans://auth/callback?access_token=other");
    expect(again).not.toEqual(payload);
  });

  it("parses a valid room link", () => {
    expect(parseDeepLink("seans://room/ABCD2345")).toEqual({
      kind: "room",
      roomCode: "ABCD2345",
      startAt: null,
    });
  });

  it("accepts room codes with 2-9 digits only", () => {
    expect(parseDeepLink("seans://room/23456789")).toEqual({
      kind: "room",
      roomCode: "23456789",
      startAt: null,
    });
  });

  it("rejects room codes outside A-Z2-9 (0 and 1 are not in 2-9)", () => {
    expect(parseDeepLink("seans://room/ABCD2340")).toBeNull();
    expect(parseDeepLink("seans://room/ABCD2341")).toBeNull();
    expect(parseDeepLink("seans://room/ABCD234!")).toBeNull();
  });

  it("accepts room codes that contain I, L, O (A-Z is inclusive)", () => {
    expect(parseDeepLink("seans://room/ABCD234O")).toEqual({
      kind: "room",
      roomCode: "ABCD234O",
      startAt: null,
    });
    expect(parseDeepLink("seans://room/ABCD234I")).toEqual({
      kind: "room",
      roomCode: "ABCD234I",
      startAt: null,
    });
  });

  it("rejects lowercase room codes", () => {
    expect(parseDeepLink("seans://room/abcd2345")).toBeNull();
  });

  it("rejects wrong-length room codes", () => {
    expect(parseDeepLink("seans://room/ABCD234")).toBeNull();
    expect(parseDeepLink("seans://room/ABCD23456")).toBeNull();
  });

  it("rejects room links with extra path segments", () => {
    expect(parseDeepLink("seans://room/ABCD2345/extra")).toBeNull();
    expect(parseDeepLink("seans://room")).toBeNull();
  });

  it("rejects unknown hosts and paths", () => {
    expect(parseDeepLink("seans://unknown/path")).toBeNull();
    expect(parseDeepLink("seans://auth")).toBeNull();
    expect(parseDeepLink("seans://auth/other")).toBeNull();
  });

  it("ignores non-seans schemes", () => {
    expect(parseDeepLink("https://seans.tedeshi.ru/")).toBeNull();
    expect(parseDeepLink("http://auth/callback")).toBeNull();
    expect(parseDeepLink("file:///C:/Windows")).toBeNull();
  });

  it("ignores malformed URLs without throwing", () => {
    expect(parseDeepLink("")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
    expect(parseDeepLink("seans://[")).toBeNull();
    expect(parseDeepLink("::::")).toBeNull();
  });

  it("parses a moment link with ?t= startAt", () => {
    expect(parseDeepLink("seans://room/ABCD2345?t=754")).toEqual({
      kind: "room",
      roomCode: "ABCD2345",
      startAt: 754,
    });
    expect(parseDeepLink("seans:///room/ABCD2345?t=754.9")).toEqual({
      kind: "room",
      roomCode: "ABCD2345",
      startAt: 754,
    });
  });

  it("ignores unusable ?t= values", () => {
    expect(parseDeepLink("seans://room/ABCD2345?t=0")).toEqual({
      kind: "room",
      roomCode: "ABCD2345",
      startAt: null,
    });
    expect(parseDeepLink("seans://room/ABCD2345?t=-5")).toEqual({
      kind: "room",
      roomCode: "ABCD2345",
      startAt: null,
    });
    expect(parseDeepLink("seans://room/ABCD2345?t=abc")).toEqual({
      kind: "room",
      roomCode: "ABCD2345",
      startAt: null,
    });
    expect(parseDeepLink("seans://room/ABCD2345?t=")).toEqual({
      kind: "room",
      roomCode: "ABCD2345",
      startAt: null,
    });
  });

});

describe("ROOM_CODE_PATTERN", () => {
  it("matches ^[A-Z2-9]{8}$", () => {
    expect(ROOM_CODE_PATTERN.test("ABCD2345")).toBe(true);
    expect(ROOM_CODE_PATTERN.test("A1CDEFGH")).toBe(false);
    expect(ROOM_CODE_PATTERN.test("ABCDEFGH9")).toBe(false);
  });
});

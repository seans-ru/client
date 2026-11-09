import { describe, expect, it } from "vitest";
import {
  formatClockTime,
  formatTimestamp,
  insertAtCaret,
  roomMomentLinks,
  tokenizeChat,
} from "../src/features/player/extensions/roomChat";
import { formatTime } from "../src/features/player/playerHelpers";

describe("formatTimestamp", () => {
  it("renders [m:ss] and [h:mm:ss] like the player clock", () => {
    expect(formatTimestamp(0)).toBe(`[${formatTime(0)}]`);
    expect(formatTimestamp(754)).toBe("[12:34]");
    expect(formatTimestamp(3723)).toBe("[1:02:03]");
    expect(formatTimestamp(-5)).toBe("[0:00]");
  });
});

describe("tokenizeChat", () => {
  it("splits plain text and timestamp codes", () => {
    expect(tokenizeChat("start [12:34] end")).toEqual([
      { type: "text", value: "start " },
      { type: "time", seconds: 754 },
      { type: "text", value: " end" },
    ]);
  });

  it("parses hour-long codes and adjacent codes", () => {
    expect(tokenizeChat("[1:02:03] and [0:05]")).toEqual([
      { type: "time", seconds: 3723 },
      { type: "text", value: " and " },
      { type: "time", seconds: 5 },
    ]);
    expect(tokenizeChat("[1:00][2:00]")).toEqual([
      { type: "time", seconds: 60 },
      { type: "time", seconds: 120 },
    ]);
  });

  it("keeps invalid and empty brackets as text", () => {
    expect(tokenizeChat("[99:99] x")).toEqual([
      { type: "text", value: "[99:99] x" },
    ]);
    expect(tokenizeChat("plain only")).toEqual([
      { type: "text", value: "plain only" },
    ]);
    expect(tokenizeChat("")).toEqual([]);
    expect(tokenizeChat("[]")).toEqual([{ type: "text", value: "[]" }]);
  });
});

describe("insertAtCaret", () => {
  it("inserts at the caret and returns the new caret", () => {
    expect(insertAtCaret("ab", 1, "X")).toEqual({ text: "aXb", caret: 2 });
    expect(insertAtCaret("ab", 0, "X")).toEqual({ text: "Xab", caret: 1 });
    expect(insertAtCaret("ab", 2, "X")).toEqual({ text: "abX", caret: 3 });
    expect(insertAtCaret("ab", 99, "X")).toEqual({ text: "abX", caret: 3 });
    expect(insertAtCaret("ab", -3, "X")).toEqual({ text: "Xab", caret: 1 });
  });
});

describe("roomMomentLinks", () => {
  it("builds the seans:// moment link and the web variant", () => {
    expect(roomMomentLinks("ABCD2345", 754)).toEqual({
      deepLink: "seans://room/ABCD2345?t=754",
      webUrl: "https://seans.tedeshi.ru/room/ABCD2345?t=754",
    });
  });

  it("floors fractional seconds and clamps negatives", () => {
    expect(roomMomentLinks("ABCD2345", 754.9).deepLink).toBe(
      "seans://room/ABCD2345?t=754",
    );
    expect(roomMomentLinks("ABCD2345", -10).deepLink).toBe(
      "seans://room/ABCD2345?t=0",
    );
    expect(roomMomentLinks("ABCD2345", Number.NaN).deepLink).toBe(
      "seans://room/ABCD2345?t=0",
    );
  });
});

describe("formatClockTime", () => {
  it("renders local hh:mm with zero padding", () => {
    const ts = new Date(2026, 0, 1, 9, 5, 42).getTime();
    expect(formatClockTime(ts)).toBe("09:05");
    const late = new Date(2026, 0, 1, 23, 59, 0).getTime();
    expect(formatClockTime(late)).toBe("23:59");
  });

  it("degrades non-finite timestamps to the epoch midnight", () => {
    expect(formatClockTime(Number.NaN)).toBe(formatClockTime(0));
    expect(formatClockTime(Number.POSITIVE_INFINITY)).toBe(formatClockTime(0));
  });
});

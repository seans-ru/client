import { describe, expect, it } from "vitest";
import {
  buildDiscordActivity,
  formatEpisodeLabel,
  formatMinutes,
  partyMaxForPlan,
  FALLBACK_ASSET_KEY,
} from "../src/features/discord/discordActivity";
import { parseJoinSecret } from "../src/features/discord/joinSecret";

describe("partyMaxForPlan", () => {
  it("maps plans to party caps", () => {
    expect(partyMaxForPlan("free")).toBe(10);
    expect(partyMaxForPlan("plus")).toBe(20);
    expect(partyMaxForPlan("pro")).toBe(50);
  });

  it("falls back to 10 for unknown or missing plans", () => {
    expect(partyMaxForPlan(undefined)).toBe(10);
    expect(partyMaxForPlan(null)).toBe(10);
    expect(partyMaxForPlan("vip")).toBe(10);
  });
});

describe("formatEpisodeLabel", () => {
  it("pads season and episode", () => {
    expect(formatEpisodeLabel(1, 3)).toBe("S01E03");
    expect(formatEpisodeLabel(12, 45)).toBe("S12E45");
  });

  it("returns null for movies / unknown values", () => {
    expect(formatEpisodeLabel(null, null)).toBeNull();
    expect(formatEpisodeLabel(1, null)).toBeNull();
    expect(formatEpisodeLabel(undefined, 2)).toBeNull();
  });
});

describe("formatMinutes", () => {
  it("reports progress in rounded minutes", () => {
    expect(formatMinutes(60, 300)).toBe("1 мин из 5 мин");
    expect(formatMinutes(2520, 8700)).toBe("42 мин из 145 мин");
    expect(formatMinutes(0, 0)).toBe("0 мин из 0 мин");
  });
});

const base = {
  title: "Дюна: Часть вторая",
  season: null as number | null,
  episode: null as number | null,
  positionSec: 2520,
  durationSec: 8700,
  paused: false,
  posterUrl: "https://img.example/p.jpg",
  inviterUserId: "128734",
  plan: "free",
  nowMs: 1_000_000_000_000,
};

describe("buildDiscordActivity", () => {
  it("builds a playing movie with absolute timestamps", () => {
    const activity = buildDiscordActivity({
      ...base,
      room: null,
    });
    expect(activity.details).toBe(base.title);
    expect(activity.state).toBe("42 мин из 145 мин");
    // start = now - position, end = start + duration
    expect(activity.startMs).toBe(1_000_000_000_000 - 2520_000);
    expect(activity.endMs).toBe(1_000_000_000_000 - 2520_000 + 8700_000);
    // Poster goes through as a plain URL — Discord's client proxies it over RPC.
    expect(activity.largeImage).toBe(base.posterUrl);
    expect(activity.partyId).toBeNull();
    expect(activity.joinSecret).toBeNull();
  });

  it("falls back to the static art key when there is no poster", () => {
    const activity = buildDiscordActivity({
      ...base,
      posterUrl: null,
      room: null,
    });
    expect(activity.largeImage).toBe(FALLBACK_ASSET_KEY);
    expect(activity.smallImage).toBe(FALLBACK_ASSET_KEY);
  });

  it("drops timestamps on pause and marks the state", () => {
    const activity = buildDiscordActivity({
      ...base,
      paused: true,
      room: null,
    });
    expect(activity.state).toBe("Пауза · 42 мин из 145 мин");
    expect(activity.startMs).toBeNull();
    expect(activity.endMs).toBeNull();
  });

  it("adds the episode label for series", () => {
    const activity = buildDiscordActivity({
      ...base,
      season: 1,
      episode: 3,
      room: null,
    });
    expect(activity.state).toBe("S01E03 · 42 мин из 145 мин");
  });

  it("fills party + join secret inside a room", () => {
    const activity = buildDiscordActivity({
      ...base,
      room: { code: "ABCD2345", members: 2 },
    });
    expect(activity.partyId).toBe("ABCD2345");
    expect(activity.partySize).toBe(2);
    expect(activity.partyMax).toBe(10);
    const parts = parseJoinSecret(activity.joinSecret ?? "");
    expect(parts).toEqual({
      inviterUserId: "128734",
      roomCode: "ABCD2345",
      nonce: parts?.nonce ?? "",
    });
    expect(parts?.nonce.length).toBeGreaterThan(0);
  });

  it("uses the plan party cap and keeps size >= 1", () => {
    const activity = buildDiscordActivity({
      ...base,
      plan: "pro",
      room: { code: "ABCD2345", members: 0 },
    });
    expect(activity.partySize).toBe(1);
    expect(activity.partyMax).toBe(50);
  });

  it("omits the minutes when duration is unknown", () => {
    const activity = buildDiscordActivity({
      ...base,
      durationSec: 0,
      room: null,
    });
    expect(activity.state).toBeNull();
    expect(activity.startMs).toBeNull();
    expect(activity.endMs).toBeNull();
  });
});

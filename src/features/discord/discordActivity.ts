/**
 * Discord activity payload builder (pure — no React/DOM/Tauri, unit-testable).
 *
 * The payload is what the Rust side maps onto a Discord `Activity` with
 * `ActivityType::Listening` — details/state text, absolute timestamps for the
 * progress bar, the poster (a raw image URL: Discord's client proxies URLs
 * sent over RPC automatically), and (in a room) party + join secret.
 */

import { encodeJoinSecret, getOrCreateJoinNonce } from "./joinSecret";

/** Fallback art asset key (uploaded once in the Discord Developer Portal). */
export const FALLBACK_ASSET_KEY = "seans";

/** Discord activity fields consumed by `discord_set_activity` (Rust). */
export type DiscordActivityInput = {
  details: string | null;
  state: string | null;
  largeImage: string | null;
  largeText: string | null;
  smallImage: string | null;
  smallText: string | null;
  startMs: number | null;
  endMs: number | null;
  partyId: string | null;
  partySize: number | null;
  partyMax: number | null;
  joinSecret: string | null;
};

/** Party cap shown in Discord per subscription plan (room caps live server-side later). */
export const PARTY_MAX_BY_PLAN: Record<string, number> = {
  free: 10,
  plus: 20,
  pro: 50,
};

export function partyMaxForPlan(plan: string | null | undefined): number {
  return PARTY_MAX_BY_PLAN[String(plan ?? "").toLowerCase()] ?? 10;
}

/** `S01E03` for series episodes; null for movies / unknown season. */
export function formatEpisodeLabel(
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (season == null || episode == null) return null;
  const s = Math.trunc(Number(season));
  const e = Math.trunc(Number(episode));
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
}

/** `42 мин из 145 мин` — progress in minutes (rounded), as requested. */
export function formatMinutes(
  positionSec: number,
  durationSec: number,
): string {
  const pos = Math.max(0, Math.round(positionSec / 60));
  const dur = Math.max(0, Math.round(durationSec / 60));
  return `${pos} мин из ${dur} мин`;
}

export type BuildDiscordActivityInput = {
  /** Media title (movie name / series name). */
  title: string | null;
  season: number | null;
  episode: number | null;
  positionSec: number;
  durationSec: number;
  paused: boolean;
  /**
   * Poster image URL — sent as `large_image` as-is; Discord's client proxies
   * URLs over RPC. Null → static `seans` art key.
   */
  posterUrl: string | null;
  /** Present while in a watch-party room. */
  room: { code: string; members: number } | null;
  /** Id of the user whose activity this is (join-secret first part). */
  inviterUserId: string;
  /** Subscription plan code (`free` | `plus` | `pro`). */
  plan: string | null | undefined;
  nowMs: number;
};

export function buildDiscordActivity(
  input: BuildDiscordActivityInput,
): DiscordActivityInput {
  const episodeLabel = formatEpisodeLabel(input.season, input.episode);
  const minutes =
    input.durationSec > 0 ? formatMinutes(input.positionSec, input.durationSec) : null;
  const stateParts = [episodeLabel, input.paused ? "Пауза" : null, minutes];
  const state = stateParts.filter(Boolean).join(" · ");

  // Absolute timestamps: the elapsed bar ticks on Discord's side; while
  // paused the bar would drift, so drop it and keep the progress in text.
  let startMs: number | null = null;
  let endMs: number | null = null;
  const durationMs = input.durationSec > 0 ? input.durationSec * 1000 : 0;
  if (!input.paused && durationMs > 0) {
    startMs = Math.round(input.nowMs - input.positionSec * 1000);
    endMs = Math.round(startMs + durationMs);
  }

  const room = input.room;
  const partyId = room ? room.code : null;
  const joinSecret = room
    ? encodeJoinSecret({
        inviterUserId: input.inviterUserId,
        roomCode: room.code,
        nonce: getOrCreateJoinNonce(room.code),
      })
    : null;

  return {
    details: input.title || null,
    state: state || null,
    largeImage: input.posterUrl || FALLBACK_ASSET_KEY,
    largeText: input.title || null,
    smallImage: FALLBACK_ASSET_KEY,
    smallText: "Seans",
    startMs,
    endMs,
    partyId,
    partySize: room ? Math.max(1, room.members) : null,
    partyMax: room ? partyMaxForPlan(input.plan) : null,
    joinSecret,
  };
}

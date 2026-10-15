/**
 * TheIntroDB API client (M8).
 *
 * GET https://api.theintrodb.org/v3/media?tmdb_id=&season=&episode=
 * No API key for reads. Rate limit 30 req/10s, 1000/day — session-only Map cache.
 * Failures resolve to an empty bundle (feature is silently off).
 */

import { toNumber } from "../../api/parsing";
import {
  emptyBundle,
  SEGMENT_TYPES,
  type TheIntroDbBundle,
  type TheIntroDbSegment,
  type TheIntroDbSegmentType,
} from "./types";

export const THEINTRODB_BASE_URL = "https://api.theintrodb.org/v3";

/** Session-only cache: key = `${tmdbId}:${season}:${episode}`. */
const segmentCache = new Map<string, TheIntroDbBundle>();

/** In-flight fetches, de-duplicated per cache key. */
const inflight = new Map<string, Promise<TheIntroDbBundle>>();

export type FetchSegmentsParams = {
  tmdbId: number;
  season?: number | null;
  episode?: number | null;
};

/**
 * Cache key contract: `${tmdbId}:${season}:${episode}`.
 * Missing season/episode render as empty segments between colons (`123::`).
 */
export function segmentCacheKey(
  tmdbId: number,
  season?: number | null,
  episode?: number | null,
): string {
  const s = season == null ? "" : String(season);
  const e = episode == null ? "" : String(episode);
  return `${tmdbId}:${s}:${e}`;
}

type Raw = Record<string, unknown>;

function asRaw(value: unknown): Raw {
  return value !== null && typeof value === "object" ? (value as Raw) : {};
}

function normalizeSegment(raw: unknown): TheIntroDbSegment {
  const r = asRaw(raw);
  return {
    startMs: toNumber(r.start_ms),
    endMs: toNumber(r.end_ms),
  };
}

function normalizeSegmentList(
  raw: unknown,
): TheIntroDbSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeSegment);
}

/**
 * Map a raw TheIntroDB payload to the four-type bundle.
 * Accepts either top-level `{intro, recap, …}` or a nested `segments` object.
 */
export function normalizeTheIntroDbBundle(raw: unknown): TheIntroDbBundle {
  const root = asRaw(raw);
  const source = asRaw(root.segments ?? root);
  const bundle = emptyBundle();
  for (const type of SEGMENT_TYPES) {
    bundle[type] = normalizeSegmentList(
      (source as Record<string, unknown>)[type],
    );
  }
  return bundle;
}

function buildMediaUrl(params: FetchSegmentsParams): string {
  const query = new URLSearchParams();
  query.set("tmdb_id", String(params.tmdbId));
  if (params.season != null && Number.isFinite(params.season)) {
    query.set("season", String(Math.trunc(params.season)));
  }
  if (params.episode != null && Number.isFinite(params.episode)) {
    query.set("episode", String(Math.trunc(params.episode)));
  }
  return `${THEINTRODB_BASE_URL}/media?${query.toString()}`;
}

async function fetchAndNormalize(
  params: FetchSegmentsParams,
): Promise<TheIntroDbBundle> {
  let res: Response;
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (isTauri()) {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      res = (await tauriFetch(buildMediaUrl(params), {
        method: "GET",
        headers: { Accept: "application/json" },
      })) as unknown as Response;
    } else {
      res = await fetch(buildMediaUrl(params), {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    }
  } catch {
    res = await fetch(buildMediaUrl(params), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  }
  if (!res.ok) {
    throw new Error(`TheIntroDB HTTP ${res.status}`);
  }
  const text = await res.text();
  if (text.length === 0) return emptyBundle();
  return normalizeTheIntroDbBundle(JSON.parse(text));
}

/**
 * Fetch intro/recap/credits/preview segments for a TMDB id.
 * Session-cached; concurrent callers share one request.
 * On any failure returns an empty bundle (silent-off) after `console.debug`.
 */
export async function fetchSegments(
  params: FetchSegmentsParams,
): Promise<TheIntroDbBundle> {
  const tmdbId = toNumber(params.tmdbId);
  if (tmdbId == null || tmdbId <= 0) return emptyBundle();

  const season = params.season == null ? null : toNumber(params.season);
  const episode = params.episode == null ? null : toNumber(params.episode);
  const key = segmentCacheKey(tmdbId, season, episode);

  const cached = segmentCache.get(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async () => {
    try {
      const bundle = await fetchAndNormalize({
        tmdbId,
        season,
        episode,
      });
      segmentCache.set(key, bundle);
      return bundle;
    } catch (cause) {
      console.debug("[theintrodb] segments unavailable", key, cause);
      return emptyBundle();
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, request);
  return request;
}

/** Drop the in-memory cache (tests / explicit refresh). */
export function clearSegmentCache(): void {
  segmentCache.clear();
  inflight.clear();
}

/** Read a cached bundle without hitting the network (tests). */
export function peekSegmentCache(
  tmdbId: number,
  season?: number | null,
  episode?: number | null,
): TheIntroDbBundle | undefined {
  return segmentCache.get(segmentCacheKey(tmdbId, season, episode));
}

export type { TheIntroDbBundle, TheIntroDbSegment, TheIntroDbSegmentType };

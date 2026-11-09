/**
 * Stable per-file key for extension storage (scrub preview cache, bookmarks).
 * Prefers the `#/player/{fileId}` route id; falls back to the normalized
 * stream URL path (presigned query strings change per fetch — the path does
 * not). Rooms keep `#/room/{code}` so the URL fallback covers them.
 */

import {
  getCurrentHashRoute,
  matchPlayerRoute,
} from "../../../lib/routeResolver";

/** Normalize a media URL to a stable storage key part. */
export function mediaKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const raw = String(url).trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, "http://local.invalid");
    const path = parsed.pathname.replace(/\/+$/, "");
    return path ? path : null;
  } catch {
    return raw;
  }
}

/** Best stable key for the currently playing file (never throws). */
export function currentMediaKey(openUrl?: string | null): string {
  try {
    const fromRoute = matchPlayerRoute(getCurrentHashRoute());
    if (fromRoute) return fromRoute;
  } catch {
    // No window / bad hash — fall through to the URL key.
  }
  return mediaKeyFromUrl(openUrl) ?? "unknown";
}

import type { DeepLinkPayload } from "./deepLink";
import { parseDeepLink } from "./deepLink";

/** Hash route paths used by the shell. */
export const ROUTES = {
  home: "#/",
  login: "#/login",
  library: "#/library",
  tasks: "#/tasks",
  history: "#/history",
  settings: "#/settings",
  account: "#/account",
  media: (id: string | number) => `#/media/${id}`,
  player: (fileId: string | number) => `#/player/${fileId}`,
  room: (code: string) => `#/room/${code}`,
} as const;

/**
 * Legacy hashes land in the new three-destination IA:
 * tasks/history → library hub, account → settings (account block).
 */
export function resolveLegacyRoute(hash: string): string | null {
  if (hash === ROUTES.tasks || hash === ROUTES.history) return ROUTES.library;
  if (hash === ROUTES.account) return ROUTES.settings;
  return null;
}

/**
 * Map a parsed deep-link payload to a hash route path.
 * Auth callback lands on home; the tokens themselves are handled separately
 * (emitted in memory only) and must not be persisted by routing code.
 */
export function resolveRoute(payload: DeepLinkPayload): string {
  switch (payload.kind) {
    case "home":
    case "authCallback":
      return ROUTES.home;
    case "room":
      return ROUTES.room(payload.roomCode);
  }
}

/** Parse a raw `seans://` URL and resolve the target hash route, or null if ignored. */
export function resolveRouteFromDeepLink(raw: string): string | null {
  const payload = parseDeepLink(raw);
  return payload ? resolveRoute(payload) : null;
}

/** Read the current hash route (e.g. `#/room/ABCD2345`). Always starts with `#/`. */
export function getCurrentHashRoute(): string {
  const hash = window.location.hash;
  return hash.length > 0 ? hash : ROUTES.home;
}

/** Extract the room code from a `#/room/{code}` hash route, if any. */
export function matchRoomRoute(hash: string): string | null {
  const m = /^#\/room\/([A-Z2-9]{8})$/.exec(hash);
  return m ? m[1] : null;
}

/** Extract the media id from a `#/media/{id}` hash route, if any. */
export function matchMediaRoute(hash: string): string | null {
  const m = /^#\/media\/([^/]+)$/.exec(hash);
  return m ? m[1] : null;
}

/** Extract the file id from a `#/player/{fileId}` hash route, if any. */
export function matchPlayerRoute(hash: string): string | null {
  const m = /^#\/player\/([^/]+)$/.exec(hash);
  return m ? m[1] : null;
}

/**
 * Full-bleed routes render without the left nav (player, room).
 * Login is the auth gate and is handled separately by the router.
 */
export function isFullBleedRoute(hash: string): boolean {
  return matchPlayerRoute(hash) !== null || matchRoomRoute(hash) !== null;
}

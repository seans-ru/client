/**
 * Pure parser for `seans://` deep links. No Tauri/DOM deps — unit-testable.
 *
 * Accepted shapes:
 *   seans://                                 → home
 *   seans://auth/callback?access_token=&state= → auth callback (tokens returned, never stored here)
 *   seans://room/{CODE}                      → room (CODE must match ^[A-Z2-9]{8}$)
 *
 * Anything else is ignored (returns null).
 */

export type DeepLinkPayload =
  | { kind: "home" }
  | {
      kind: "authCallback";
      /** Raw `access_token` query value; null when absent. Not stored by this module. */
      accessToken: string | null;
      /** Raw `state` query value; null when absent. */
      state: string | null;
    }
  | { kind: "room"; roomCode: string; startAt: number | null };

/** Room code: 8 chars, A–Z and 2–9 (per product contract; 0/1 excluded by range). */
export const ROOM_CODE_PATTERN = /^[A-Z2-9]{8}$/;

/** `?t=754` moment deep link (issue #29): seconds; null when absent/unusable. */
export function parseStartAt(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function parseDeepLink(raw: string): DeepLinkPayload | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "seans:") return null;

  // Canonical forms:
  //   seans://                 → hostname "", pathname "/"
  //   seans://auth/callback    → hostname "auth", pathname "/callback"
  //   seans://room/CODE        → hostname "room", pathname "/CODE"
  // Windows may also deliver triple-slash forms where the host is empty:
  //   seans:///auth/callback   → hostname "", pathname "/auth/callback"
  //   seans:///room/CODE       → hostname "", pathname "/room/CODE"
  let host = url.hostname.toLowerCase();
  let segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (host === "" && segments.length > 0) {
    host = segments[0].toLowerCase();
    segments = segments.slice(1);
  }

  if (host === "" && segments.length === 0) {
    return { kind: "home" };
  }

  if (host === "auth") {
    if (segments.length === 1 && segments[0] === "callback") {
      return {
        kind: "authCallback",
        accessToken: url.searchParams.get("access_token"),
        state: url.searchParams.get("state"),
      };
    }
    return null;
  }

  if (host === "room") {
    if (segments.length === 1 && ROOM_CODE_PATTERN.test(segments[0])) {
      return {
        kind: "room",
        roomCode: segments[0],
        startAt: parseStartAt(url.searchParams.get("t")),
      };
    }
    return null;
  }

  return null;
}

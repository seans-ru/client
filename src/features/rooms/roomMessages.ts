/**
 * Watch-party WS message encode/parse (M10 + room-sync milestone 0.2.0).
 * Pure — no sockets, unit-testable.
 *
 * Client→server: join / heartbeat / state / ready / sync_request / leave.
 * Server→client: room_state / state / ready / member_joined / member_left /
 * error. Parsing is tolerant of unknown fields and partial payloads.
 *
 * Protocol extension (issues #27/#30/#31), backward compatible:
 * - `heartbeat` carries optional `buffered_ahead` / `ready` telemetry. Old
 *   servers ignore the extra fields; old clients never send them.
 * - `state` frames accept extended `action` values with payloads riding in
 *   `position` so today's relay (which forwards `action`/`position` verbatim)
 *   carries them without a server change:
 *   - `sync`       — host position reference for drift correction;
 *   - `set_tracks` — payload `{audio_id, sub_id}` (the `setTracks` event);
 *   - `track_mode` — payload `{mode: "host" | "free"}`.
 *   Old clients drop these frames (`normalizeAction` rejects unknown actions),
 *   old servers keep `room.position` untouched (only play/pause/seek write it).
 * - `ready {ready, buffered_ahead}` is a new frame type (guest→host readiness);
 *   it needs a relay-capable server to fan out, see `ready` server→client.
 * - Server→client `set_tracks` / `track_mode` / `ready` / `sync` native frame
 *   types are accepted as well (forward compatibility if the relay grows).
 */

import type {
  RoomAction,
  RoomPlaybackAction,
  RoomTrackMode,
} from "./roomReducer";

/* ---------------------------------------------------------- client → server */

export type ClientRoomMessage =
  | { type: "join" }
  | {
      type: "heartbeat";
      position: number;
      /** Seconds buffered ahead of the playhead (telemetry, optional). */
      bufferedAhead?: number | null;
      /** Guest readiness flag (telemetry, optional). */
      ready?: boolean | null;
    }
  | { type: "state"; action: RoomPlaybackAction; position: number }
  | { type: "sync"; position: number }
  | { type: "set_tracks"; audioId: number | null; subId: number | null }
  | { type: "track_mode"; mode: RoomTrackMode }
  | { type: "ready"; ready: boolean; bufferedAhead: number }
  | { type: "sync_request" }
  | { type: "leave" };

/** Serialize a client frame. Position is clamped to a finite ≥ 0 number. */
export function encodeRoomMessage(message: ClientRoomMessage): string {
  switch (message.type) {
    case "join":
    case "sync_request":
    case "leave":
      return JSON.stringify({ type: message.type });
    case "heartbeat": {
      const frame: Record<string, unknown> = {
        type: "heartbeat",
        position: safePosition(message.position),
      };
      // Optional telemetry — omitted entirely when absent (old-wire shape).
      if (message.bufferedAhead != null && Number.isFinite(message.bufferedAhead)) {
        frame.buffered_ahead = Math.max(0, message.bufferedAhead);
      }
      if (typeof message.ready === "boolean") frame.ready = message.ready;
      return JSON.stringify(frame);
    }
    case "state":
      return JSON.stringify({
        type: "state",
        action: normalizeAction(message.action) ?? "seek",
        position: safePosition(message.position),
      });
    case "sync":
      // Extended `state` action: relay-compatible position reference.
      return JSON.stringify({
        type: "state",
        action: "sync",
        position: safePosition(message.position),
      });
    case "set_tracks":
      // Payload rides in `position` — the relay forwards that value verbatim.
      return JSON.stringify({
        type: "state",
        action: "set_tracks",
        position: {
          audio_id: normalizeTrackId(message.audioId),
          sub_id: normalizeTrackId(message.subId),
        },
      });
    case "track_mode":
      return JSON.stringify({
        type: "state",
        action: "track_mode",
        position: { mode: normalizeTrackMode(message.mode) },
      });
    case "ready":
      return JSON.stringify({
        type: "ready",
        ready: Boolean(message.ready),
        buffered_ahead: safeBufferedAhead(message.bufferedAhead),
      });
    default:
      return JSON.stringify({ type: "join" });
  }
}

export function encodeJoin(): string {
  return encodeRoomMessage({ type: "join" });
}

export function encodeHeartbeat(
  position: number,
  extras?: { bufferedAhead?: number | null; ready?: boolean | null },
): string {
  return encodeRoomMessage({
    type: "heartbeat",
    position,
    bufferedAhead: extras?.bufferedAhead ?? null,
    ready: extras?.ready ?? null,
  });
}

export function encodeState(
  action: RoomPlaybackAction,
  position: number,
): string {
  return encodeRoomMessage({ type: "state", action, position });
}

/** Host drift reference (extended `state` action, relay-compatible). */
export function encodeSync(position: number): string {
  return encodeRoomMessage({ type: "sync", position });
}

/** `setTracks` event — host picks audio/sub tracks for the whole room. */
export function encodeSetTracks(
  audioId: number | null,
  subId: number | null,
): string {
  return encodeRoomMessage({ type: "set_tracks", audioId, subId });
}

/** Room track mode — «Синхронно от хоста» / «Свободный выбор». */
export function encodeTrackMode(mode: RoomTrackMode): string {
  return encodeRoomMessage({ type: "track_mode", mode });
}

/** Readiness report (guest→host) with buffered-ahead telemetry. */
export function encodeReady(ready: boolean, bufferedAhead: number): string {
  return encodeRoomMessage({ type: "ready", ready, bufferedAhead });
}

export function encodeSyncRequest(): string {
  return encodeRoomMessage({ type: "sync_request" });
}

export function encodeLeave(): string {
  return encodeRoomMessage({ type: "leave" });
}

/* ---------------------------------------------------------- server → client */

export type ServerRoomMessage =
  | {
      type: "room_state";
      hostId: string | null;
      position: number;
      isPlaying: boolean;
      ts: number | null;
    }
  | {
      type: "state";
      action: RoomPlaybackAction;
      position: number;
      by: string | null;
    }
  | {
      /** Host position reference (extended `state` action / native frame). */
      type: "sync";
      position: number;
      by: string | null;
    }
  | {
      /** `setTracks` event (extended `state` action / native frame). */
      type: "set_tracks";
      audioId: number | null;
      subId: number | null;
      by: string | null;
    }
  | {
      type: "track_mode";
      mode: RoomTrackMode;
      by: string | null;
    }
  | {
      type: "ready";
      userId: string;
      ready: boolean;
      bufferedAhead: number;
      name: string | null;
    }
  | { type: "member_joined"; userId: string; name: string | null }
  | { type: "member_left"; userId: string; name: string | null }
  | { type: "error"; detail: string };

type Raw = Record<string, unknown>;

function asRaw(value: unknown): Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : {};
}

function safePosition(value: unknown): number {
  let n = 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    n = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    n = Number.isFinite(parsed) ? parsed : 0;
  }
  return n < 0 ? 0 : n;
}

function safeBufferedAhead(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function nonEmpty(value: unknown): string | null {
  const s = str(value);
  return s !== null && s.length > 0 ? s : null;
}

function normalizeAction(value: unknown): RoomPlaybackAction | null {
  return value === "play" || value === "pause" || value === "seek" ? value : null;
}

function normalizeBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    return t === "true" || t === "1" || t === "yes";
  }
  return false;
}

function normalizeTs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Track id on the wire: a positive int, or `null` (off / unknown). */
export function normalizeTrackId(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

export function normalizeTrackMode(value: unknown): RoomTrackMode {
  return value === "free" ? "free" : "host";
}

/** Shared `by` extraction for both wire forms of extended state frames. */
function frameBy(r: Raw): string | null {
  return nonEmpty(r.by);
}

/**
 * Parse one server frame. Returns null for non-JSON, unknown `type`, or
 * payloads missing the identity fields required by that type.
 */
export function parseRoomMessage(raw: string): ServerRoomMessage | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const r = asRaw(parsed);
  const type = nonEmpty(r.type);
  if (type === null) return null;

  switch (type) {
    case "room_state":
      return {
        type: "room_state",
        hostId: nonEmpty(r.host_id),
        position: safePosition(r.position),
        isPlaying: normalizeBool(r.is_playing),
        ts: normalizeTs(r.ts),
      };

    case "state": {
      // Extended actions carry payloads in `position` (relay-compatible form).
      if (r.action === "sync") {
        return {
          type: "sync",
          position: safePosition(r.position),
          by: frameBy(r),
        };
      }
      if (r.action === "set_tracks") {
        return parseSetTracksPayload(asRaw(r.position), frameBy(r));
      }
      if (r.action === "track_mode") {
        const payload = asRaw(r.position);
        return {
          type: "track_mode",
          mode: normalizeTrackMode(payload.mode ?? r.mode),
          by: frameBy(r),
        };
      }
      const action = normalizeAction(r.action);
      if (action === null) return null;
      return {
        type: "state",
        action,
        position: safePosition(r.position),
        by: nonEmpty(r.by),
      };
    }

    case "sync":
      return {
        type: "sync",
        position: safePosition(r.position),
        by: frameBy(r),
      };

    case "set_tracks":
      return parseSetTracksPayload(r, frameBy(r));

    case "track_mode":
      return {
        type: "track_mode",
        mode: normalizeTrackMode(r.mode),
        by: frameBy(r),
      };

    case "ready": {
      const userRaw = asRaw(r.user);
      const userId = nonEmpty(userRaw.user_id) ?? nonEmpty(r.user_id);
      if (userId === null) return null;
      return {
        type: "ready",
        userId,
        ready: normalizeBool(r.ready),
        bufferedAhead: safeBufferedAhead(r.buffered_ahead ?? r.bufferedAhead),
        name: nonEmpty(userRaw.name) ?? nonEmpty(r.name),
      };
    }

    case "member_joined":
    case "member_left": {
      const userRaw = asRaw(r.user);
      const userId = nonEmpty(userRaw.user_id) ?? nonEmpty(r.user_id);
      if (userId === null) return null;
      return {
        type,
        userId,
        name: nonEmpty(userRaw.name) ?? nonEmpty(r.name),
      };
    }

    case "error":
      return {
        type: "error",
        detail: nonEmpty(r.detail) ?? nonEmpty(r.message) ?? "Ошибка комнаты",
      };

    default:
      return null;
  }
}

function parseSetTracksPayload(
  payload: Raw,
  by: string | null,
): ServerRoomMessage {
  return {
    type: "set_tracks",
    audioId: normalizeTrackId(payload.audio_id ?? payload.audioId),
    subId: normalizeTrackId(payload.sub_id ?? payload.subId),
    by,
  };
}

/** Map a parsed server frame onto the pure reducer action shape. */
export function serverMessageToAction(message: ServerRoomMessage): RoomAction {
  switch (message.type) {
    case "room_state":
      return {
        type: "room_state",
        hostId: message.hostId,
        position: message.position,
        isPlaying: message.isPlaying,
        ts: message.ts,
      };
    case "state":
      return {
        type: "state",
        action: message.action,
        position: message.position,
        by: message.by,
      };
    case "sync":
      return { type: "sync", position: message.position, by: message.by };
    case "set_tracks":
      return {
        type: "set_tracks",
        audioId: message.audioId,
        subId: message.subId,
        by: message.by,
      };
    case "track_mode":
      return { type: "track_mode", mode: message.mode, by: message.by };
    case "ready":
      return {
        type: "member_ready",
        user: { user_id: message.userId, name: message.name },
        ready: message.ready,
        bufferedAhead: message.bufferedAhead,
      };
    case "member_joined":
    case "member_left":
      return {
        type: message.type,
        user: { user_id: message.userId, name: message.name },
      };
    case "error":
      return { type: "error", detail: message.detail };
  }
}

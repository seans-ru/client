/**
 * Pure watch-party room state machine (M10 + room-sync milestone 0.2.0).
 * No React/DOM/WS — unit-testable.
 *
 * Feeds on normalized server frames (see `roomMessages`) plus socket lifecycle
 * actions (`connected`, `closed`). Guests apply `state` / `room_state` to the
 * player; the reducer itself only mirrors the room so the UI can render it.
 *
 * Additive state for issues #27/#30/#31 (all optional — old actions keep their
 * shape): per-member readiness (`presence`), room track mode + host tracks,
 * `started` (lobby → watching), and `syncTarget` (host reference for drift
 * correction, timestamped at frame receipt).
 */

export type RoomStatus = "idle" | "connecting" | "connected" | "closed";

export type RoomPlaybackAction = "play" | "pause" | "seek";

/** «Синхронно от хоста» (default) / «Свободный выбор» (issue #31). */
export type RoomTrackMode = "host" | "free";

/** mpv track ids shared across the room (same file for everyone). */
export type RoomTracks = {
  audioId: number | null;
  subId: number | null;
};

/** Transient readiness per member (issue #27/#30). */
export type RoomPresence = {
  /** `null` = no `ready` frame seen yet («подключается»). */
  ready: boolean | null;
  /** Seconds buffered ahead of the playhead, when reported. */
  bufferedAhead: number | null;
};

export type RoomMember = {
  userId: string;
  name: string | null;
};

/** Host playback reference used by drift correction. */
export type RoomSyncTarget = {
  position: number;
  isPlaying: boolean;
  /** Frame receipt time (ms epoch) — `0` when unknown (tests). */
  receivedAt: number;
};

export type RoomState = {
  status: RoomStatus;
  /** Current host user id (null until the first `room_state` / REST seed). */
  hostId: string | null;
  /** Room playback position in seconds. */
  position: number;
  isPlaying: boolean;
  members: RoomMember[];
  /** Last server/local error, cleared on the next successful sync. */
  error: string | null;
  /** WS close code when `status` is `closed`. */
  closeCode: number | null;
  /** Per-member readiness keyed by user id (issue #30 lobby). */
  presence: Record<string, RoomPresence>;
  /** Track selection mode (issue #31). */
  trackMode: RoomTrackMode;
  /** Last `setTracks` from the host, `null` until the first one. */
  hostTracks: RoomTracks | null;
  /** False until playback actually starts — the lobby phase. */
  started: boolean;
  /** Latest host position reference (issue #27). */
  syncTarget: RoomSyncTarget | null;
};

export type RoomAction =
  | { type: "connected" }
  | {
      type: "room_state";
      hostId: string | null;
      position: number;
      isPlaying: boolean;
      ts?: number | null;
      receivedAt?: number;
    }
  | {
      type: "state";
      action: RoomPlaybackAction;
      position: number;
      by: string | null;
      receivedAt?: number;
    }
  | {
      /** Host position reference (drift correction input). */
      type: "sync";
      position: number;
      by: string | null;
      receivedAt?: number;
    }
  | { type: "member_joined"; user: { user_id: string; name?: string | null } }
  | { type: "member_left"; user: { user_id: string; name?: string | null } }
  | {
      type: "member_ready";
      user: { user_id: string; name?: string | null };
      ready: boolean;
      bufferedAhead?: number | null;
    }
  | {
      type: "set_tracks";
      audioId: number | null;
      subId: number | null;
      by: string | null;
    }
  | { type: "track_mode"; mode: RoomTrackMode; by: string | null }
  /** Local/host start signal (lobby dismissed). */
  | { type: "started" }
  | { type: "error"; detail: string }
  | { type: "closed"; code: number | null };

export function createInitialRoomState(
  options: {
    members?: Array<{ user_id: string; name?: string | null }>;
    hostId?: string | null;
    status?: RoomStatus;
  } = {},
): RoomState {
  return {
    status: options.status ?? "idle",
    hostId: options.hostId ?? null,
    position: 0,
    isPlaying: false,
    members: (options.members ?? []).map((m) => ({
      userId: String(m.user_id),
      name: m.name != null && m.name !== "" ? m.name : null,
    })),
    error: null,
    closeCode: null,
    presence: {},
    trackMode: "host",
    hostTracks: null,
    started: false,
    syncTarget: null,
  };
}

function upsertMember(
  members: RoomMember[],
  user: { user_id: string; name?: string | null },
): RoomMember[] {
  const userId = String(user.user_id);
  const name = user.name != null && user.name !== "" ? user.name : null;
  const index = members.findIndex((m) => m.userId === userId);
  if (index < 0) {
    return [...members, { userId, name }];
  }
  const next = members.slice();
  const existing = next[index];
  next[index] = {
    userId,
    // Prefer the freshest non-empty name (WS frames carry display names).
    name: name ?? existing.name,
  };
  return next;
}

function removeMember(members: RoomMember[], user: { user_id: string }): RoomMember[] {
  const userId = String(user.user_id);
  return members.filter((m) => m.userId !== userId);
}

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function removePresence(
  presence: Record<string, RoomPresence>,
  userId: string,
): Record<string, RoomPresence> {
  if (!(userId in presence)) return presence;
  const next = { ...presence };
  delete next[userId];
  return next;
}

/** A room that has played (or reports a real position) is past the lobby. */
export function isRoomStarted(input: {
  isPlaying: boolean;
  position: number;
}): boolean {
  return input.isPlaying || input.position > 3;
}

/**
 * Reduce one room action. Pure and total: unknown/partial payloads degrade to
 * safe defaults rather than throwing.
 */
export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "connected":
      return {
        ...state,
        status: "connected",
        error: null,
        closeCode: null,
      };

    case "room_state": {
      const position = num(action.position);
      const isPlaying = Boolean(action.isPlaying);
      return {
        ...state,
        status: state.status === "closed" ? state.status : "connected",
        hostId: action.hostId != null ? String(action.hostId) : state.hostId,
        position,
        isPlaying,
        started:
          state.started ||
          isRoomStarted({ isPlaying, position }),
        syncTarget:
          typeof action.receivedAt === "number"
            ? { position, isPlaying, receivedAt: action.receivedAt }
            : state.syncTarget,
        error: null,
      };
    }

    case "state": {
      const position = num(action.position);
      const isPlaying =
        action.action === "play"
          ? true
          : action.action === "pause"
            ? false
            : state.isPlaying;
      return {
        ...state,
        position,
        isPlaying,
        started: state.started || action.action === "play",
        syncTarget:
          typeof action.receivedAt === "number"
            ? { position, isPlaying, receivedAt: action.receivedAt }
            : state.syncTarget,
        error: null,
      };
    }

    case "sync": {
      // Position reference only — playback flags come from play/pause frames.
      const position = num(action.position);
      return {
        ...state,
        position,
        syncTarget: {
          position,
          isPlaying: state.isPlaying,
          receivedAt: num(action.receivedAt),
        },
        error: null,
      };
    }

    case "member_joined":
      return {
        ...state,
        members: upsertMember(state.members, action.user),
        presence: {
          ...state.presence,
          [String(action.user.user_id)]: state.presence[
            String(action.user.user_id)
          ] ?? { ready: null, bufferedAhead: null },
        },
      };

    case "member_left": {
      const userId = String(action.user.user_id);
      return {
        ...state,
        members: removeMember(state.members, action.user),
        presence: removePresence(state.presence, userId),
      };
    }

    case "member_ready": {
      const userId = String(action.user.user_id);
      return {
        ...state,
        members: upsertMember(state.members, action.user),
        presence: {
          ...state.presence,
          [userId]: {
            ready: Boolean(action.ready),
            bufferedAhead:
              typeof action.bufferedAhead === "number" &&
              Number.isFinite(action.bufferedAhead)
                ? action.bufferedAhead
                : (state.presence[userId]?.bufferedAhead ?? null),
          },
        },
      };
    }

    case "set_tracks":
      return {
        ...state,
        hostTracks: {
          audioId: action.audioId ?? null,
          subId: action.subId ?? null,
        },
        error: null,
      };

    case "track_mode":
      return {
        ...state,
        trackMode: action.mode === "free" ? "free" : "host",
        error: null,
      };

    case "started":
      return { ...state, started: true };

    case "error":
      return {
        ...state,
        error:
          typeof action.detail === "string" && action.detail.length > 0
            ? action.detail
            : "Ошибка комнаты",
      };

    case "closed":
      return {
        ...state,
        status: "closed",
        closeCode: typeof action.code === "number" ? action.code : null,
      };

    default:
      return state;
  }
}

/**
 * Room ↔ player-extension bridge (issues #27/#30/#31).
 *
 * The room socket lives in `useRoomSocket` (features/rooms) and the features
 * live in player extensions (`features/player/extensions/room*`). Both sides
 * meet here: `RoomScreen` mirrors the pure `RoomState` into this store and
 * binds the outbound senders; extensions subscribe (React `useSyncExternalStore`
 * or plain listeners) and call `actions.*` for user intent.
 *
 * Pure helpers (`expectedPosition`, `deriveEffectiveReady`) are exported for
 * unit tests. No React, no sockets — the store itself is framework-free.
 */

import { memberLabel } from "./roomHelpers";
import type {
  RoomPresence,
  RoomState,
  RoomTrackMode,
  RoomTracks,
  RoomSyncTarget,
} from "./roomReducer";

export type Unsubscribe = () => void;

export type RoomChannelMember = {
  userId: string;
  name: string | null;
  ready: boolean | null;
  bufferedAhead: number | null;
  isHost: boolean;
  isSelf: boolean;
};

export type RoomToast = {
  id: number;
  kind: "joined" | "left";
  text: string;
};

export type RoomSessionInfo = {
  code: string;
  selfUserId: string;
  taskFileId: string;
};

export type RoomChannelState = {
  session: (RoomSessionInfo & { isHost: boolean }) | null;
  phase: "lobby" | "watching";
  members: RoomChannelMember[];
  trackMode: RoomTrackMode;
  hostTracks: RoomTracks | null;
  /** Host playback reference for drift correction (issue #27). */
  target: RoomSyncTarget | null;
  toasts: RoomToast[];
  /** Own readiness inputs — the server never echoes frames back to the sender. */
  manualReady: boolean | null;
  bufferedAhead: number;
  /** Effective own readiness (manual override or buffer-based, issue #30). */
  ready: boolean;
};

export type RoomChannelSenders = {
  setReady: (ready: boolean, bufferedAhead: number) => void;
  setTracks: (tracks: RoomTracks) => void;
  setTrackMode: (mode: RoomTrackMode) => void;
  syncRef: (position: number) => void;
  /** Personal seek back to the group position (never broadcast). */
  seekToGroup: (position: number) => void;
};

export type RoomChannelActions = {
  /** Manual «Я готов» toggle (`true`/`false` override; `null` back to auto). */
  setReady: (ready: boolean | null) => void;
  setTracks: (tracks: RoomTracks) => void;
  setTrackMode: (mode: RoomTrackMode) => void;
  /** Host: broadcast a drift reference at the current playback position. */
  sendSyncRef: (position: number) => void;
  /** Local seek back to the group position (lag prompt button). */
  seekToGroup: () => void;
};

export type RoomChannel = {
  subscribe: (cb: () => void) => Unsubscribe;
  get: () => RoomChannelState;
  /** Start (or refresh) the room session. Same code+file keeps accumulated state. */
  beginSession: (info: RoomSessionInfo) => void;
  endSession: () => void;
  /** Mirror the pure room reducer state (RoomScreen, every dispatch). */
  syncRoom: (state: RoomState) => void;
  /** Lobby dismissed (host start / auto-start). */
  markStarted: () => void;
  /** Buffer telemetry from the player (issue #27/#30 phase-2 auto-ready). */
  setBufferedAhead: (seconds: number) => void;
  dismissToast: (id: number) => void;
  bindSenders: (senders: RoomChannelSenders) => void;
  actions: RoomChannelActions;
};

/** Auto-ready threshold: buffer ahead of ≥ N seconds counts as ready. */
export const AUTO_READY_BUFFER_SEC = 5;

/** Host playback reference interpolated to "now" (drift baseline). */
export function expectedPosition(
  target: Pick<RoomSyncTarget, "position" | "isPlaying" | "receivedAt"> | null,
  nowMs: number,
): number {
  if (!target) return 0;
  if (!target.isPlaying || target.receivedAt <= 0) return target.position;
  const elapsed = Math.max(0, (nowMs - target.receivedAt) / 1000);
  return target.position + elapsed;
}

/**
 * Effective readiness: an explicit manual choice wins; otherwise the buffer
 * telemetry decides (phase 2 of the ready-check, issue #30).
 */
export function deriveEffectiveReady(input: {
  manualReady: boolean | null;
  bufferedAhead: number;
}): boolean {
  if (typeof input.manualReady === "boolean") return input.manualReady;
  return input.bufferedAhead >= AUTO_READY_BUFFER_SEC;
}

export function createRoomChannel(): RoomChannel {
  const listeners = new Set<() => void>();
  let toastSeq = 0;

  const emptyState = (): RoomChannelState => ({
    session: null,
    phase: "lobby",
    members: [],
    trackMode: "host",
    hostTracks: null,
    target: null,
    toasts: [],
    manualReady: null,
    bufferedAhead: 0,
    ready: false,
  });

  let state: RoomChannelState = emptyState();
  /** Member ids of the previous `syncRoom` — join/leave toast diffing. */
  let lastMemberIds: string[] | null = null;
  /** Last readiness flag pushed to the room (no echo for the sender). */
  let lastSentReady = false;
  let senders: RoomChannelSenders | null = null;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const setState = (patch: Partial<RoomChannelState>): void => {
    state = { ...state, ...patch };
    notify();
  };

  const effectiveReady = (): boolean =>
    deriveEffectiveReady({
      manualReady: state.manualReady,
      bufferedAhead: state.bufferedAhead,
    });

  /** Push readiness to the room when the effective flag changes. */
  const flushReady = (): void => {
    const ready = effectiveReady();
    if (ready === state.ready && ready === lastSentReady) return;
    setState({ ready });
    if (ready !== lastSentReady) {
      lastSentReady = ready;
      senders?.setReady(ready, state.bufferedAhead);
    }
  };

  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => state,

    beginSession(info) {
      // Refresh of the same session (e.g. self id resolved later) keeps state.
      if (
        state.session &&
        state.session.code === info.code &&
        state.session.taskFileId === info.taskFileId
      ) {
        if (state.session.selfUserId !== info.selfUserId) {
          setState({
            session: { ...state.session, selfUserId: info.selfUserId },
          });
        }
        return;
      }
      state = {
        ...emptyState(),
        session: {
          code: info.code,
          selfUserId: info.selfUserId,
          taskFileId: info.taskFileId,
          isHost: false,
        },
      };
      lastMemberIds = null;
      lastSentReady = false;
      notify();
    },

    endSession() {
      state = emptyState();
      lastMemberIds = null;
      lastSentReady = false;
      notify();
    },

    syncRoom(roomState) {
      const session = state.session;
      if (!session) return;

      const isHost =
        roomState.hostId != null &&
        String(roomState.hostId) === session.selfUserId;

      const members: RoomChannelMember[] = roomState.members.map((m) => {
        const presence: RoomPresence | undefined = roomState.presence[m.userId];
        return {
          userId: m.userId,
          name: m.name,
          ready: presence?.ready ?? null,
          bufferedAhead: presence?.bufferedAhead ?? null,
          isHost: roomState.hostId != null && m.userId === String(roomState.hostId),
          isSelf: m.userId === session.selfUserId,
        };
      });

      // Join/leave toasts (skip the initial roster — that is not an event).
      let toasts = state.toasts;
      const nextIds = members.map((m) => m.userId);
      if (lastMemberIds != null) {
        const previous = new Set(lastMemberIds);
        const next = new Set(nextIds);
        const fresh: RoomToast[] = [];
        for (const member of members) {
          if (!previous.has(member.userId)) {
            fresh.push({
              id: ++toastSeq,
              kind: "joined",
              text: `${memberLabel(member)} — в комнате`,
            });
          }
        }
        for (const userId of lastMemberIds) {
          if (!next.has(userId)) {
            const gone = state.members.find((m) => m.userId === userId);
            fresh.push({
              id: ++toastSeq,
              kind: "left",
              text: `${gone ? memberLabel(gone) : "Участник"} вышел из комнаты`,
            });
          }
        }
        if (fresh.length > 0) {
          toasts = [...state.toasts, ...fresh].slice(-4);
        }
      }
      lastMemberIds = nextIds;

      const localStarted = state.phase === "watching";
      setState({
        session: { ...session, isHost },
        phase: localStarted || roomState.started ? "watching" : "lobby",
        members,
        trackMode: roomState.trackMode,
        hostTracks: roomState.hostTracks,
        target: roomState.syncTarget,
        toasts,
      });
    },

    markStarted() {
      if (state.phase !== "watching") setState({ phase: "watching" });
    },

    setBufferedAhead(seconds) {
      const value =
        typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
          ? seconds
          : 0;
      if (value === state.bufferedAhead) return;
      setState({ bufferedAhead: value });
      flushReady();
    },

    dismissToast(id) {
      if (!state.toasts.some((t) => t.id === id)) return;
      setState({ toasts: state.toasts.filter((t) => t.id !== id) });
    },

    bindSenders(next) {
      senders = next;
    },

    actions: {
      setReady(ready) {
        setState({ manualReady: ready });
        flushReady();
      },
      setTracks(tracks) {
        senders?.setTracks({
          audioId: tracks.audioId ?? null,
          subId: tracks.subId ?? null,
        });
      },
      setTrackMode(mode) {
        senders?.setTrackMode(mode === "free" ? "free" : "host");
      },
      sendSyncRef(position) {
        senders?.syncRef(position);
      },
      seekToGroup() {
        const target = state.target;
        if (!target) return;
        senders?.seekToGroup(expectedPosition(target, Date.now()));
      },
    },
  };
}

/** The app-wide room channel (one room session at a time). */
export const roomChannel: RoomChannel = createRoomChannel();

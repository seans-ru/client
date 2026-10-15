/**
 * Room WebSocket hook (M10).
 *
 * Connects to `wss://…/ws/rooms/{code}?token=<JWT>`, drives the pure
 * `roomReducer`, heartbeats the local player position, and exposes host
 * `state` sends + guest remote-apply plumbing.
 *
 * Lifecycle: join on open (guests also `sync_request`), heartbeat every
 * `ROOM_HEARTBEAT_INTERVAL_MS`, `leave` + close on unmount. Close codes
 * 4001/4004 map to localized copy via `roomCloseMessage`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "../../api/client";
import { getSessionToken } from "../../api/session";
import {
  buildRoomWsUrl,
  isHost,
  roomCloseMessage,
  shouldApplyRemoteState,
  ROOM_HEARTBEAT_INTERVAL_MS,
} from "./roomHelpers";
import {
  encodeHeartbeat,
  encodeJoin,
  encodeLeave,
  encodeState,
  encodeSyncRequest,
  parseRoomMessage,
  serverMessageToAction,
} from "./roomMessages";
import type { ServerRoomMessage } from "./roomMessages";
import { createInitialRoomState, roomReducer } from "./roomReducer";
import type {
  RoomAction,
  RoomPlaybackAction,
  RoomState,
} from "./roomReducer";

export type UseRoomSocketOptions = {
  /** Room code (`^[A-Z2-9]{8}$`). */
  code: string;
  /** `room.ws_url` from REST; derived from `API_BASE_URL` when omitted. */
  wsUrl?: string | null;
  /** Current user id (host detection / echo suppression). */
  selfUserId: string | number | null;
  /** Connect only when true (room detail resolved, code valid). */
  enabled?: boolean;
  /** Local player position for heartbeats. */
  getPosition: () => number;
  /**
   * Apply a remote command to the local player (guests).
   * `isPlaying` is provided for `room_state` frames.
   */
  applyRemote: (
    action: RoomPlaybackAction,
    position: number,
    isPlaying?: boolean,
  ) => void | Promise<void>;
  /** REST members to seed before WS `member_*` frames arrive. */
  initialMembers?: Array<{ user_id: string; name?: string | null }>;
  /** REST host id seed (optional). */
  initialHostId?: string | number | null;
  /** Bump to force a reconnect (same code/url). */
  reconnectToken?: number;
};

export type UseRoomSocketResult = {
  state: RoomState;
  /** True when the local user is the current host. */
  isHost: boolean;
  /**
   * Broadcast a local transport change. Guests may still call this — the
   * server rejects with an `error` frame that surfaces as `state.error`.
   */
  sendState: (action: RoomPlaybackAction, position: number) => void;
  /** Ask the host/server for a `room_state` snapshot. */
  sendSyncRequest: () => void;
  /** Send `leave` (safe to call before unmount). */
  leave: () => void;
};

export function useRoomSocket(options: UseRoomSocketOptions): UseRoomSocketResult {
  const {
    code,
    wsUrl = null,
    selfUserId,
    enabled = true,
    initialMembers,
    initialHostId = null,
    reconnectToken = 0,
  } = options;

  const [state, setState] = useState<RoomState>(() =>
    createInitialRoomState({
      members: initialMembers ?? [],
      hostId: initialHostId == null ? null : String(initialHostId),
    }),
  );

  const stateRef = useRef(state);
  stateRef.current = state;

  const dispatch = useCallback((action: RoomAction) => {
    setState((prev) => roomReducer(prev, action));
  }, []);

  // Keep callbacks / identity in refs so the socket effect does not reconnect
  // when the player ticks or the auth object is recreated.
  const getPositionRef = useRef(options.getPosition);
  getPositionRef.current = options.getPosition;
  const applyRemoteRef = useRef(options.applyRemote);
  applyRemoteRef.current = options.applyRemote;
  const selfUserIdRef = useRef(selfUserId);
  selfUserIdRef.current = selfUserId;

  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current != null) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const sendRaw = useCallback((payload: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(payload);
  }, []);

  const sendState = useCallback(
    (action: RoomPlaybackAction, position: number) => {
      // Protocol hard rule: only the host may send `state`.
      if (!localIsHostRef.current) return;
      sendRaw(encodeState(action, position));
    },
    [sendRaw],
  );

  const sendSyncRequest = useCallback(() => {
    sendRaw(encodeSyncRequest());
  }, [sendRaw]);

  const leave = useCallback(() => {
    sendRaw(encodeLeave());
  }, [sendRaw]);

  const applyRemoteMessage = useCallback(
    (message: ServerRoomMessage, hostId: string | null) => {
      const self = selfUserIdRef.current;
      if (
        !shouldApplyRemoteState({
          selfUserId: self,
          hostUserId: hostId,
          byUserId: message.type === "state" ? message.by : null,
        })
      ) {
        return;
      }
      if (message.type === "room_state") {
        void applyRemoteRef.current(
          message.isPlaying ? "play" : "pause",
          message.position,
          message.isPlaying,
        );
      } else if (message.type === "state") {
        void applyRemoteRef.current(message.action, message.position);
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !code) return;

    const token = getSessionToken();
    if (!token) {
      dispatch({ type: "error", detail: "Нет доступа" });
      return;
    }

    let cancelled = false;
    const url = buildRoomWsUrl({
      code,
      token,
      wsUrl,
      apiBaseUrl: API_BASE_URL,
    });

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      dispatch({ type: "error", detail: "Не удалось подключиться к комнате" });
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (cancelled) return;
      ws.send(encodeJoin());
      // Guests need a snapshot after join; hosts accept the reply too.
      ws.send(encodeSyncRequest());
      dispatch({ type: "connected" });

      clearHeartbeat();
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(encodeHeartbeat(getPositionRef.current()));
      }, ROOM_HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (cancelled) return;
      const message = parseRoomMessage(String(event.data ?? ""));
      if (!message) return;
      dispatch(serverMessageToAction(message));
      // Host id may have just arrived on this frame — prefer it for the decision.
      const hostId =
        message.type === "room_state" ? message.hostId : stateRef.current.hostId;
      applyRemoteMessage(message, hostId);
    };

    ws.onerror = () => {
      // `onclose` always follows; the close code path is the single error source.
    };

    ws.onclose = (event) => {
      if (cancelled) return;
      clearHeartbeat();
      dispatch({
        type: "closed",
        code: typeof event.code === "number" ? event.code : null,
      });
      if (event.code === 4001 || event.code === 4004) {
        dispatch({ type: "error", detail: roomCloseMessage(event.code) });
      }
    };

    return () => {
      cancelled = true;
      clearHeartbeat();
      // Never abort a CONNECTING socket — the browser logs
      // "WebSocket is closed before the connection is established" and the
      // server sees a half-open peer (React StrictMode does this on purpose).
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeLeave());
          ws.close(1000, "leave");
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.addEventListener(
            "open",
            () => {
              try {
                ws.close(1000, "unmount");
              } catch {
                // ignore
              }
            },
            { once: true },
          );
        }
      } catch {
        // Ignore teardown races.
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [code, wsUrl, enabled, reconnectToken, dispatch, clearHeartbeat, applyRemoteMessage]);

  const localIsHost = useMemo(
    () => isHost(state.hostId, selfUserId),
    [state.hostId, selfUserId],
  );

  // Keep host flag readable from stable callbacks (`sendState`).
  const localIsHostRef = useRef(localIsHost);
  localIsHostRef.current = localIsHost;

  return {
    state,
    isHost: localIsHost,
    sendState,
    sendSyncRequest,
    leave,
  };
}

/**
 * Rooms feature barrel (M10). Pure helpers live in `roomReducer` /
 * `roomMessages` / `roomHelpers` (unit-tested).
 */

export { RoomPanel } from "./RoomPanel";
export type { RoomPanelProps } from "./RoomPanel";
export {
  buildRoomWsUrl,
  isAbsoluteWsUrl,
  isHost,
  memberLabel,
  resolveRoomWsUrl,
  roomCloseMessage,
  roomShareUrl,
  shouldApplyRemoteState,
  toWebSocketBase,
  ROOM_CLOSE_NOT_FOUND,
  ROOM_CLOSE_UNAUTHORIZED,
  ROOM_HEARTBEAT_INTERVAL_MS,
  ROOM_SHARE_BASE_URL,
} from "./roomHelpers";
export type { BuildRoomWsUrlOptions, RemoteApplyInput } from "./roomHelpers";
export {
  encodeHeartbeat,
  encodeJoin,
  encodeLeave,
  encodeRoomMessage,
  encodeState,
  encodeSyncRequest,
  parseRoomMessage,
  serverMessageToAction,
} from "./roomMessages";
export type {
  ClientRoomMessage,
  ServerRoomMessage,
} from "./roomMessages";
export {
  createInitialRoomState,
  roomReducer,
} from "./roomReducer";
export type {
  RoomAction,
  RoomMember,
  RoomPlaybackAction,
  RoomState,
  RoomStatus,
} from "./roomReducer";
export { useRoomDetail } from "./useRoomDetail";
export type { RoomDetailState, RoomDetailStatus } from "./useRoomDetail";
export { useRoomSocket } from "./useRoomSocket";
export type { UseRoomSocketOptions, UseRoomSocketResult } from "./useRoomSocket";

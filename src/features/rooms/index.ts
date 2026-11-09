/**
 * Rooms feature barrel (M10). Pure helpers live in `roomReducer` /
 * `roomMessages` / `roomHelpers` (unit-tested).
 */

export { RoomPanel } from "./RoomPanel";
export type { RoomPanelProps } from "./RoomPanel";
export {
  createRoomChannel,
  deriveEffectiveReady,
  expectedPosition,
  roomChannel,
  AUTO_READY_BUFFER_SEC,
} from "./roomChannel";
export type {
  RoomChannel,
  RoomChannelActions,
  RoomChannelMember,
  RoomChannelSenders,
  RoomChannelState,
  RoomSessionInfo,
  RoomToast,
} from "./roomChannel";
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
  encodeReady,
  encodeRoomMessage,
  encodeSetTracks,
  encodeState,
  encodeSync,
  encodeSyncRequest,
  encodeTrackMode,
  parseRoomMessage,
  serverMessageToAction,
} from "./roomMessages";
export type {
  ClientRoomMessage,
  ServerRoomMessage,
} from "./roomMessages";
export {
  createInitialRoomState,
  isRoomStarted,
  roomReducer,
} from "./roomReducer";
export type {
  RoomAction,
  RoomMember,
  RoomPlaybackAction,
  RoomPresence,
  RoomState,
  RoomStatus,
  RoomSyncTarget,
  RoomTrackMode,
  RoomTracks,
} from "./roomReducer";
export { useRoomDetail } from "./useRoomDetail";
export type { RoomDetailState, RoomDetailStatus } from "./useRoomDetail";
export { useRoomSocket } from "./useRoomSocket";
export type { UseRoomSocketOptions, UseRoomSocketResult } from "./useRoomSocket";

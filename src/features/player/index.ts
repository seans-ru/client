/**
 * Player feature barrel (M7). Pure helpers live in `playerHelpers` (unit-tested).
 */

export { PlayerSurface } from "./PlayerSurface";
export { PlayerControls } from "./PlayerControls";
export {
  applySeekDelta,
  clampSeek,
  clampSpeed,
  formatHwdec,
  formatTime,
  formatTrackId,
  formatTrackLabel,
  MAX_SPEED,
  MIN_SPEED,
  OVERLAY_IDLE_MS,
  parseTrackId,
  positionPercent,
  ratioToPosition,
  SEEK_STEP_SEC,
  SPEED_OPTIONS,
} from "./playerHelpers";
export {
  DEFAULT_SNAPSHOT,
  normalizeSnapshot,
  PLAYER_STATE_EVENT,
} from "./playerTypes";
export type { PlayerPhase, PlayerSnapshot, PlayerTrack } from "./playerTypes";
export {
  openPlayerUrl,
  playerDestroy,
  playerGetState,
  playerListTracks,
  playerPause,
  playerPlay,
  playerSeek,
  playerSetAudioTrack,
  playerSetFullscreen,
  playerSetMute,
  playerSetSpeed,
  playerSetSubtitleTrack,
  playerSetVolume,
  playerSyncSize,
  playerToggleFullscreen,
  playerTogglePause,
} from "./playerApi";
export type { OpenPlayerOptions } from "./playerApi";
export {
  consumeStartAt,
  openPlayer,
  PLAYER_START_AT_KEY,
} from "./playerNav";
export type { OpenPlayerNavOptions } from "./playerNav";
export { usePlayer } from "./usePlayer";
export type { UsePlayerState } from "./usePlayer";
export { usePlayback, PLAYBACK_POLL_MS } from "./usePlayback";
export type { UsePlaybackState, PlaybackAudioOption } from "./usePlayback";
export {
  BUFFER_WAITING_LABEL,
  checkSeek,
  formatProgressLabels,
  formatSeekableUntil,
  resolveDownloadProgress,
  resolvePlaybackMode,
  resolveSeekLimit,
  SEEK_BLOCKED_TOAST,
  seekLimitFromPlayback,
  shouldAutoResumeAfterGrowth,
  shouldPauseAtSeekEdge,
} from "./progressiveHelpers";
export type {
  DownloadProgress,
  PlaybackMode,
  SeekDecision,
  SeekLimit,
} from "./progressiveHelpers";
export {
  formatPlaybackAudioLabel,
  resolvePreferredAudioTrack,
} from "./audioTrackHelpers";
export {
  formatEpisodeCode,
  formatEpisodePickerLabel,
  isEpisodePlayable,
} from "./episodeHelpers";
export {
  playerSetMaxSeekable,
  progressiveStart,
  progressiveStop,
  progressiveUpdate,
} from "./progressiveApi";

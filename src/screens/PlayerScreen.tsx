import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PlaybackEpisode } from "../api/playback";
import {
  PlayerSurface,
  usePlayer,
} from "../features/player";
import { useDiscordRpc } from "../features/discord";
import type { DiscordRoomInfo } from "../features/discord";
import { usePlayback } from "../features/player/usePlayback";
import {
  findLibraryFileForEpisode,
  useMediaLookup,
} from "../features/player/useMediaLookup";
import { usePlayerOpener } from "../features/player/usePlayerOpener";
import { useProgressiveGuard } from "../features/player/useProgressiveGuard";
import { useGuardedTransport } from "../features/player/useGuardedTransport";
import { usePlayerExtensions } from "../features/player/usePlayerExtensions";
import { PlayerSlotsProvider } from "../features/player/extensions/slots";
import type { ExtensionRuntime } from "../features/player/extensions/registry";
import type {
  RoomTransport,
  RoomTransportAction,
} from "../features/player/useGuardedTransport";
import { useTheIntroDb } from "../features/theintrodb";
import "../features/player/player.css";

export type { RoomTransport, RoomTransportAction };

/**
 * Player screen (M7 + M8 + M9 + progressive). Full-bleed via
 * `isFullBleedRoute` (no left nav).
 *
 * Flow:
 * 1. Resolve media id for `fileId`, then `GET /api/media/{id}/playback`.
 * 2. `stream.complete` → VOD (`fetchFileUrl` + libmpv).
 *    `stream.ready && !complete` → progressive (local range source).
 * 3. Seek is limited to `max_seekable_bytes` (UI + Rust transport clamp).
 * 4. Dual progress + grey zone from the playback poll (5–7 s).
 * 5. Audio tracks from `audio_tracks[]` (flags → Russian labels), preference
 *    saved per media/episode.
 * 6. Series: episode picker; Play hidden when `has_primary_video` is false.
 * 7. Resume (M9) + history progress; room mode skips both (host sync owns it).
 */
export function PlayerScreen({
  fileId,
  startAt,
  roomMode = false,
  onTransport,
  transportRef,
  sidecarExtra,
  room,
}: {
  fileId: string;
  startAt?: number | null;
  /** Room playback (M10): skip history resume + progress tracking. */
  roomMode?: boolean;
  /** Room (M10): local play/pause/seek — host broadcasts these over WS. */
  onTransport?: (action: RoomTransportAction, position: number) => void;
  /** Room (M10): player transport for heartbeats and guest remote apply. */
  transportRef?: { current: RoomTransport | null };
  /** Extra sidecar content (room members / actions). */
  sidecarExtra?: ReactNode;
  /** Discord RPC: room party (code + member count) for the Join button. */
  room?: DiscordRoomInfo | null;
}) {
  const player = usePlayer();
  const intro = useTheIntroDb(fileId);
  const { mediaId, episodeCtx, status: mediaResolve, setEpisodeCtx } =
    useMediaLookup(fileId, intro.context);

  const playbackState = usePlayback(mediaId, fileId, {
    enabled: !roomMode,
    season: episodeCtx.season,
    episode: episodeCtx.episode,
  });
  const {
    mode,
    limit,
    progress,
    playback,
    audioOptions,
    selectedAudio,
    selectedAudioId,
    seasonGroups,
    canPlay,
    selectAudio,
  } = playbackState;

  // Discord Rich Presence: Listening activity with progress + poster; in room
  // mode also a party and the «Присоединиться» button.
  useDiscordRpc({
    mediaId,
    title: playback?.title ?? null,
    season: playback?.season ?? episodeCtx.season,
    episode: playback?.episode ?? episodeCtx.episode,
    positionSec: player.snapshot.position,
    durationSec: player.snapshot.duration,
    paused: player.snapshot.pause,
    active: player.snapshot.file_loaded,
    room: room ?? null,
  });

  // Populated below once the guarded transport exists (see onOpened).
  const extRuntimeRef = useRef<ExtensionRuntime | null>(null);

  const {
    openedMode,
    retryOpen,
    resetForEpisodeSwitch,
    openedAsProgressiveRef,
  } = usePlayerOpener({
    player,
    fileId,
    startAt,
    roomMode,
    mediaId,
    mediaResolve,
    playback,
    playbackStatus: playbackState.status,
    canPlay,
    mode,
    limit,
    // Extension runtime lives below (needs the guarded transport) — the
    // opener only fires async, so the ref is populated by then.
    onOpened: (info) => {
      extRuntimeRef.current?.notifyOpen(info);
    },
  });

  // What the player actually runs as (overrides a stale stream snapshot).
  const effectiveMode = openedMode ?? mode;

  const { waitingAtEdge } = useProgressiveGuard({
    player,
    roomMode,
    effectiveMode,
    limit,
    playback,
    openedAsProgressiveRef,
  });

  const [blockedToastToken, setBlockedToastToken] = useState(0);
  const onBlockedSeek = useCallback(() => {
    setBlockedToastToken((t) => t + 1);
  }, []);

  const playerWithHistory = useGuardedTransport(player, {
    taskFileId: fileId,
    historyEnabled: !roomMode,
    onTransport,
    transportRef,
    getSeekLimit: () => ({ mode: effectiveMode, limit }),
    onBlockedSeek,
  });

  // Extension runtime (spec: player-extensibility §S2.2/§S2.3) — one session,
  // disposed on unmount; slots render via PlayerSlotsProvider below.
  const extRuntime = usePlayerExtensions({
    transport: playerWithHistory,
    snapshot: player.snapshot,
  });
  extRuntimeRef.current = extRuntime;

  // File switch closes the previous file for extensions (session end is
  // handled inside usePlayerExtensions, before dispose).
  useEffect(() => {
    return () => {
      extRuntimeRef.current?.notifyClose();
    };
  }, [fileId]);

  const playerRef = useRef(player);
  playerRef.current = player;

  /** Apply the preferred / selected playback audio track to mpv. */
  const applyAudioTrack = useCallback(
    (trackId?: string | number | null) => {
      const options = playbackState.audioOptions;
      if (!options || options.length === 0) return;
      const key = trackId == null ? null : String(trackId);
      const option =
        options.find((o) => String(o.track.id) === key) ??
        options.find((o) => String(o.track.id) === selectedAudioId) ??
        options[0];
      if (!option) return;
      const track = option.track;
      if (track.embedded !== false) {
        const index = track.track_index;
        void playerRef.current.setAudioTrack(
          typeof index === "number" && index > 0 ? index : 0,
        );
      }
      // External (ac3/m4a) tracks are attached at open time via audio-files.
    },
    [playbackState.audioOptions, selectedAudioId],
  );

  // Apply selected audio when it changes (and after tracks appear).
  useEffect(() => {
    if (effectiveMode === "waiting") return;
    applyAudioTrack(selectedAudioId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAudioId, player.snapshot.tracks.length, effectiveMode]);

  const handleSelectEpisode = useCallback(
    (episode: PlaybackEpisode) => {
      if (!episode.has_primary_video) return;
      resetForEpisodeSwitch();
      void (async () => {
        // Picker may be built from GET /api/media/{id}/episodes (episode_id,
        // not task_file_id). Resolve the library file for S/E and open it.
        const file =
          mediaId != null
            ? await findLibraryFileForEpisode(
                mediaId,
                episode.season,
                episode.episode,
              ).catch(() => null)
            : null;
        const target = file ?? (episode.id != null ? String(episode.id) : null);
        if (target && target !== fileId) {
          window.location.hash = `#/player/${target}`;
          return;
        }
        // Same file: switch the playback query and reload.
        setEpisodeCtx({ season: episode.season, episode: episode.episode });
        retryOpen();
      })();
    },
    [mediaId, fileId, resetForEpisodeSwitch, retryOpen],
  );

  return (
    <section className="app-fullbleed player-screen">
      <PlayerSlotsProvider runtime={extRuntime}>
        <PlayerSurface
        player={{
          ...playerWithHistory,
          retry: () => {
            playbackState.reload();
            retryOpen();
          },
        }}
        segments={intro.segments}
        mediaId={intro.context?.mediaId ?? mediaId}
        alreadyReviewed={Boolean(intro.context?.alreadyReviewed)}
        mode={effectiveMode}
        progress={progress}
        limit={limit}
        blockedToastToken={blockedToastToken}
        onBlockedSeek={onBlockedSeek}
        audioOptions={audioOptions}
        selectedAudioId={selectedAudio?.id != null ? String(selectedAudio.id) : selectedAudioId}
        onSelectAudio={(trackId) => {
          selectAudio(trackId);
          applyAudioTrack(trackId);
        }}
        seasonGroups={
          seasonGroups.length > 0 ? seasonGroups : undefined
        }
        currentFileId={fileId}
        onSelectEpisode={handleSelectEpisode}
        waitingAtEdge={waitingAtEdge}
        sidecarExtra={sidecarExtra}
        />
      </PlayerSlotsProvider>
    </section>
  );
}

export { openPlayer as openPlayerRoute } from "../features/player";

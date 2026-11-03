/**
 * Guarded transport: wraps the raw player with the progressive seek clamp
 * (blocked toast), history flush on seek, room broadcast (except personal
 * seeks), plus the room socket transport (`RoomTransport`) and throttled
 * history tracking on every snapshot tick.
 */

import { useEffect, useMemo, useRef } from "react";
import { useHistoryProgress } from "../history";
import type { PlaybackMode, SeekLimit } from "./progressiveHelpers";
import type { UsePlayerState } from "./usePlayer";

/** Local transport action names shared with the room WS `state` frames. */
export type RoomTransportAction = "play" | "pause" | "seek";

/** Player access surface used by the room socket (heartbeats + guest apply). */
export type RoomTransport = {
  /** Current playback position in seconds. */
  getPosition: () => number;
  /** Apply a remote room command (guest). */
  apply: (
    action: RoomTransportAction,
    position: number,
    isPlaying?: boolean,
  ) => Promise<void>;
};

export type UseGuardedTransportOptions = {
  /** History row id (task file). */
  taskFileId: string;
  /** History tracking (M10 room mode skips it). */
  historyEnabled: boolean;
  /** Room (M10): local play/pause/seek — host broadcasts these over WS. */
  onTransport?: (action: RoomTransportAction, position: number) => void;
  /** Room (M10): player transport for heartbeats and guest remote apply. */
  transportRef?: { current: RoomTransport | null };
  /** Current seek decision inputs (progressive clamp). */
  getSeekLimit: () => { mode: PlaybackMode; limit: SeekLimit };
  /** Bump the grey-zone blocked toast (screen state). */
  onBlockedSeek: () => void;
};

export function useGuardedTransport(
  player: UsePlayerState,
  {
    taskFileId,
    historyEnabled,
    onTransport,
    transportRef,
    getSeekLimit,
    onBlockedSeek,
  }: UseGuardedTransportOptions,
): UsePlayerState {
  const historyProgress = useHistoryProgress({
    taskFileId,
    enabled: historyEnabled,
  });

  // Force-save after a user seek (throttle would otherwise wait out the 15 s).
  const progressRef = useRef(historyProgress);
  progressRef.current = historyProgress;

  // Room (M10): report local transport and expose apply/getPosition.
  const onTransportRef = useRef(onTransport);
  onTransportRef.current = onTransport;
  const onBlockedSeekRef = useRef(onBlockedSeek);
  onBlockedSeekRef.current = onBlockedSeek;
  const getSeekLimitRef = useRef(getSeekLimit);
  getSeekLimitRef.current = getSeekLimit;
  const snapshotRef = useRef(player.snapshot);
  snapshotRef.current = player.snapshot;
  const playerRef = useRef(player);
  playerRef.current = player;

  useEffect(() => {
    if (!transportRef) return;
    const transport: RoomTransport = {
      getPosition: () => snapshotRef.current.position,
      apply: async (action, position, isPlaying) => {
        const p = playerRef.current;
        const snap = snapshotRef.current;
        // Always seek on explicit seek; otherwise only when we are out of range
        // so gentle play/pause frames do not cause visible jumps.
        const needsSeek =
          action === "seek" || Math.abs(snap.position - position) > 1.5;
        if (needsSeek) {
          await p.seek(position);
        }
        const playRequested =
          action === "play" || (action !== "pause" && isPlaying === true);
        const pauseRequested =
          action === "pause" || (action !== "play" && isPlaying === false);
        if (playRequested) await p.play();
        else if (pauseRequested) await p.pause();
      },
    };
    transportRef.current = transport;
    return () => {
      if (transportRef.current === transport) transportRef.current = null;
    };
  }, [transportRef]);

  const playerWithHistory = useMemo<UsePlayerState>(() => {
    return {
      ...player,
      play: async () => {
        await player.play();
        onTransportRef.current?.("play", snapshotRef.current.position);
      },
      pause: async () => {
        await player.pause();
        onTransportRef.current?.("pause", snapshotRef.current.position);
      },
      togglePause: async () => {
        const wasPaused = player.snapshot.pause;
        await player.togglePause();
        onTransportRef.current?.(
          wasPaused ? "play" : "pause",
          snapshotRef.current.position,
        );
      },
      seek: async (seconds: number, opts?: { personal?: boolean }) => {
        const decision = getSeekLimitRef.current();
        const decisionLimit = decision.limit;
        const modeNow = decision.mode;
        // Transport guard: never send a seek past max_seekable_bytes.
        if (modeNow === "progressive" && decisionLimit.maxSeekableSec != null) {
          if (seconds > decisionLimit.maxSeekableSec + 1e-6) {
            onBlockedSeekRef.current();
            return;
          }
        }
        await player.seek(seconds);
        progressRef.current.flush({
          positionSec: seconds,
          durationSec: player.snapshot.duration,
          paused: player.snapshot.pause,
        });
        // Personal skips (intro/recap) stay local — room protocol forbids
        // broadcasting them; host scrubs still send a normal `state`.
        if (!opts?.personal) {
          onTransportRef.current?.("seek", seconds);
        }
      },
    };
  }, [player]);

  // Throttled progress on every snapshot tick.
  const { position, duration, pause } = player.snapshot;
  useEffect(() => {
    historyProgress.track({
      positionSec: position,
      durationSec: duration,
      paused: pause,
    });
    // `track` is stable; snapshot fields drive the ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, duration, pause]);

  return playerWithHistory;
}

/**
 * Progressive playback guards: Rust seek ceiling sync, pause at the
 * contiguous-prefix edge (auto-resume when the prefix grows), and keeping the
 * progressive source in sync with each playback poll.
 */

import { useEffect, useRef, useState } from "react";
import type { PlaybackResponse } from "../../api/playback";
import {
  playerSetMaxSeekable,
  progressiveUpdate,
} from "./progressiveApi";
import {
  shouldAutoResumeAfterGrowth,
  shouldPauseAtSeekEdge,
} from "./progressiveHelpers";
import type { PlaybackMode, SeekLimit } from "./progressiveHelpers";
import type { UsePlayerState } from "./usePlayer";

export type UseProgressiveGuardOptions = {
  player: UsePlayerState;
  /** Room mode (M10): progressive guards are off. */
  roomMode: boolean;
  /** Effective mode (what the player actually runs as). */
  effectiveMode: PlaybackMode;
  limit: SeekLimit;
  playback: PlaybackResponse | null;
  /** True while the progressive range source is active (owned by the opener). */
  openedAsProgressiveRef: { current: boolean };
};

export function useProgressiveGuard({
  player,
  roomMode,
  effectiveMode,
  limit,
  playback,
  openedAsProgressiveRef,
}: UseProgressiveGuardOptions): { waitingAtEdge: boolean } {
  const [waitingAtEdge, setWaitingAtEdge] = useState(false);
  const waitingAtEdgeRef = useRef(false);
  const prevLimitRef = useRef<SeekLimit | null>(null);

  // Push seek ceiling to the Rust transport whenever it changes.
  useEffect(() => {
    if (roomMode) return;
    void playerSetMaxSeekable(
      effectiveMode === "vod" ? null : (limit.maxSeekableSec ?? null),
    ).catch(() => {});
  }, [effectiveMode, limit.maxSeekableSec, roomMode]);

  // Pause at the contiguous-prefix edge; auto-resume when the prefix grows.
  // Never scrolls the user backwards on its own.
  useEffect(() => {
    if (roomMode || effectiveMode !== "progressive") {
      setWaitingAtEdge(false);
      waitingAtEdgeRef.current = false;
      return;
    }
    const { position, pause, duration } = player.snapshot;
    const atEdge = shouldPauseAtSeekEdge(position, limit, effectiveMode);
    if (atEdge && !pause && duration > 0) {
      void player.pause();
      setWaitingAtEdge(true);
      waitingAtEdgeRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.snapshot.position, player.snapshot.pause, effectiveMode, limit, roomMode]);

  useEffect(() => {
    if (roomMode) return;
    const grew = shouldAutoResumeAfterGrowth(prevLimitRef.current, limit, {
      mode: effectiveMode,
      waitingAtEdge: waitingAtEdgeRef.current,
    });
    prevLimitRef.current = limit;
    if (grew && waitingAtEdgeRef.current) {
      void player.play();
      setWaitingAtEdge(false);
      waitingAtEdgeRef.current = false;
    }
  }, [limit, effectiveMode, player, roomMode]);

  // Keep the progressive source prefix in sync with each playback poll.
  useEffect(() => {
    if (roomMode || !openedAsProgressiveRef.current || !playback?.stream) return;
    void progressiveUpdate({
      maxSeekableBytes: playback.stream.max_seekable_bytes,
      segments: playback.stream.segments,
      sizeBytes: playback.stream.size_bytes || playback.video.size_bytes,
    }).catch(() => {});
    void playerSetMaxSeekable(limit.maxSeekableSec ?? null).catch(() => {});
    // `openedAsProgressiveRef` is a stable ref from the opener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomMode, playback, limit.maxSeekableSec]);

  return { waitingAtEdge };
}

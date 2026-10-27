/**
 * Player session hook (M7): open a presigned URL, mirror Rust snapshot events,
 * expose transport controls. Destroyed on unmount.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
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
  playerTogglePause,
} from "./playerApi";
import {
  DEFAULT_SNAPSHOT,
  normalizeSnapshot,
  PLAYER_STATE_EVENT,
} from "./playerTypes";
import type { PlayerPhase, PlayerSnapshot } from "./playerTypes";

export type UsePlayerState = {
  phase: PlayerPhase;
  snapshot: PlayerSnapshot;
  error: string | null;
  /** Status copy for the waiting phase (file/segments not ready yet). */
  waitMessage: string | null;
  /** Fetch + open a presigned URL (call after `fetchFileUrl`). */
  start: (
    url: string,
    options?: {
      startAt?: number | null;
      externalAudioUrls?: string[];
      maxSeekableSec?: number | null;
    },
  ) => Promise<void>;
  /** Force the error phase (API failure before `start`). */
  fail: (message: string) => void;
  /** Waiting phase: keep polling/retrying, show status instead of an error. */
  wait: (message: string) => void;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  togglePause: () => Promise<void>;
  seek: (
    seconds: number,
    opts?: { /** Personal seeks (TheIntroDB skip) must not broadcast to rooms. */
      personal?: boolean },
  ) => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  setMute: (mute: boolean) => Promise<void>;
  setAudioTrack: (id: number) => Promise<void>;
  setSubtitleTrack: (id: number | null) => Promise<void>;
  refreshTracks: () => Promise<void>;
  setFullscreen: (enabled: boolean) => Promise<void>;
  /**
   * Fit the mpv child window. Pass the DOM video-area rect (physical px) to
   * keep sidecar / control strip uncovered; omit to re-apply the last rect.
   */
  syncSize: (rect?: { x: number; y: number; width: number; height: number } | null) => Promise<void>;
  retry: () => void;
};

export function usePlayer(): UsePlayerState {
  const [phase, setPhase] = useState<PlayerPhase>("loading");
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(DEFAULT_SNAPSHOT);
  const [error, setError] = useState<string | null>(null);
  const [waitMessage, setWaitMessage] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const lastUrlRef = useRef<{
    url: string;
    startAt: number | null;
    externalAudioUrls?: string[];
    maxSeekableSec?: number | null;
  } | null>(null);

  const start = useCallback(async (
    url: string,
    options?: {
      startAt?: number | null;
      externalAudioUrls?: string[];
      maxSeekableSec?: number | null;
    },
  ) => {
    lastUrlRef.current = {
      url,
      startAt: options?.startAt ?? null,
      externalAudioUrls: options?.externalAudioUrls,
      maxSeekableSec: options?.maxSeekableSec,
    };
    setPhase("loading");
    setError(null);
    setWaitMessage(null);
    setSnapshot(DEFAULT_SNAPSHOT);
    try {
      await openPlayerUrl(url, {
        startAt: options?.startAt ?? null,
        externalAudioUrls: options?.externalAudioUrls ?? [],
        maxSeekableSec: options?.maxSeekableSec ?? null,
      });
      // Re-fit the mpv child HWND now that the player surface is mounted.
      void playerSyncSize(null).catch(() => {});
      // Pull the post-open snapshot (covers errors emitted before listen attaches).
      const state = await playerGetState().catch(() => null);
      if (state) {
        const next = normalizeSnapshot(state);
        setSnapshot(next);
        if (next.error) {
          setError(next.error);
          setPhase("error");
          return;
        }
      }
      // A fast error event may already have flipped the phase; only clear loading.
      setPhase((current) => (current === "loading" ? "ready" : current));
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message
          ? cause.message
          : "Не удалось открыть файл";
      setError(message);
      setPhase("error");
    }
  }, []);

  const retry = useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  const fail = useCallback((message: string) => {
    setError(message);
    setWaitMessage(null);
    setPhase("error");
  }, []);

  const wait = useCallback((message: string) => {
    setError(null);
    setWaitMessage(message);
    setPhase("waiting");
  }, []);

  // Snapshot stream + reopen on retry.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      try {
        unlisten = await listen<PlayerSnapshot>(PLAYER_STATE_EVENT, (event) => {
          if (cancelled) return;
          const next = normalizeSnapshot(event.payload);
          setSnapshot(next);
          if (next.error) {
            setError(next.error);
            setPhase("error");
          } else if (next.file_loaded) {
            setError(null);
            setPhase("ready");
          }
        });
      } catch {
        // Running outside Tauri (plain vite) — no event stream.
      }
      if (cancelled) unlisten?.();
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Retry re-opens the last URL (if any).
  useEffect(() => {
    if (retryToken === 0) return;
    const last = lastUrlRef.current;
    if (last) {
      void start(last.url, {
        startAt: last.startAt,
        externalAudioUrls: last.externalAudioUrls,
        maxSeekableSec: last.maxSeekableSec,
      });
    }
  }, [retryToken, start]);

  // Destroy the Rust session on unmount (route leave / window close).
  useEffect(() => {
    return () => {
      void playerDestroy().catch(() => {
        // Ignore — session may already be gone.
      });
    };
  }, []);

  const wrap = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message
          ? cause.message
          : "Не удалось открыть файл";
      setError(message);
      setPhase("error");
    }
  }, []);

  const play = useCallback(() => wrap(playerPlay), [wrap]);
  const pause = useCallback(() => wrap(playerPause), [wrap]);
  const togglePause = useCallback(() => wrap(playerTogglePause), [wrap]);
  const seek = useCallback((seconds: number) => wrap(() => playerSeek(seconds)), [wrap]);
  const setSpeed = useCallback((speed: number) => wrap(() => playerSetSpeed(speed)), [wrap]);
  const setVolume = useCallback(
    (volume: number) => wrap(() => playerSetVolume(volume)),
    [wrap],
  );
  const setMute = useCallback((mute: boolean) => wrap(() => playerSetMute(mute)), [wrap]);
  const setAudioTrack = useCallback(
    (id: number) => wrap(() => playerSetAudioTrack(id)),
    [wrap],
  );
  const setSubtitleTrack = useCallback(
    (id: number | null) => wrap(() => playerSetSubtitleTrack(id)),
    [wrap],
  );
  const setFullscreen = useCallback(
    (enabled: boolean) => wrap(() => playerSetFullscreen(enabled)),
    [wrap],
  );
  const syncSize = useCallback(
    async (rect?: { x: number; y: number; width: number; height: number } | null) => {
      try {
        await playerSyncSize(rect ?? null);
      } catch {
        // Non-fatal: the host keeps its previous size until the next layout pass.
      }
    },
    [],
  );

  const refreshTracks = useCallback(async () => {
    try {
      const tracks = await playerListTracks();
      setSnapshot((prev) => ({ ...prev, tracks }));
    } catch {
      // Non-fatal: track menu just stays as-is.
    }
  }, []);

  return {
    phase,
    snapshot,
    error,
    waitMessage,
    start,
    fail,
    wait,
    play,
    pause,
    togglePause,
    seek,
    setSpeed,
    setVolume,
    setMute,
    setAudioTrack,
    setSubtitleTrack,
    refreshTracks,
    setFullscreen,
    syncSize,
    retry,
  };
}

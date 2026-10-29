/**
 * Push the current playback into Discord Rich Presence.
 *
 * Timestamps are absolute (`start = now - position`), so the elapsed bar ticks
 * on Discord's side — updates fire only on significant changes (file/episode,
 * play/pause, poster, room/party, plan) plus a 30 s drift-correction refresh.
 * Clears the activity when nothing is loaded or the player unmounts.
 */

import { useEffect, useRef, useState } from "react";
import { fetchMedia } from "../../api/endpoints";
import type { ApiId } from "../../api/types";
import { useAuth } from "../auth";
import { buildDiscordActivity } from "./discordActivity";
import { clearDiscordActivity, setDiscordActivity } from "./discordApi";

export type DiscordRoomInfo = {
  /** Room code — becomes `party.id`. */
  code: string;
  /** Current member count — becomes `party.size`. */
  members: number;
};

export type UseDiscordRpcInput = {
  mediaId: ApiId | null;
  title: string | null;
  season: number | null;
  episode: number | null;
  positionSec: number;
  durationSec: number;
  paused: boolean;
  /** False until a file is loaded — no activity while the player is idle. */
  active: boolean;
  /** Present while watching together — enables party + Join button. */
  room?: DiscordRoomInfo | null;
};

/** Drift-correction refresh; significant changes push immediately. */
const REFRESH_MS = 30_000;

export function useDiscordRpc(input: UseDiscordRpcInput): void {
  const { user } = useAuth();
  const inputRef = useRef(input);
  inputRef.current = input;
  const userRef = useRef(user);
  userRef.current = user;

  const mediaKey = input.mediaId == null ? "" : String(input.mediaId);
  // Media detail fallback: playback.title is absent in room mode (usePlayback
  // is disabled there), so title + poster come from GET /api/media/{id}.
  const [mediaInfo, setMediaInfo] = useState<{
    title: string | null;
    posterUrl: string | null;
  }>({ title: null, posterUrl: null });
  const mediaInfoRef = useRef(mediaInfo);
  mediaInfoRef.current = mediaInfo;

  useEffect(() => {
    if (!mediaKey) {
      setMediaInfo({ title: null, posterUrl: null });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    void fetchMedia(mediaKey, controller.signal).then(
      (detail) => {
        if (!cancelled) {
          setMediaInfo({
            title: detail.title || null,
            posterUrl: detail.poster_url ?? null,
          });
        }
      },
      () => {
        /* media unavailable — activity stays poster-less */
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [mediaKey]);

  const { active, paused, season, episode, durationSec, title } = input;
  const roomCode = input.room?.code ?? null;
  const roomMembers = input.room?.members ?? 0;
  const userId = user?.id;
  const plan = user?.plan;

  useEffect(() => {
    if (!active) return;

    const push = () => {
      const current = inputRef.current;
      const me = userRef.current;
      const media = mediaInfoRef.current;
      void setDiscordActivity(
        buildDiscordActivity({
          title: current.title ?? media.title,
          season: current.season,
          episode: current.episode,
          positionSec: current.positionSec,
          durationSec: current.durationSec,
          paused: current.paused,
          posterUrl: media.posterUrl,
          room: current.room ?? null,
          inviterUserId: me?.id == null ? "" : String(me.id),
          plan: me?.plan,
          nowMs: Date.now(),
        }),
      );
    };

    push();
    const timer = window.setInterval(push, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [
    active,
    paused,
    season,
    episode,
    durationSec,
    title,
    mediaInfo.title,
    mediaInfo.posterUrl,
    roomCode,
    roomMembers,
    userId,
    plan,
  ]);

  // Idle player → no activity.
  useEffect(() => {
    if (!active) void clearDiscordActivity();
  }, [active]);

  // Player screen unmount → no activity.
  useEffect(() => () => void clearDiscordActivity(), []);
}

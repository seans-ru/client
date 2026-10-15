/**
 * Thin invoke wrappers over the Rust `player` commands (M7).
 * Local-only: media URLs come from `fetchFileUrl` (presigned); no DLL fetch here.
 */

import { invoke } from "@tauri-apps/api/core";
import type { PlayerSnapshot, PlayerTrack } from "./playerTypes";

export type OpenPlayerOptions = {
  /** Resume position in seconds (M9 history hook). */
  startAt?: number | null;
  /** Optional HWND override; omit to use the main window child host. */
  hwndHint?: number | null;
  /** External audio files for non-embedded tracks (ac3/m4a). */
  externalAudioUrls?: string[];
  /** Progressive seek ceiling in seconds; `null` = unrestricted VOD. */
  maxSeekableSec?: number | null;
};

/**
 * Start playback of a presigned media URL (or progressive local source) in
 * the embedded libmpv surface.
 * (Not the navigation hook — see `openPlayer(fileId, { startAt })` in
 * `playerNav` for route entry with a resume position.)
 */
export async function openPlayerUrl(
  url: string,
  options: OpenPlayerOptions = {},
): Promise<void> {
  await invoke("player_open", {
    url,
    startAt: options.startAt ?? null,
    hwndHint: options.hwndHint ?? null,
    externalAudioUrls: options.externalAudioUrls ?? [],
    maxSeekableSec: options.maxSeekableSec ?? null,
  });
}

export async function playerPlay(): Promise<void> {
  await invoke("player_play");
}

export async function playerPause(): Promise<void> {
  await invoke("player_pause");
}

export async function playerTogglePause(): Promise<void> {
  await invoke("player_toggle_pause");
}

/** Absolute seek to `seconds` (Rust clamps to duration). */
export async function playerSeek(seconds: number): Promise<void> {
  await invoke("player_seek", { seconds });
}

/** Playback speed, clamped 0.25–2.0 on the Rust side as well. */
export async function playerSetSpeed(speed: number): Promise<void> {
  await invoke("player_set_speed", { speed });
}

export async function playerSetVolume(volume: number): Promise<void> {
  await invoke("player_set_volume", { volume });
}

export async function playerSetMute(mute: boolean): Promise<void> {
  await invoke("player_set_mute", { mute });
}

/** Audio track id; `<= 0` disables audio. */
export async function playerSetAudioTrack(id: number): Promise<void> {
  await invoke("player_set_audio_track", { id });
}

/** Subtitle track id; `null` / `<= 0` turns subtitles off. */
export async function playerSetSubtitleTrack(id: number | null): Promise<void> {
  await invoke("player_set_subtitle_track", { id });
}

export async function playerListTracks(): Promise<PlayerTrack[]> {
  return invoke<PlayerTrack[]>("player_list_tracks");
}

export async function playerSetFullscreen(enabled: boolean): Promise<void> {
  await invoke("player_set_fullscreen", { enabled });
}

export async function playerToggleFullscreen(): Promise<void> {
  await invoke("player_toggle_fullscreen");
}

export async function playerGetState(): Promise<PlayerSnapshot> {
  return invoke<PlayerSnapshot>("player_get_state");
}

/** Release libmpv + host window (route leave / window close). */
export async function playerDestroy(): Promise<void> {
  await invoke("player_destroy");
}

/** Re-fit the video child window after a Tauri window resize. */
export async function playerSyncSize(): Promise<void> {
  await invoke("player_sync_size");
}

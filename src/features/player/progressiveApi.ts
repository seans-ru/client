/**
 * Thin invoke wrappers for the progressive playback source (Rust loopback
 * range server) and the player seek ceiling.
 */

import { invoke } from "@tauri-apps/api/core";
import type { PlaybackSegment } from "../../api/playback";

export type ProgressiveStartArgs = {
  sizeBytes: number;
  maxSeekableBytes: number;
  segments: PlaybackSegment[];
};

/**
 * Start (or replace) the local range server for a still-downloading file.
 * Returns `http://127.0.0.1:<port>/` — pass this to `player_open`.
 */
export async function progressiveStart(
  args: ProgressiveStartArgs,
): Promise<string> {
  return invoke<string>("progressive_start", {
    sizeBytes: Math.max(0, Math.trunc(args.sizeBytes)),
    maxSeekableBytes: Math.max(0, Math.trunc(args.maxSeekableBytes)),
    segments: args.segments.map((s) => ({
      index: s.index,
      start: s.start,
      end: s.end,
      url: s.url,
      available: s.available,
    })),
  });
}

/**
 * Push a new contiguous prefix after a playback/index poll.
 * Seeks past this ceiling stay blocked until the next update.
 */
export async function progressiveUpdate(args: {
  maxSeekableBytes: number;
  segments?: PlaybackSegment[];
  sizeBytes?: number;
}): Promise<void> {
  await invoke("progressive_update", {
    maxSeekableBytes: Math.max(0, Math.trunc(args.maxSeekableBytes)),
    segments: args.segments?.map((s) => ({
      index: s.index,
      start: s.start,
      end: s.end,
      url: s.url,
      available: s.available,
    })),
    sizeBytes:
      args.sizeBytes == null ? null : Math.max(0, Math.trunc(args.sizeBytes)),
  });
}

/** Stop the progressive source (route leave / complete → VOD). */
export async function progressiveStop(): Promise<void> {
  await invoke("progressive_stop");
}

/** Current seekable ceiling in bytes (diagnostics). */
export async function progressiveMaxSeekable(): Promise<number> {
  return invoke<number>("progressive_max_seekable");
}

/**
 * Transport-level seek ceiling in seconds. `null` clears it (full VOD range).
 * The Rust `player_seek` clamps to this so a late UI event cannot jump ahead
 * of `max_seekable_bytes`.
 */
export async function playerSetMaxSeekable(
  seconds: number | null,
): Promise<void> {
  await invoke("player_set_max_seekable", {
    seconds: seconds == null || !Number.isFinite(seconds) ? null : seconds,
  });
}

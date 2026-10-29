/**
 * Thin invoke wrappers over the Rust `discord` commands + join events.
 * Best-effort: Discord not running must never break playback or navigation.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DiscordActivityInput } from "./discordActivity";

/** Rust → JS event: a friend clicked Join (`JoinEventPayload`). */
export const DISCORD_JOIN_EVENT = "discord://join";

export async function setDiscordActivity(
  input: DiscordActivityInput,
): Promise<void> {
  try {
    await invoke("discord_set_activity", { input });
  } catch {
    // Discord IPC unavailable — swallow; the next tick will retry.
  }
}

export async function clearDiscordActivity(): Promise<void> {
  try {
    await invoke("discord_clear_activity");
  } catch {
    // best-effort
  }
}

/** Take the join secret stashed before the frontend mounted (cold launch). */
export async function takePendingJoin(): Promise<string | null> {
  try {
    return (await invoke<string | null>("discord_take_pending_join")) ?? null;
  } catch {
    return null;
  }
}

/** Subscribe to join clicks; returns an unsubscribe function. */
export function onDiscordJoin(
  callback: (secret: string) => void,
): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void listen<{ secret: string }>(DISCORD_JOIN_EVENT, (event) => {
    callback(event.payload.secret);
  }).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  });
  return () => {
    disposed = true;
    if (unlisten) unlisten();
  };
}

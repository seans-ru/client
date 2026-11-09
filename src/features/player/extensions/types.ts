/**
 * Player extension contract (spec: docs/compose/spec/player-extensibility.md §S2.2).
 *
 * An extension is a first-party module that contributes sound / video / UI
 * behavior to the player without touching the core. Core modules must not
 * import from `extensions/examples` — only from this contract.
 */

import type { ReactNode } from "react";
import type { PlayerSnapshot } from "../playerTypes";

export type Unsubscribe = () => void;

/** Palette command (issue #23) — see `commands.ts` for the bus. */
export type PlayerCommand = {
  /** Stable id — hotkey map keys, recent-command list. */
  id: string;
  /** Russian title shown in the palette and the hotkey table. */
  title: string;
  /** Group label in the palette («Воспроизведение», «Звук», …). */
  category?: string;
  /** Extra search terms (Russian + English aliases). */
  keywords?: string[];
  run: () => void | Promise<void>;
};

/** Chrome regions where extensions may contribute UI. */
export type PlayerUiSlot =
  | "controls.primary" // left button cluster near the seek bar
  | "controls.secondary" // right cluster (volume / settings gear side)
  | "settings.menu" // rows appended to the player settings menu
  | "overlay" // layer above the video (effects, badges)
  | "sidecar"; // sections at the end of the sidecar rail

/** Fired when a media source is opened (once per file, after `player_open`). */
export type OpenInfo = {
  url: string;
  startAt: number | null;
  source: "vod" | "progressive" | "unknown";
};

/** Stride-sampled RGB frame (`rgb.length === width * height * 3`). */
export type FrameSample = {
  width: number;
  height: number;
  pts: number;
  rgb: Uint8Array;
};

/** Raw libmpv access — any property/command without new Rust commands. */
export type MpvBridge = {
  getProperty(name: string): Promise<string>;
  setProperty(name: string, value: string | number | boolean): Promise<void>;
  command(args: string[]): Promise<string | null>;
};

/** Namespaced persistence (`seans.player.ext.<id>.<key>` in localStorage). */
export type ExtensionStorage = {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
};

/** Transport surface visible to extensions (same guarded transport as the UI). */
export type ExtensionTransport = {
  play(): Promise<void>;
  pause(): Promise<void>;
  togglePause(): Promise<void>;
  /** Personal seeks (intro skip) must not broadcast to rooms. */
  seek(seconds: number, opts?: { personal?: boolean }): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setMute(mute: boolean): Promise<void>;
  setFullscreen(enabled: boolean): Promise<void>;
};

export type PlayerExtensionContext = {
  readonly id: string;
  readonly transport: ExtensionTransport;
  getSnapshot(): PlayerSnapshot;
  onSnapshot(cb: (s: PlayerSnapshot) => void): Unsubscribe;
  onOpen(cb: (info: OpenInfo) => void): Unsubscribe;
  onClose(cb: () => void): Unsubscribe;
  readonly mpv: MpvBridge;
  readonly frames: {
    subscribe(
      cb: (s: FrameSample) => void,
      opts?: { maxFps?: number },
    ): Unsubscribe;
  };
  readonly ui: {
    /** Render contributes a self-contained React subtree to a chrome slot. */
    add(slot: PlayerUiSlot, render: () => ReactNode): Unsubscribe;
    /** Hide/show the player chrome (transport + cursor over the video).
        Visible by default; extensions restore visibility on dispose. */
    setChromeHidden(hidden: boolean): void;
  };
  readonly storage: ExtensionStorage;
  /**
   * Register a command palette / hotkey action (issue #23). The command is
   * listed in the palette and can be bound to a key in the hotkey table.
   * Commands are auto-dropped at dispose; the returned unsubscribe is for
   * early removal.
   */
  registerCommand(command: PlayerCommand): Unsubscribe;
};

export type PlayerExtension = {
  /** Stable id (storage namespace, logs). */
  id: string;
  /** Human-readable name for settings UI. */
  name: string;
  /** Runs once per player session; may return a dispose callback. */
  setup(ctx: PlayerExtensionContext): void | Unsubscribe;
};

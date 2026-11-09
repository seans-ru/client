/**
 * Live emoji reactions over the video (issue #28, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Active in room mode only (`ctx.room`): a 7-emoji panel in
 * `controls.secondary` sends `reaction {emoji}` over the room WS (rate-limited
 * 1/s), every participant sees rising bubbles in the `overlay` slot
 * (auto-hide ~2.6 s, max 12 at once, sender name on hover). Settings:
 * «Показывать реакции» (local, default on) + host-only room flag.
 * No history — nothing is restored on reconnect. Animations are transform/
 * opacity only (compositor-friendly, no per-frame JS).
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type {
  ExtensionStorage,
  PlayerExtension,
  RoomReactionEvent,
  RoomSocialPort,
  Unsubscribe,
} from "./types";
import { REACTION_EMOJIS } from "../../rooms/roomSocial";
import {
  dropBubble,
  laneLeftPercent,
  pickLane,
  pushBubble,
  REACTION_BUBBLE_TTL_MS,
  REACTION_LANES,
  type ReactionBubble,
} from "./reactionsHelpers";
import "./roomSocial.css";

const SHOW_KEY = "showReactions";

export type ReactionsSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getShow(): boolean;
  setShow(next: boolean): void;
};

export function createReactionsSettings(
  storage: ExtensionStorage,
): ReactionsSettings {
  let show = storage.get<boolean>(SHOW_KEY, true) !== false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getShow: () => show,
    setShow(next) {
      const value = Boolean(next);
      if (value === show) return;
      show = value;
      storage.set(SHOW_KEY, show);
      notify();
    },
  };
}

export type ReactionsController = {
  settings: ReactionsSettings;
  subscribe(cb: () => void): Unsubscribe;
  getBubbles(): readonly ReactionBubble[];
  /** Add a bubble (respecting the local display toggle and the room flag). */
  push(event: RoomReactionEvent): void;
  /** Send a reaction (room rate limit 1/s decides). */
  send(emoji: string): boolean;
  dispose(): void;
};

export function createReactionsController(args: {
  room: RoomSocialPort;
  storage: ExtensionStorage;
  /** Injected for tests. */
  rand?: () => number;
  /** Injected for tests (bubble TTL scheduler). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}): ReactionsController {
  const { room, storage } = args;
  const rand = args.rand ?? Math.random;
  const setTimer = args.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = args.clearTimer ?? ((handle) => clearTimeout(handle));

  const settings = createReactionsSettings(storage);
  let bubbles: ReactionBubble[] = [];
  let snapshot: readonly ReactionBubble[] = [];
  let keySeq = 0;
  const listeners = new Set<() => void>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const notify = () => {
    snapshot = bubbles;
    for (const listener of [...listeners]) listener();
  };

  const expire = (key: number) => {
    timers.delete(key);
    const next = dropBubble(bubbles, key);
    if (next !== bubbles) {
      bubbles = next;
      notify();
    }
  };

  return {
    settings,

    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    getBubbles: () => snapshot,

    push(event) {
      if (!settings.getShow()) return;
      if (!room.getReactionsEnabled()) return;
      keySeq += 1;
      const bubble: ReactionBubble = {
        key: keySeq,
        emoji: event.emoji,
        senderName: event.name,
        lane: pickLane(rand, REACTION_LANES),
      };
      bubbles = pushBubble(bubbles, bubble);
      // Oldest bubbles may have been dropped — cancel their timers lazily
      // (expire() is a no-op for an absent key).
      const handle = setTimer(() => expire(bubble.key), REACTION_BUBBLE_TTL_MS);
      timers.set(bubble.key, handle);
      notify();
    },

    send(emoji) {
      return room.sendReaction(emoji);
    },

    dispose() {
      for (const handle of timers.values()) clearTimer(handle);
      timers.clear();
      listeners.clear();
      bubbles = [];
      snapshot = [];
    },
  };
}

function ReactionsPanel({
  controller,
  room,
}: {
  controller: ReactionsController;
  room: RoomSocialPort;
}): ReactElement {
  const enabled = useSyncExternalStore(
    room.subscribe,
    room.getReactionsEnabled,
  );
  return (
    <div
      className="room-reactions-panel"
      role="group"
      aria-label="Реакции"
    >
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="room-reaction-btn"
          disabled={!enabled}
          title={
            enabled ? "Отправить реакцию" : "Реакции выключены в комнате"
          }
          onClick={() => {
            controller.send(emoji);
          }}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

function ReactionsLayer({
  controller,
}: {
  controller: ReactionsController;
}): ReactElement {
  const bubbles = useSyncExternalStore(
    controller.subscribe,
    controller.getBubbles,
  );
  return (
    <div className="room-reactions-layer" aria-hidden="true">
      {bubbles.map((bubble) => (
        <span
          key={bubble.key}
          className="room-reaction-bubble"
          style={{ left: `${laneLeftPercent(bubble.lane, REACTION_LANES)}%` }}
          title={bubble.senderName ?? undefined}
        >
          {bubble.emoji}
        </span>
      ))}
    </div>
  );
}

function ReactionsMenu({
  controller,
  room,
}: {
  controller: ReactionsController;
  room: RoomSocialPort;
}): ReactElement {
  const show = useSyncExternalStore(
    controller.settings.subscribe,
    controller.settings.getShow,
  );
  const roomEnabled = useSyncExternalStore(room.subscribe, room.getReactionsEnabled);
  const host = room.isHost();
  return (
    <section>
      <h4 className="player-menu-title">Реакции</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={show}
          className={`player-menu-item${show ? " player-menu-item-active" : ""}`}
          onClick={() => controller.settings.setShow(!show)}
        >
          {show ? "Показывать реакции: включено" : "Показывать реакции: выключено"}
        </button>
        {host ? (
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={roomEnabled}
            className={`player-menu-item${roomEnabled ? " player-menu-item-active" : ""}`}
            onClick={() => room.setReactionsEnabled(!roomEnabled)}
          >
            {roomEnabled
              ? "Реакции в комнате: включены"
              : "Реакции в комнате: выключены"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export const reactions: PlayerExtension = {
  id: "reactions",
  name: "Реакции",
  setup(ctx): Unsubscribe | void {
    const room = ctx.room;
    // Room-only feature: outside a watch party there is nothing to wire.
    if (!room) return;

    const controller = createReactionsController({
      room,
      storage: ctx.storage,
    });
    const stopReactions = room.onReaction((event) => controller.push(event));
    const stopPanel = ctx.ui.add("controls.secondary", () => (
      <ReactionsPanel controller={controller} room={room} />
    ));
    const stopLayer = ctx.ui.add("overlay", () => (
      <ReactionsLayer controller={controller} />
    ));
    const stopMenu = ctx.ui.add("settings.menu", () => (
      <ReactionsMenu controller={controller} room={room} />
    ));
    return () => {
      stopMenu();
      stopLayer();
      stopPanel();
      stopReactions();
      controller.dispose();
    };
  },
};

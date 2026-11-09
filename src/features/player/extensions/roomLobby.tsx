/**
 * Room lobby + ready-check (issue #30, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * A lobby card over the video (not a separate screen) with the participant
 * list — name/avatar, readiness «готов / не готов / подключается» — the
 * «Я готов» toggle, and host controls («Начать» / «Ждать»). The host
 * auto-starts when everyone is ready; waiting nudges after ~10 s
 * («стартовать без всех», issue #27) and ~60 s («начать без них?», issue #30).
 * Join/leave toasts live in the same overlay.
 *
 * Readiness is shared through the room channel: the manual toggle plus the
 * buffer telemetry reported by `roomSync` (phase-2 auto-ready).
 */

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import type { PlayerExtension, Unsubscribe } from "./types";
import type {
  RoomChannel,
  RoomChannelMember,
  RoomChannelState,
} from "../../rooms/roomChannel";
import { roomChannel } from "../../rooms/roomChannel";
import "./roomOverlay.css";

/** First host nudge after the lobby opens (issue #27 ready-wait). */
export const LOBBY_SOFT_HINT_MS = 10_000;
/** Stronger nudge — the lobby has been waiting a minute (issue #30). */
export const LOBBY_STRONG_HINT_MS = 60_000;
/** Auto-start needs at least one other participant. */
export const AUTO_START_MIN_OTHERS = 1;

export type LobbyHint = "none" | "soft" | "strong";

export function memberStatusText(ready: boolean | null): string {
  if (ready == null) return "Подключается";
  return ready ? "Готов" : "Не готов";
}

export function allMembersReady(
  members: ReadonlyArray<Pick<RoomChannelMember, "ready">>,
): boolean {
  return members.length > 0 && members.every((m) => m.ready === true);
}

/** Which host hint to show for the elapsed lobby wait. */
export function lobbyHint(
  elapsedMs: number,
  input: { allReady: boolean; isHost: boolean },
): LobbyHint {
  if (!input.isHost || input.allReady) return "none";
  if (elapsedMs >= LOBBY_STRONG_HINT_MS) return "strong";
  if (elapsedMs >= LOBBY_SOFT_HINT_MS) return "soft";
  return "none";
}

export function shouldAutoStart(input: {
  isHost: boolean;
  watching: boolean;
  members: ReadonlyArray<Pick<RoomChannelMember, "ready" | "isSelf">>;
}): boolean {
  if (!input.isHost || input.watching) return false;
  const others = input.members.filter((m) => !m.isSelf);
  return others.length >= AUTO_START_MIN_OTHERS && allMembersReady(input.members);
}

function initials(name: string | null, userId: string): string {
  const source = (name && name.trim()) || userId;
  return source.slice(0, 2);
}

function LobbyCard({
  state,
  onToggleReady,
  onStart,
  onWaitMore,
  hint,
  waitingCount,
}: {
  state: RoomChannelState;
  onToggleReady: () => void;
  onStart: () => void;
  onWaitMore: () => void;
  hint: LobbyHint;
  waitingCount: number;
}): ReactElement {
  const self = state.members.find((m) => m.isSelf);
  const selfReady = self ? self.ready === true : state.ready;
  return (
    <div className="room-ext-lobby" role="dialog" aria-label="Лобби комнаты">
      <header className="room-ext-lobby-header">
        <h3 className="room-ext-lobby-title">Лобби комнаты</h3>
        <span className="room-ext-lobby-code">{state.session?.code}</span>
      </header>

      <ul className="room-ext-member-list">
        {state.members.map((member) => (
          <li className="room-ext-member" key={member.userId}>
            <span className="room-ext-avatar" aria-hidden="true">
              {initials(member.name, member.userId)}
            </span>
            <span className="room-ext-member-name">
              {member.name ?? `Участник ${member.userId.slice(0, 8)}`}
              {member.isSelf ? " (вы)" : ""}
            </span>
            <span
              className={`room-ext-status${
                member.ready === true
                  ? " room-ext-status-ready"
                  : member.ready == null
                    ? " room-ext-status-off"
                    : ""
              }`}
            >
              {memberStatusText(member.ready)}
            </span>
          </li>
        ))}
      </ul>

      {hint === "soft" ? (
        <p className="room-ext-lobby-hint">
          Не все готовы — стартовать без всех?
        </p>
      ) : null}
      {hint === "strong" ? (
        <p className="room-ext-lobby-hint">Начать без них?</p>
      ) : null}
      {waitingCount > 0 && hint === "none" ? (
        <p className="player-menu-empty">
          Ждём участников… готовы {state.members.length - waitingCount} из{" "}
          {state.members.length}
        </p>
      ) : null}

      <div className="room-ext-lobby-actions">
        <button
          type="button"
          className={`room-ext-btn${selfReady ? "" : " room-ext-btn-primary"}`}
          onClick={onToggleReady}
          aria-pressed={selfReady}
        >
          {selfReady ? "Готов" : "Я готов"}
        </button>
        {state.session?.isHost ? (
          <>
            <button
              type="button"
              className="room-ext-btn room-ext-btn-primary"
              onClick={onStart}
            >
              Начать
            </button>
            <button
              type="button"
              className="room-ext-btn"
              onClick={onWaitMore}
            >
              Ждать
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ToastStack({
  state,
  onDismiss,
}: {
  state: RoomChannelState;
  onDismiss: (id: number) => void;
}): ReactElement | null {
  const timers = useRef(new Map<number, number>());
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const active = new Set(state.toasts.map((t) => t.id));
    for (const [id, handle] of timers.current) {
      if (!active.has(id)) {
        window.clearTimeout(handle);
        timers.current.delete(id);
      }
    }
    for (const toast of state.toasts) {
      if (timers.current.has(toast.id)) continue;
      const handle = window.setTimeout(() => {
        timers.current.delete(toast.id);
        dismissRef.current(toast.id);
      }, 4000);
      timers.current.set(toast.id, handle);
    }
  }, [state.toasts]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) window.clearTimeout(handle);
      map.clear();
    };
  }, []);

  if (state.toasts.length === 0) return null;
  return (
    <div className="room-ext-toasts" aria-live="polite">
      {state.toasts.map((toast) => (
        <div className="room-ext-toast" key={toast.id}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}

function RoomLobbyHud({
  channel,
  onToggleReady,
  onStart,
}: {
  channel: RoomChannel;
  onToggleReady: (ready: boolean) => void;
  onStart: () => void;
}): ReactElement | null {
  const state = useSyncExternalStore(channel.subscribe, channel.get);
  const [waitStart, setWaitStart] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const startRef = useRef(onStart);
  startRef.current = onStart;
  const autoStartedRef = useRef(false);

  // The lobby timer restarts whenever the lobby (re)appears.
  const inLobby = state.session != null && state.phase === "lobby";
  const lobbyKey = `${state.session?.code ?? ""}:${inLobby}`;
  useEffect(() => {
    setWaitStart(Date.now());
    setNow(Date.now());
    autoStartedRef.current = false;
  }, [lobbyKey]);

  useEffect(() => {
    if (!inLobby) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [inLobby]);

  // Host auto-start when everyone is ready (issue #30).
  const members = state.members;
  const watching = state.phase === "watching";
  const isHost = state.session?.isHost ?? false;
  useEffect(() => {
    if (!state.session || autoStartedRef.current) return;
    if (shouldAutoStart({ isHost, watching, members })) {
      autoStartedRef.current = true;
      startRef.current();
    }
    // `members` identity changes on every channel notify — intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.session, isHost, watching, members]);

  if (!state.session) return null;

  const waitingCount = state.members.filter((m) => m.ready !== true).length;
  return (
    <>
      <ToastStack
        state={state}
        onDismiss={(id) => channel.dismissToast(id)}
      />
      {inLobby ? (
        <LobbyCard
          state={state}
          hint={lobbyHint(now - waitStart, {
            allReady: allMembersReady(state.members),
            isHost,
          })}
          waitingCount={waitingCount}
          onToggleReady={() => {
            const self = state.members.find((m) => m.isSelf);
            const current = self ? self.ready === true : state.ready;
            onToggleReady(!current);
          }}
          onStart={() => {
            setWaitStart(Date.now());
            startRef.current();
          }}
          onWaitMore={() => setWaitStart(Date.now())}
        />
      ) : null}
    </>
  );
}

export const roomLobby: PlayerExtension = {
  id: "room-lobby",
  name: "Лобби комнаты",
  setup(ctx): Unsubscribe {
    const channel: RoomChannel = roomChannel;
    const stop = ctx.ui.add("overlay", () => (
      <RoomLobbyHud
        channel={channel}
        onToggleReady={(ready) => {
          channel.actions.setReady(ready);
        }}
        onStart={() => {
          const state = channel.get();
          if (!state.session?.isHost) return;
          ctx.transport.play().catch(() => {});
          channel.markStarted();
        }}
      />
    ));
    return () => {
      stop();
    };
  },
};

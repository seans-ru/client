/**
 * Room chat with timestamps + moment links (issue #29, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Active in room mode only (`ctx.room`): a sidecar chat panel — messages of
 * the participants, «@ момент» inserts a `[12:34]` code, clicking a code
 * seeks *locally* (personal seek), the host gets an extra «всем» action to
 * seek everyone (existing `state` broadcast). «Поделиться моментом»
 * builds `seans://room/CODE?t=754` + web links and copies them. Plain text
 * only (no markdown), length limit, send time per message. History lives in
 * session memory (server may merge the last N via `chat_history`).
 */

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { formatTime } from "../playerHelpers";
import { CHAT_MAX_LENGTH } from "../../rooms/roomSocial";
import { roomShareUrl } from "../../rooms/roomHelpers";
import type {
  PlayerExtension,
  RoomChatEntry,
  RoomSocialPort,
  Unsubscribe,
} from "./types";
import "./roomSocial.css";

/* ----------------------------------------------------------- pure helpers */

/** `[12:34]` / `[1:02:03]` — same mm:ss shape as the player clock. */
export function formatTimestamp(seconds: number): string {
  return `[${formatTime(seconds)}]`;
}

export type ChatToken =
  | { type: "text"; value: string }
  | { type: "time"; seconds: number };

const TIMESTAMP_RE = /\[(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?\]/g;

/** Split message text into plain runs and clickable `[m:ss]` / `[h:mm:ss]` codes. */
export function tokenizeChat(text: string): ChatToken[] {
  const tokens: ChatToken[] = [];
  let last = 0;
  const source = typeof text === "string" ? text : "";
  const re = new RegExp(TIMESTAMP_RE.source, "g");
  let match = re.exec(source);
  while (match !== null) {
    if (match.index > last) {
      tokens.push({ type: "text", value: source.slice(last, match.index) });
    }
    const a = Number(match[1]);
    const b = Number(match[2]);
    const c = match[3] != null ? Number(match[3]) : null;
    const seconds = c != null ? a * 3600 + b * 60 + c : a * 60 + b;
    if (Number.isFinite(seconds) && seconds >= 0) {
      tokens.push({ type: "time", seconds });
    } else {
      tokens.push({ type: "text", value: match[0] });
    }
    last = match.index + match[0].length;
    match = re.exec(source);
  }
  if (last < source.length) {
    tokens.push({ type: "text", value: source.slice(last) });
  }
  return tokens;
}

/** Insert `insert` at the caret; returns the new text and caret. */
export function insertAtCaret(
  text: string,
  caret: number,
  insert: string,
): { text: string; caret: number } {
  const at = Math.min(text.length, Math.max(0, Math.floor(caret)));
  const next = text.slice(0, at) + insert + text.slice(at);
  return { text: next, caret: at + insert.length };
}

/** Wall-clock `hh:mm` for the message header. */
export function formatClockTime(ts: number): string {
  const d = new Date(Number.isFinite(ts) ? ts : 0);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export type RoomMomentLinks = {
  /** `seans://room/CODE?t=754` — opens the app at that second. */
  deepLink: string;
  /** Web variant of the same moment. */
  webUrl: string;
};

/** Deep link + web link to a moment inside a room (issue #29). */
export function roomMomentLinks(
  code: string,
  seconds: number,
): RoomMomentLinks {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return {
    deepLink: `seans://room/${code}?t=${t}`,
    webUrl: `${roomShareUrl(code)}?t=${t}`,
  };
}

/* ------------------------------------------------------------------ UI */

function ChatText({
  text,
  isHost,
  onSeekSelf,
  onSeekAll,
}: {
  text: string;
  isHost: boolean;
  onSeekSelf: (seconds: number) => void;
  onSeekAll: (seconds: number) => void;
}): ReactElement {
  const tokens = tokenizeChat(text);
  return (
    <>
      {tokens.map((token, index) =>
        token.type === "text" ? (
          <span key={index}>{token.value}</span>
        ) : (
          <span key={index} className="room-chat-time-wrap">
            <button
              type="button"
              className="room-chat-time"
              title="Перемотать у себя"
              onClick={() => onSeekSelf(token.seconds)}
            >
              {formatTimestamp(token.seconds)}
            </button>
            {isHost ? (
              <button
                type="button"
                className="room-chat-time-all"
                title="Перемотать всех на этот момент"
                onClick={() => onSeekAll(token.seconds)}
              >
                всем
              </button>
            ) : null}
          </span>
        ),
      )}
    </>
  );
}

function ChatMessageRow({
  entry,
  isHost,
  onSeekSelf,
  onSeekAll,
}: {
  entry: RoomChatEntry;
  isHost: boolean;
  onSeekSelf: (seconds: number) => void;
  onSeekAll: (seconds: number) => void;
}): ReactElement {
  return (
    <li className="room-chat-msg">
      <div className="room-chat-msg-head">
        <span className="room-chat-msg-name">
          {entry.name && entry.name.length > 0
            ? entry.name
            : `Участник ${entry.userId.slice(0, 8)}`}
        </span>
        <time className="room-chat-msg-time" dateTime={new Date(entry.ts).toISOString()}>
          {formatClockTime(entry.ts)}
        </time>
      </div>
      <p className="room-chat-msg-text">
        <ChatText
          text={entry.text}
          isHost={isHost}
          onSeekSelf={onSeekSelf}
          onSeekAll={onSeekAll}
        />
      </p>
    </li>
  );
}

function ShareMoment({
  code,
  getPosition,
}: {
  code: string;
  getPosition: () => number;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"deep" | "web" | null>(null);
  const links = roomMomentLinks(code, getPosition());

  const copy = (value: string, kind: "deep" | "web") => {
    const finish = () => {
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 2000);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(value).then(finish).catch(() => {
        window.prompt("Скопируйте ссылку на момент:", value);
      });
    } else {
      window.prompt("Скопируйте ссылку на момент:", value);
    }
  };

  return (
    <div className="room-chat-share">
      <button
        type="button"
        className="room-chat-share-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Поделиться моментом
      </button>
      {open ? (
        <div className="room-chat-share-panel" role="group" aria-label="Ссылка на момент">
          <p className="room-chat-share-label">
            {`Момент ${formatTime(getPosition())}`}
          </p>
          <div className="room-chat-share-row">
            <span className="room-chat-share-kind">Приложение</span>
            <code className="room-chat-share-link" title={links.deepLink}>
              {links.deepLink}
            </code>
            <button
              type="button"
              className="room-chat-share-copy"
              onClick={() => copy(links.deepLink, "deep")}
            >
              {copied === "deep" ? "Скопировано" : "Скопировать"}
            </button>
          </div>
          <div className="room-chat-share-row">
            <span className="room-chat-share-kind">Веб</span>
            <code className="room-chat-share-link" title={links.webUrl}>
              {links.webUrl}
            </code>
            <button
              type="button"
              className="room-chat-share-copy"
              onClick={() => copy(links.webUrl, "web")}
            >
              {copied === "web" ? "Скопировано" : "Скопировать"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChatPanel({
  room,
  getPosition,
  onSeekSelf,
  onSeekAll,
}: {
  room: RoomSocialPort;
  getPosition: () => number;
  onSeekSelf: (seconds: number) => void;
  onSeekAll: (seconds: number) => void;
}): ReactElement {
  const messages = useSyncExternalStore(room.subscribe, room.getChat);
  const isHost = room.isHost();
  const [draft, setDraft] = useState("");
  const [rejected, setRejected] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLUListElement | null>(null);

  // Follow the tail when a message arrives.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length]);

  const insertMoment = () => {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? draft.length;
    const next = insertAtCaret(
      draft,
      caret,
      `${formatTimestamp(getPosition())} `,
    );
    setDraft(next.text.slice(0, CHAT_MAX_LENGTH));
    setRejected(false);
    window.setTimeout(() => {
      input?.focus();
      input?.setSelectionRange(next.caret, next.caret);
    }, 0);
  };

  const send = () => {
    const ok = room.sendChat(draft);
    if (ok) {
      setDraft("");
      setRejected(false);
    } else {
      // Empty / over-limit / cooldown — brief inline hint, no toast spam.
      setRejected(true);
      window.setTimeout(() => setRejected(false), 1500);
    }
  };

  return (
    <section className="room-chat" aria-label="Чат комнаты">
      <header className="room-chat-header">
        <h3 className="room-chat-title">Чат</h3>
        <ShareMoment code={room.roomCode()} getPosition={getPosition} />
      </header>

      <ul className="room-chat-log" ref={logRef}>
        {messages.length === 0 ? (
          <li className="room-chat-empty hint">Сообщений пока нет.</li>
        ) : (
          messages.map((entry) => (
            <ChatMessageRow
              key={entry.id}
              entry={entry}
              isHost={isHost}
              onSeekSelf={onSeekSelf}
              onSeekAll={onSeekAll}
            />
          ))
        )}
      </ul>

      <form
        className="room-chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="room-chat-form-row">
          <button
            type="button"
            className="room-chat-moment-btn"
            title="Вставить таймкод текущего момента"
            onClick={insertMoment}
          >
            @ момент
          </button>
          <input
            ref={inputRef}
            className="room-chat-input"
            type="text"
            value={draft}
            maxLength={CHAT_MAX_LENGTH}
            placeholder="Сообщение…"
            aria-label="Сообщение чата"
            onChange={(event) => {
              setDraft(event.target.value);
              setRejected(false);
            }}
          />
          <button type="submit" className="room-chat-send" disabled={draft.trim().length === 0}>
            Отправить
          </button>
        </div>
        <div className="room-chat-form-meta">
          {rejected ? (
            <span className="room-chat-form-warn">Не отправлено</span>
          ) : (
            <span />
          )}
          <span className="room-chat-form-count">
            {draft.length}/{CHAT_MAX_LENGTH}
          </span>
        </div>
      </form>
    </section>
  );
}

export const roomChat: PlayerExtension = {
  id: "room-chat",
  name: "Чат комнаты",
  setup(ctx): Unsubscribe | void {
    const room = ctx.room;
    // Room-only feature: outside a watch party there is nothing to wire.
    if (!room) return;

    const stopPanel = ctx.ui.add("sidecar", () => (
      <ChatPanel
        room={room}
        getPosition={() => ctx.getSnapshot().position}
        onSeekSelf={(seconds) => {
          // Personal seek — only this viewer moves (issue #29).
          void ctx.transport.seek(seconds, { personal: true });
        }}
        onSeekAll={(seconds) => {
          // Host broadcast through the existing guarded transport/`state`.
          void ctx.transport.seek(seconds);
        }}
      />
    ));
    return () => {
      stopPanel();
    };
  },
};

/**
 * Room social channel (issues #28, #29): emoji reactions + chat over the
 * room WebSocket. Pure wire codec + an in-session store.
 *
 * Protocol extension (backward compatible): servers that never send these
 * frames just never fire the listeners; unknown frames are ignored by both
 * sides. History lives in memory for the session and survives reconnects;
 * an optional `chat_history` frame from the server merges on top.
 */

/* ------------------------------------------------------------------ wire */

/** Allowed panel emojis (issue #28: 6–8 reactions). */
export const REACTION_EMOJIS = [
  "\u{1F44D}", // 👍
  "\u2764\uFE0F", // ❤️
  "\u{1F602}", // 😂
  "\u{1F62E}", // 😮
  "\u{1F622}", // 😢
  "\u{1F621}", // 😡
  "\u{1F389}", // 🎉
] as const;

/** Client-side rate limit: one reaction per second per participant. */
export const REACTION_RATE_LIMIT_MS = 1000;
/** Window in which a self-echo of a just-sent reaction is dropped. */
export const REACTION_ECHO_WINDOW_MS = 2500;
/** Identical incoming (user, emoji) inside this window is dropped (anti-spam). */
export const REACTION_DEDUPE_WINDOW_MS = 400;

/** Chat message length limit (issue #29). */
export const CHAT_MAX_LENGTH = 500;
/** Minimum gap between two outgoing chat messages (anti-spam). */
export const CHAT_SEND_COOLDOWN_MS = 700;
/** Window in which a self-echo of a just-sent message is merged (not duplicated). */
export const CHAT_ECHO_WINDOW_MS = 5000;
/** In-memory chat history cap (per session, survives reconnects). */
export const CHAT_HISTORY_LIMIT = 200;

export type ClientSocialMessage =
  | { type: "reaction"; emoji: string }
  | { type: "chat"; text: string }
  | { type: "room_settings"; reactions_enabled: boolean };

export type SocialWireMessage = {
  id: string | null;
  text: string;
  user_id: string;
  name: string | null;
  ts: number | null;
};

export type ServerSocialMessage =
  | {
      type: "reaction";
      emoji: string;
      userId: string;
      name: string | null;
    }
  | {
      type: "chat";
      id: string | null;
      text: string;
      userId: string;
      name: string | null;
      ts: number | null;
    }
  | { type: "chat_history"; messages: SocialWireMessage[] }
  | { type: "room_settings"; reactionsEnabled: boolean };

function asRaw(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function nonEmpty(value: unknown): string | null {
  const s = str(value);
  return s !== null && s.length > 0 ? s : null;
}

function safeTs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    return t === "true" || t === "1" || t === "yes";
  }
  return false;
}

/** Trim and bound a chat body; null when nothing usable is left. */
export function normalizeChatText(value: unknown): string | null {
  const s = str(value);
  if (s === null) return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > CHAT_MAX_LENGTH
    ? trimmed.slice(0, CHAT_MAX_LENGTH)
    : trimmed;
}

/** Trim and bound a reaction emoji; null when unusable. */
export function normalizeEmoji(value: unknown): string | null {
  const s = nonEmpty(value);
  if (s === null) return null;
  const trimmed = s.trim();
  if (trimmed.length === 0 || trimmed.length > 16) return null;
  return trimmed;
}

export function encodeReaction(emoji: string): string {
  return JSON.stringify({ type: "reaction", emoji: normalizeEmoji(emoji) ?? "" });
}

export function encodeChat(text: string): string {
  return JSON.stringify({ type: "chat", text: normalizeChatText(text) ?? "" });
}

export function encodeRoomSettings(reactionsEnabled: boolean): string {
  return JSON.stringify({
    type: "room_settings",
    reactions_enabled: Boolean(reactionsEnabled),
  });
}

function parseWireMessage(raw: unknown): SocialWireMessage | null {
  const r = asRaw(raw);
  const text = normalizeChatText(r.text);
  const userId = nonEmpty(r.user_id) ?? nonEmpty(r.userId) ?? nonEmpty(r.user);
  if (text === null || userId === null) return null;
  return {
    id: nonEmpty(r.id),
    text,
    user_id: userId,
    name: nonEmpty(r.name),
    ts: safeTs(r.ts),
  };
}

/**
 * Parse one social server frame. Returns null for non-JSON, other room
 * frames (`room_state`, `state`, …), or payloads missing identity fields.
 */
export function parseRoomSocialMessage(raw: string): ServerSocialMessage | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const r = asRaw(parsed);
  const type = nonEmpty(r.type);
  if (type === null) return null;

  switch (type) {
    case "reaction": {
      const emoji = normalizeEmoji(r.emoji);
      const userId = nonEmpty(r.user_id) ?? nonEmpty(r.userId) ?? nonEmpty(r.user);
      if (emoji === null || userId === null) return null;
      return {
        type: "reaction",
        emoji,
        userId,
        name: nonEmpty(r.name),
      };
    }

    case "chat": {
      const message = parseWireMessage(r);
      if (message === null) return null;
      return {
        type: "chat",
        id: message.id,
        text: message.text,
        userId: message.user_id,
        name: message.name,
        ts: message.ts,
      };
    }

    case "chat_history": {
      const list = Array.isArray(r.messages) ? r.messages : [];
      const messages: SocialWireMessage[] = [];
      for (const item of list) {
        const message = parseWireMessage(item);
        if (message !== null) messages.push(message);
      }
      return { type: "chat_history", messages };
    }

    case "room_settings":
      return {
        type: "room_settings",
        reactionsEnabled: normalizeBool(
          r.reactions_enabled ?? r.reactionsEnabled,
        ),
      };

    default:
      return null;
  }
}

/* ----------------------------------------------------------------- store */

export type RoomReactionEvent = {
  emoji: string;
  userId: string;
  name: string | null;
};

export type RoomChatEntry = {
  id: string;
  text: string;
  userId: string;
  name: string | null;
  /** Send time (ms epoch). */
  ts: number;
};

export type RoomSocialSend = (payload: string) => void;

/** Identity of the local user — wired by the room screen. */
export type RoomSocialIdentity = {
  selfUserId: string | null;
  selfName: string | null;
  isHost: () => boolean;
};

/** Socket-side wiring used by `useRoomSocket`. */
export type RoomSocialSocketWiring = {
  attach(send: RoomSocialSend | null): void;
  receive(message: ServerSocialMessage): void;
};

/**
 * Port exposed to player extensions as `ctx.room` (structural twin of
 * `RoomSocialPort` in `extensions/types.ts`).
 */
export type RoomSocialStore = RoomSocialSocketWiring & {
  setIdentity(identity: RoomSocialIdentity): void;
  setRoomCode(code: string): void;

  roomCode(): string;
  selfUserId(): string | null;
  selfName(): string | null;
  isHost(): boolean;
  /** False when rate-limited, disabled by the room flag, or no socket. */
  sendReaction(emoji: string): boolean;
  /** False when empty, over the length limit, on cooldown, or no socket. */
  sendChat(text: string): boolean;
  onReaction(cb: (event: RoomReactionEvent) => void): () => void;
  getChat(): readonly RoomChatEntry[];
  /** Chat list + room settings changes (for `useSyncExternalStore`). */
  subscribe(cb: () => void): () => void;
  getReactionsEnabled(): boolean;
  /** Host-only broadcast; a no-op for guests. */
  setReactionsEnabled(enabled: boolean): void;
};

export function createRoomSocialStore(
  options: { now?: () => number } = {},
): RoomSocialStore {
  const now = options.now ?? (() => Date.now());

  let send: RoomSocialSend | null = null;
  let identity: RoomSocialIdentity = {
    selfUserId: null,
    selfName: null,
    isHost: () => false,
  };
  let roomCode = "";

  let reactionsEnabled = true;
  let chat: RoomChatEntry[] = [];
  let chatSnapshot: readonly RoomChatEntry[] = [];
  let localSeq = 0;
  let lastReactionSentAt = -Infinity;
  let lastChatSentAt = -Infinity;
  /** Self echoes of just-sent reactions (dropped instead of shown twice). */
  const pendingSelfReactions: Array<{ emoji: string; ts: number }> = [];
  /** Incoming (user, emoji) timestamps — burst anti-spam. */
  const incomingReactionAt = new Map<string, number>();

  const listeners = new Set<() => void>();
  const reactionListeners = new Set<(event: RoomReactionEvent) => void>();

  const notify = () => {
    chatSnapshot = chat;
    for (const listener of [...listeners]) listener();
  };

  const emitReaction = (event: RoomReactionEvent) => {
    for (const listener of [...reactionListeners]) listener(event);
  };

  const appendChat = (entry: RoomChatEntry) => {
    chat = [...chat, entry];
    if (chat.length > CHAT_HISTORY_LIMIT) {
      chat = chat.slice(chat.length - CHAT_HISTORY_LIMIT);
    }
    notify();
  };

  /** Merge one incoming chat entry; drops/merges self echoes of optimistic sends. */
  const ingestChat = (message: {
    id: string | null;
    text: string;
    userId: string;
    name: string | null;
    ts: number | null;
  }) => {
    const ts = message.ts ?? now();
    const entry: RoomChatEntry = {
      id: message.id ?? `srv-${ts}-${chat.length}`,
      text: message.text,
      userId: message.userId,
      name: message.name,
      ts,
    };

    const self = identity.selfUserId;
    if (self != null && message.userId === self) {
      const echoIndex = chat.findIndex(
        (e) =>
          e.id.startsWith("local-") &&
          e.userId === self &&
          e.text === entry.text &&
          Math.abs(e.ts - ts) <= CHAT_ECHO_WINDOW_MS,
      );
      if (echoIndex >= 0) {
        // Server echo of our optimistic entry — keep one row, take server id/ts.
        const next = chat.slice();
        next[echoIndex] = entry;
        chat = next;
        notify();
        return;
      }
    }
    appendChat(entry);
  };

  return {
    attach(next) {
      send = next;
    },

    receive(message) {
      switch (message.type) {
        case "reaction": {
          const self = identity.selfUserId;
          // Drop the echo of our own optimistic bubble (already on screen).
          if (self != null && message.userId === self) {
            const index = pendingSelfReactions.findIndex(
              (p) =>
                p.emoji === message.emoji &&
                now() - p.ts <= REACTION_ECHO_WINDOW_MS,
            );
            if (index >= 0) {
              pendingSelfReactions.splice(index, 1);
              return;
            }
          }
          const key = `${message.userId}|${message.emoji}`;
          const last = incomingReactionAt.get(key) ?? -Infinity;
          if (now() - last < REACTION_DEDUPE_WINDOW_MS) return;
          incomingReactionAt.set(key, now());
          emitReaction({
            emoji: message.emoji,
            userId: message.userId,
            name: message.name,
          });
          return;
        }

        case "chat":
          ingestChat(message);
          return;

        case "chat_history": {
          for (const item of message.messages) {
            const duplicate =
              item.id != null
                ? chat.some((e) => e.id === item.id)
                : chat.some(
                    (e) =>
                      e.userId === item.user_id &&
                      e.text === item.text &&
                      item.ts != null &&
                      Math.abs(e.ts - item.ts) <= 1000,
                  );
            if (!duplicate) {
              ingestChat({
                id: item.id,
                text: item.text,
                userId: item.user_id,
                name: item.name,
                ts: item.ts,
              });
            }
          }
          return;
        }

        case "room_settings":
          reactionsEnabled = message.reactionsEnabled;
          notify();
          return;
      }
    },

    setIdentity(next) {
      identity = {
        selfUserId: next.selfUserId != null ? String(next.selfUserId) : null,
        selfName: next.selfName != null && next.selfName !== "" ? next.selfName : null,
        isHost: next.isHost,
      };
    },

    setRoomCode(code) {
      roomCode = code;
    },

    roomCode: () => roomCode,
    selfUserId: () => identity.selfUserId,
    selfName: () => identity.selfName,
    isHost: () => identity.isHost(),

    sendReaction(emoji) {
      const normalized = normalizeEmoji(emoji);
      if (normalized === null) return false;
      if (!reactionsEnabled) return false;
      if (send == null) return false;
      const at = now();
      if (at - lastReactionSentAt < REACTION_RATE_LIMIT_MS) return false;
      lastReactionSentAt = at;
      pendingSelfReactions.push({ emoji: normalized, ts: at });
      send(encodeReaction(normalized));
      emitReaction({
        emoji: normalized,
        userId: identity.selfUserId ?? "",
        name: identity.selfName,
      });
      return true;
    },

    sendChat(text) {
      const raw = typeof text === "string" ? text.trim() : "";
      // Reject (do not silently truncate) over-limit sends.
      if (raw.length === 0 || raw.length > CHAT_MAX_LENGTH) return false;
      const normalized = normalizeChatText(raw);
      if (normalized === null) return false;
      if (send == null) return false;
      const at = now();
      if (at - lastChatSentAt < CHAT_SEND_COOLDOWN_MS) return false;
      lastChatSentAt = at;
      localSeq += 1;
      appendChat({
        id: `local-${localSeq}`,
        text: normalized,
        userId: identity.selfUserId ?? "",
        name: identity.selfName,
        ts: at,
      });
      send(encodeChat(normalized));
      return true;
    },

    onReaction(cb) {
      reactionListeners.add(cb);
      return () => {
        reactionListeners.delete(cb);
      };
    },

    getChat: () => chatSnapshot,

    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    getReactionsEnabled: () => reactionsEnabled,

    setReactionsEnabled(enabled) {
      // Room-wide flag — only the host may flip it.
      if (!identity.isHost()) return;
      const next = Boolean(enabled);
      if (next === reactionsEnabled) return;
      reactionsEnabled = next;
      notify();
      send?.(encodeRoomSettings(next));
    },
  };
}

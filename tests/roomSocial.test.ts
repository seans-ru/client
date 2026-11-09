import { describe, expect, it, vi } from "vitest";
import {
  CHAT_ECHO_WINDOW_MS,
  CHAT_MAX_LENGTH,
  CHAT_SEND_COOLDOWN_MS,
  createRoomSocialStore,
  encodeChat,
  encodeReaction,
  encodeRoomSettings,
  normalizeChatText,
  normalizeEmoji,
  parseRoomSocialMessage,
  REACTION_RATE_LIMIT_MS,
} from "../src/features/rooms/roomSocial";

describe("roomSocial wire codec", () => {
  it("encodes and parses a reaction frame", () => {
    const raw = encodeReaction("\u{1F389}");
    expect(JSON.parse(raw)).toEqual({ type: "reaction", emoji: "\u{1F389}" });
    // server frame carries the sender
    expect(
      parseRoomSocialMessage(
        JSON.stringify({ type: "reaction", emoji: "\u{1F389}", user_id: "u1" }),
      ),
    ).toEqual({
      type: "reaction",
      emoji: "\u{1F389}",
      userId: "u1",
      name: null,
    });
  });

  it("encodes and parses a chat frame", () => {
    const raw = encodeChat("hello [12:34]");
    expect(JSON.parse(raw)).toEqual({ type: "chat", text: "hello [12:34]" });
    expect(
      parseRoomSocialMessage(
        JSON.stringify({
          type: "chat",
          id: "m1",
          text: "hello",
          user_id: "u1",
          name: "Ann",
          ts: 1000,
        }),
      ),
    ).toEqual({
      type: "chat",
      id: "m1",
      text: "hello",
      userId: "u1",
      name: "Ann",
      ts: 1000,
    });
  });

  it("parses chat_history and room_settings tolerantly", () => {
    expect(
      parseRoomSocialMessage(
        JSON.stringify({
          type: "chat_history",
          messages: [
            { id: "a", text: "one", user_id: "u1", ts: 5 },
            { text: "skipped: no user" },
            { id: "b", text: "two", user_id: "u2", name: "Bob" },
          ],
        }),
      ),
    ).toEqual({
      type: "chat_history",
      messages: [
        { id: "a", text: "one", user_id: "u1", name: null, ts: 5 },
        { id: "b", text: "two", user_id: "u2", name: "Bob", ts: null },
      ],
    });
    expect(
      parseRoomSocialMessage(
        JSON.stringify({ type: "room_settings", reactions_enabled: false }),
      ),
    ).toEqual({ type: "room_settings", reactionsEnabled: false });
    expect(encodeRoomSettings(true)).toBe(
      JSON.stringify({ type: "room_settings", reactions_enabled: true }),
    );
  });

  it("ignores other room frames, bad JSON and partial payloads", () => {
    expect(parseRoomSocialMessage('{"type":"room_state","position":1}')).toBeNull();
    expect(parseRoomSocialMessage("not json")).toBeNull();
    expect(parseRoomSocialMessage("")).toBeNull();
    expect(parseRoomSocialMessage('{"type":"reaction","emoji":"x"}')).toBeNull();
    expect(parseRoomSocialMessage('{"type":"chat","text":"hi"}')).toBeNull();
    expect(parseRoomSocialMessage('{"type":"chat_history"}')).toEqual({
      type: "chat_history",
      messages: [],
    });
  });

  it("normalizes emoji and chat text", () => {
    expect(normalizeEmoji("  x  ")).toBe("x");
    expect(normalizeEmoji("")).toBeNull();
    expect(normalizeEmoji("x".repeat(20))).toBeNull();
    expect(normalizeChatText("  hi  ")).toBe("hi");
    expect(normalizeChatText("   ")).toBeNull();
    expect(normalizeChatText("a".repeat(CHAT_MAX_LENGTH + 10))).toHaveLength(
      CHAT_MAX_LENGTH,
    );
  });
});

function makeStore() {
  let now = 10_000;
  let isHost = false;
  const sent: string[] = [];
  const store = createRoomSocialStore({ now: () => now });
  store.attach((payload) => sent.push(payload));
  store.setRoomCode("ABCD2345");
  store.setIdentity({
    selfUserId: "self",
    selfName: "Me",
    isHost: () => isHost,
  });
  return {
    store,
    sent,
    tick(ms: number) {
      now += ms;
    },
    setHost(value: boolean) {
      isHost = value;
    },
  };
}

describe("roomSocial store: reactions", () => {
  it("rate-limits sends to one per second and emits optimistically", () => {
    const { store, sent, tick } = makeStore();
    const events: string[] = [];
    store.onReaction((e) => events.push(e.emoji));

    expect(store.sendReaction("\u{1F44D}")).toBe(true);
    expect(store.sendReaction("\u{1F44D}")).toBe(false); // inside 1 s
    tick(REACTION_RATE_LIMIT_MS);
    expect(store.sendReaction("\u{1F44D}")).toBe(true);

    expect(sent).toEqual([encodeReaction("\u{1F44D}"), encodeReaction("\u{1F44D}")]);
    // Optimistic: one bubble per accepted send.
    expect(events).toEqual(["\u{1F44D}", "\u{1F44D}"]);
  });

  it("drops the self-echo of a just-sent reaction", () => {
    const { store, tick } = makeStore();
    const events: string[] = [];
    store.onReaction((e) => events.push(`${e.userId}:${e.emoji}`));

    store.sendReaction("\u2764\uFE0F");
    expect(events).toEqual(["self:\u2764\uFE0F"]);
    store.receive({
      type: "reaction",
      emoji: "\u2764\uFE0F",
      userId: "self",
      name: "Me",
    });
    expect(events).toEqual(["self:\u2764\uFE0F"]); // echo ignored

    tick(5000);
    store.receive({
      type: "reaction",
      emoji: "\u2764\uFE0F",
      userId: "self",
      name: "Me",
    });
    // A later self-reaction (not an echo) shows up.
    expect(events).toEqual(["self:\u2764\uFE0F", "self:\u2764\uFE0F"]);
  });

  it("drops identical incoming bursts from one user (anti-spam)", () => {
    const { store, tick } = makeStore();
    const events: string[] = [];
    store.onReaction((e) => events.push(e.userId));

    store.receive({ type: "reaction", emoji: "x", userId: "u2", name: null });
    store.receive({ type: "reaction", emoji: "x", userId: "u2", name: null });
    expect(events).toEqual(["u2"]);
    tick(1000);
    store.receive({ type: "reaction", emoji: "x", userId: "u2", name: null });
    expect(events).toEqual(["u2", "u2"]);
  });

  it("refuses sends when the room flag is off", () => {
    const { store, sent, setHost } = makeStore();
    setHost(true);
    store.setReactionsEnabled(false);
    expect(store.getReactionsEnabled()).toBe(false);
    expect(store.sendReaction("x")).toBe(false);
    expect(sent).toEqual([encodeRoomSettings(false)]);
  });

  it("lets only the host flip the room flag", () => {
    const { store, sent, setHost } = makeStore();
    store.setReactionsEnabled(false);
    expect(store.getReactionsEnabled()).toBe(true);
    expect(sent).toEqual([]);
    setHost(true);
    store.setReactionsEnabled(false);
    expect(store.getReactionsEnabled()).toBe(false);
  });

  it("applies room_settings frames from the server", () => {
    const { store } = makeStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.receive({ type: "room_settings", reactionsEnabled: false });
    expect(store.getReactionsEnabled()).toBe(false);
    expect(notified).toBe(1);
  });
});

describe("roomSocial store: chat", () => {
  it("appends optimistically and merges the server echo instead of duplicating", () => {
    const { store, sent, tick } = makeStore();
    expect(store.sendChat("hi [1:00]")).toBe(true);
    expect(store.getChat()).toHaveLength(1);
    expect(store.getChat()[0]).toMatchObject({
      text: "hi [1:00]",
      userId: "self",
      name: "Me",
    });
    expect(sent).toEqual([encodeChat("hi [1:00]")]);

    tick(200);
    store.receive({
      type: "chat",
      id: "srv-1",
      text: "hi [1:00]",
      userId: "self",
      name: "Me",
      ts: 10_200,
    });
    const chat = store.getChat();
    expect(chat).toHaveLength(1);
    expect(chat[0].id).toBe("srv-1");
    expect(chat[0].ts).toBe(10_200);
  });

  it("keeps foreign messages and enforces length + cooldown", () => {
    const { store, tick } = makeStore();
    store.receive({
      type: "chat",
      id: "a",
      text: "from u2",
      userId: "u2",
      name: "Ann",
      ts: 1,
    });
    expect(store.getChat()).toHaveLength(1);

    // Too long / empty — rejected.
    expect(store.sendChat("x".repeat(CHAT_MAX_LENGTH + 1))).toBe(false);
    expect(store.sendChat("   ")).toBe(false);
    // Cooldown — the second send inside the window is rejected.
    expect(store.sendChat("first")).toBe(true);
    expect(store.sendChat("second")).toBe(false);
    tick(CHAT_SEND_COOLDOWN_MS);
    expect(store.sendChat("second")).toBe(true);
  });

  it("stays silent without an attached socket", () => {
    const store = createRoomSocialStore({ now: () => 0 });
    expect(store.sendChat("x")).toBe(false);
    expect(store.sendReaction("x")).toBe(false);
  });

  it("merges chat_history on reconnect without duplicates", () => {
    const { store, tick } = makeStore();
    store.sendChat("mine");
    tick(CHAT_ECHO_WINDOW_MS + 1000);
    store.receive({
      type: "chat",
      id: "m1",
      text: "old one",
      userId: "u2",
      name: "Ann",
      ts: 5000,
    });

    store.receive({
      type: "chat_history",
      messages: [
        { id: "m1", text: "old one", user_id: "u2", name: "Ann", ts: 5000 },
        { id: "m2", text: "old two", user_id: "u3", name: null, ts: 6000 },
      ],
    });

    const chat = store.getChat();
    expect(chat.map((e) => e.text)).toEqual(["mine", "old one", "old two"]);
    expect(chat[2].id).toBe("m2");
  });

  it("caps the in-memory history", () => {
    const { store } = makeStore();
    for (let i = 0; i < 210; i += 1) {
      store.receive({
        type: "chat",
        id: `m${i}`,
        text: `msg ${i}`,
        userId: "u2",
        name: null,
        ts: i,
      });
    }
    expect(store.getChat()).toHaveLength(200);
    expect(store.getChat()[0].text).toBe("msg 10");
  });

  it("exposes room code and identity to extensions", () => {
    const { store } = makeStore();
    expect(store.roomCode()).toBe("ABCD2345");
    expect(store.selfUserId()).toBe("self");
    expect(store.selfName()).toBe("Me");
    expect(store.isHost()).toBe(false);
  });
});

describe("roomSocial store: notifications", () => {
  it("notifies subscribers on chat and settings changes only", () => {
    const { store, setHost } = makeStore();
    const spy = vi.fn();
    const stop = store.subscribe(spy);
    store.receive({
      type: "chat",
      id: "a",
      text: "x",
      userId: "u2",
      name: null,
      ts: 1,
    });
    store.receive({ type: "reaction", emoji: "x", userId: "u2", name: null });
    setHost(true);
    store.setReactionsEnabled(false);
    expect(spy).toHaveBeenCalledTimes(2); // chat + settings, not reactions
    stop();
    store.receive({
      type: "chat",
      id: "b",
      text: "y",
      userId: "u2",
      name: null,
      ts: 2,
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

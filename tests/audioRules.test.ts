import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaybackAudioTrack } from "../src/api/playback";
import {
  AUDIO_RULE_KEY,
  AUDIO_RULE_KINDS,
  classifyAudioKind,
  isProposalDismissed,
  loadAudioAskFirstOpen,
  loadAudioAsked,
  loadAudioPicks,
  loadAudioRuleKind,
  loadAudioRuleProposal,
  noteAudioPick,
  parseAudioRuleKind,
  proposedRuleFromPicks,
  recordAudioPick,
  repeatedPickKind,
  resolvePreferredAudioTrack,
  saveAudioAskFirstOpen,
  saveAudioAsked,
  saveAudioRuleKind,
  type AudioPickRecord,
} from "../src/features/player/audioTrackHelpers";
import {
  audioRules,
  createAudioRulesSettings,
  pendingProposal,
} from "../src/features/player/extensions/audioRules";
import {
  createExtensionRuntime,
  type ExtensionRuntimeDeps,
} from "../src/features/player/extensions/registry";
import type { MpvBridge } from "../src/features/player/extensions/types";
import { DEFAULT_SNAPSHOT } from "../src/features/player/playerTypes";

/** In-memory localStorage for the `seans.audio.*` helpers. */
function stubLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function apiTrack(
  partial: Partial<PlaybackAudioTrack> & { flags: PlaybackAudioTrack["flags"] },
): PlaybackAudioTrack {
  return {
    id: partial.id ?? "a1",
    language: partial.language ?? "ru",
    flags: partial.flags,
    embedded: partial.embedded ?? true,
    title: partial.title,
    label: partial.label,
    url: partial.url,
    track_index: partial.track_index,
  };
}

describe("classifyAudioKind (issue #9)", () => {
  it("classifies by flags — the product classification source", () => {
    expect(classifyAudioKind(apiTrack({ flags: ["original"] }))).toBe("original");
    expect(classifyAudioKind(apiTrack({ flags: ["dub"] }))).toBe("dub");
    expect(classifyAudioKind(apiTrack({ flags: ["studio_dub"] }))).toBe("dub");
    expect(classifyAudioKind(apiTrack({ flags: ["voice"] }))).toBe("voice");
    expect(classifyAudioKind(apiTrack({ flags: ["one_voice"] }))).toBe("one_voice");
    expect(classifyAudioKind(apiTrack({ flags: ["dual_audio"] }))).toBe("other");
    expect(classifyAudioKind(apiTrack({ flags: [] }))).toBe("other");
  });

  it("prefers original when several flags are present", () => {
    expect(classifyAudioKind(apiTrack({ flags: ["dub", "original"] }))).toBe(
      "original",
    );
  });

  it("falls back to title keywords for flagless (mpv) tracks", () => {
    expect(classifyAudioKind({ title: "Русский дубляж" })).toBe("dub");
    expect(classifyAudioKind({ title: "Многоголосый" })).toBe("voice");
    expect(classifyAudioKind({ title: "Одноголосый" })).toBe("one_voice");
    expect(classifyAudioKind({ label: "Оригинал · англ" })).toBe("original");
    // `one_voice` must not classify as `voice`.
    expect(classifyAudioKind({ title: "one_voice" })).toBe("one_voice");
    expect(classifyAudioKind({ title: "Лучезарный" })).toBe("other");
    expect(classifyAudioKind({})).toBe("other");
  });
});

describe("resolvePreferredAudioTrack with a rule (issue #9 priority)", () => {
  const tracks = [
    apiTrack({ id: "a1", flags: ["dub"] }),
    apiTrack({ id: "a2", flags: ["original"], language: "en" }),
    apiTrack({ id: "a3", flags: ["voice"] }),
  ];

  it("explicit pick beats the rule", () => {
    expect(
      resolvePreferredAudioTrack(tracks, {
        preferredId: "a3",
        rule: "dub",
      })?.id,
    ).toBe("a3");
  });

  it("rule beats the remembered pick", () => {
    expect(
      resolvePreferredAudioTrack(tracks, {
        savedId: "a3",
        rule: "dub",
      })?.id,
    ).toBe("a1");
  });

  it("remembered pick is used when the rule matches nothing", () => {
    expect(
      resolvePreferredAudioTrack(tracks, {
        savedId: "a3",
        rule: "one_voice",
      })?.id,
    ).toBe("a3");
  });

  it("falls back to original / first with no rule and no memory", () => {
    expect(resolvePreferredAudioTrack(tracks, {})?.id).toBe("a2");
    expect(
      resolvePreferredAudioTrack(tracks, { rule: "original" })?.id,
    ).toBe("a2");
  });
});

describe("rule persistence and pick history (seans.audio.*)", () => {
  it("stores the rule kind and the ask flag under seans.audio.*", () => {
    const store = stubLocalStorage();
    expect(loadAudioRuleKind()).toBeNull();
    saveAudioRuleKind("dub");
    expect(loadAudioRuleKind()).toBe("dub");
    expect(store.get(AUDIO_RULE_KEY)).toBe("dub");
    saveAudioRuleKind(null);
    expect(loadAudioRuleKind()).toBeNull();

    expect(loadAudioAskFirstOpen()).toBe(false);
    saveAudioAskFirstOpen(true);
    expect(loadAudioAskFirstOpen()).toBe(true);
    saveAudioAskFirstOpen(false);
    expect(loadAudioAskFirstOpen()).toBe(false);
  });

  it("parses unknown rule kinds to null", () => {
    expect(parseAudioRuleKind("dub")).toBe("dub");
    expect(parseAudioRuleKind("nope")).toBeNull();
    expect(parseAudioRuleKind(null)).toBeNull();
    for (const kind of AUDIO_RULE_KINDS) {
      expect(parseAudioRuleKind(kind)).toBe(kind);
    }
  });

  it("marks media as asked (first-open prompt)", () => {
    stubLocalStorage();
    expect(loadAudioAsked("m1")).toBe(false);
    saveAudioAsked("m1");
    expect(loadAudioAsked("m1")).toBe(true);
    expect(loadAudioAsked("m2")).toBe(false);
  });

  it("recordAudioPick keeps the newest records only", () => {
    let picks: AudioPickRecord[] = [];
    for (let i = 0; i < 60; i++) {
      picks = recordAudioPick(picks, { mediaKey: "m", kind: "dub", at: i });
    }
    // The cap trims the oldest records.
    expect(picks).toHaveLength(50);
    expect(picks[0].at).toBe(10);
    expect(picks[49].at).toBe(59);
  });

  it("repeatedPickKind triggers only at 2+ same-kind picks per media", () => {
    const base: AudioPickRecord[] = [
      { mediaKey: "m1", kind: "dub", at: 1 },
      { mediaKey: "m2", kind: "voice", at: 2 },
      { mediaKey: "m1", kind: "voice", at: 3 },
    ];
    expect(repeatedPickKind(base, "m1")).toBeNull();
    const withRepeat: AudioPickRecord[] = [
      ...base,
      { mediaKey: "m1", kind: "voice", at: 4 },
    ];
    expect(repeatedPickKind(withRepeat, "m1")).toBe("voice");
    // Only the requested media is considered («в сериале»).
    expect(repeatedPickKind(withRepeat, "m2")).toBeNull();
    expect(repeatedPickKind(withRepeat, "m1", 3)).toBeNull();
  });

  it("proposedRuleFromPicks skips other-kind repeats and the active rule", () => {
    const picks: AudioPickRecord[] = [
      { mediaKey: "m1", kind: "other", at: 1 },
      { mediaKey: "m1", kind: "other", at: 2 },
      { mediaKey: "m1", kind: "dub", at: 3 },
      { mediaKey: "m1", kind: "dub", at: 4 },
    ];
    expect(
      proposedRuleFromPicks(picks, { mediaKey: "m1" }),
    ).toEqual({ kind: "dub", mediaKey: "m1" });
    expect(
      proposedRuleFromPicks(picks, { mediaKey: "m1", existingRule: "dub" }),
    ).toBeNull();
    expect(
      proposedRuleFromPicks(picks, {
        mediaKey: "m1",
        dismissed: { kind: "dub", mediaKey: "m1" },
      }),
    ).toBeNull();
  });

  it("isProposalDismissed compares media + kind", () => {
    expect(
      isProposalDismissed(
        { kind: "dub", mediaKey: "m1" },
        { kind: "dub", mediaKey: "m1" },
      ),
    ).toBe(true);
    expect(
      isProposalDismissed(
        { kind: "dub", mediaKey: "m1" },
        { kind: "voice", mediaKey: "m1" },
      ),
    ).toBe(false);
    expect(isProposalDismissed(null, { kind: "dub", mediaKey: "m1" })).toBe(
      false,
    );
  });

  it("noteAudioPick raises the one-shot proposal on the 2nd repeat", () => {
    stubLocalStorage();
    noteAudioPick("m1", "dub");
    expect(loadAudioRuleProposal()).toBeNull();
    expect(loadAudioPicks()).toHaveLength(1);
    noteAudioPick("m1", "dub");
    expect(loadAudioRuleProposal()).toEqual({ kind: "dub", mediaKey: "m1" });
    noteAudioPick("m1", "voice");
    // The raised proposal stays until answered/dismissed.
    expect(loadAudioRuleProposal()).toEqual({ kind: "dub", mediaKey: "m1" });
  });

  it("noteAudioPick does not propose the kind that is already the rule", () => {
    stubLocalStorage();
    saveAudioRuleKind("dub");
    noteAudioPick("m1", "dub");
    noteAudioPick("m1", "dub");
    expect(loadAudioRuleProposal()).toBeNull();
  });
});

describe("pendingProposal (extension-side gate)", () => {
  it("hides dismissed and already-ruled proposals", () => {
    const proposal = { kind: "dub" as const, mediaKey: "m1" };
    expect(pendingProposal(proposal, null, null)).toEqual(proposal);
    expect(
      pendingProposal(proposal, { kind: "dub", mediaKey: "m1" }, null),
    ).toBeNull();
    expect(pendingProposal(proposal, null, "dub")).toBeNull();
    expect(pendingProposal(null, null, null)).toBeNull();
  });
});

describe("createAudioRulesSettings", () => {
  it("reflects the stored rule and ask flag", () => {
    // AUDIO_RULE_KEY stores the raw kind string via saveAudioPreference.
    stubLocalStorage({ [AUDIO_RULE_KEY]: "voice" });
    const settings = createAudioRulesSettings();
    expect(settings.getRule()).toBe("voice");
    settings.setAskFirstOpen(true);
    expect(settings.getAskFirstOpen()).toBe(true);
    settings.setRule("dub");
    expect(settings.getRule()).toBe("dub");
    expect(loadAudioRuleKind()).toBe("dub");
  });

  it("acceptProposal writes the rule and dismisses the offer", () => {
    stubLocalStorage();
    const settings = createAudioRulesSettings();
    settings.setMediaKey("m1");
    noteAudioPick("m1", "dub");
    noteAudioPick("m1", "dub");
    settings.refresh();
    expect(settings.getProposal()).toEqual({ kind: "dub", mediaKey: "m1" });
    settings.acceptProposal();
    expect(settings.getRule()).toBe("dub");
    expect(settings.getProposal()).toBeNull();
    expect(loadAudioRuleKind()).toBe("dub");
  });

  it("dismissProposal hides the offer without changing the rule", () => {
    stubLocalStorage();
    const settings = createAudioRulesSettings();
    settings.setMediaKey("m1");
    noteAudioPick("m1", "voice");
    noteAudioPick("m1", "voice");
    settings.refresh();
    expect(settings.getProposal()).not.toBeNull();
    settings.dismissProposal();
    expect(settings.getProposal()).toBeNull();
    expect(loadAudioRuleKind()).toBeNull();
    // The same offer is not raised again (one-shot prompt).
    noteAudioPick("m1", "voice");
    settings.refresh();
    expect(settings.getProposal()).toBeNull();
  });

  it("ask prompt is pending once per media when the option is on", () => {
    stubLocalStorage();
    const settings = createAudioRulesSettings();
    settings.setAskFirstOpen(true);
    settings.setMediaKey("m1");
    expect(settings.getAskPending()).toBe(true);
    settings.answerAsk("dub");
    expect(settings.getAskPending()).toBe(false);
    expect(loadAudioRuleKind()).toBe("dub");
    settings.setMediaKey("m2");
    expect(settings.getAskPending()).toBe(true);
    settings.answerAsk(null);
    expect(settings.getAskPending()).toBe(false);
    expect(loadAudioRuleKind()).toBe("dub");
  });

  it("notifies subscribers on changes only", () => {
    stubLocalStorage();
    const settings = createAudioRulesSettings();
    const cb = vi.fn();
    const stop = settings.subscribe(cb);
    settings.setRule("dub");
    settings.refresh(); // no change — no extra notify
    stop();
    settings.setRule(null);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("audioRules extension (registry scenarios)", () => {
  function makeMpv(): MpvBridge {
    return {
      getProperty: async () => "",
      setProperty: async () => {},
      command: async () => null,
    };
  }

  function setup() {
    const deps: ExtensionRuntimeDeps = {
      transport: {
        play: async () => {},
        pause: async () => {},
        togglePause: async () => {},
        seek: async () => {},
        setSpeed: async () => {},
        setVolume: async () => {},
        setMute: async () => {},
        setFullscreen: async () => {},
      },
      getSnapshot: () => ({ ...DEFAULT_SNAPSHOT }),
      mpv: makeMpv(),
      frames: { subscribe: () => () => {} },
      storageFor: () => ({
        get: <T,>(_key: string, fallback: T) => fallback,
        set: () => {},
      }),
      setChromeHidden: () => {},
    };
    return createExtensionRuntime([audioRules], deps);
  }

  it("contributes menu + overlay slots and survives open/close", () => {
    stubLocalStorage();
    const runtime = setup();
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(1);
    expect(runtime.getSlotEntries("overlay")).toHaveLength(1);
    runtime.notifyOpen({
      url: "https://cdn.example.com/a.mkv?sig=1",
      startAt: null,
      source: "vod",
    });
    runtime.notifySnapshot({ ...DEFAULT_SNAPSHOT, file_loaded: true });
    expect(() =>
      runtime.notifyOpen({
        url: "http://127.0.0.1:41235/",
        startAt: null,
        source: "progressive",
      }),
    ).not.toThrow();
    runtime.notifySnapshot({ ...DEFAULT_SNAPSHOT, file_loaded: true });
    runtime.notifyClose();
    runtime.dispose();
    expect(runtime.getSlotEntries("settings.menu")).toHaveLength(0);
    expect(runtime.getSlotEntries("overlay")).toHaveLength(0);
  });
});

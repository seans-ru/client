import { describe, expect, it } from "vitest";
import {
  decideDrift,
  reduceSyncUi,
  speedFactorForDrift,
  SYNC_UI_IDLE,
  DRIFT_LAG_SEC,
  DRIFT_SOFT_SEC,
  JOIN_ALIGN_SEC,
  PROMPT_SNOOZE_MS,
  SPEED_NUDGE_MAX,
} from "../src/features/player/extensions/roomSync";
import {
  allMembersReady,
  lobbyHint,
  memberStatusText,
  shouldAutoStart,
  LOBBY_SOFT_HINT_MS,
  LOBBY_STRONG_HINT_MS,
} from "../src/features/player/extensions/roomLobby";
import {
  currentTrackSelection,
  planTrackApply,
  shouldEnforceTracks,
  trackModeHint,
  tracksEqual,
} from "../src/features/player/extensions/roomTracks";
import type { PlayerTrack } from "../src/features/player/playerTypes";

const playing = {
  isPlaying: true,
  roomPlaying: true,
  isHost: false,
  watching: true,
  firstReference: false,
  expectedSec: 100,
};

describe("decideDrift (#27)", () => {
  it("keeps a dead zone around zero drift", () => {
    expect(decideDrift({ ...playing, driftSec: 0 })).toEqual({ kind: "idle" });
    expect(
      decideDrift({ ...playing, driftSec: DRIFT_SOFT_SEC }),
    ).toEqual({ kind: "idle" });
  });

  it("soft-corrects inside the 0.8–5 s band", () => {
    const behind = decideDrift({ ...playing, driftSec: -2 });
    expect(behind.kind).toBe("correct");
    if (behind.kind === "correct") {
      expect(behind.factor).toBeGreaterThan(1);
      expect(behind.factor).toBeLessThanOrEqual(1 + SPEED_NUDGE_MAX);
    }
    const ahead = decideDrift({ ...playing, driftSec: 2 });
    expect(ahead.kind).toBe("correct");
    if (ahead.kind === "correct") {
      expect(ahead.factor).toBeLessThan(1);
      expect(ahead.factor).toBeGreaterThanOrEqual(1 - SPEED_NUDGE_MAX);
    }
  });

  it("prompts the laggard beyond 5 s instead of speed-nudging", () => {
    const decision = decideDrift({
      ...playing,
      driftSec: -(DRIFT_LAG_SEC + 1),
    });
    expect(decision).toEqual({
      kind: "lagging",
      driftSec: -(DRIFT_LAG_SEC + 1),
    });
  });

  it("auto-aligns a fresh reference with a huge gap (join)", () => {
    const decision = decideDrift({
      ...playing,
      driftSec: -(JOIN_ALIGN_SEC + 20),
      firstReference: true,
      expectedSec: 300,
    });
    expect(decision).toEqual({ kind: "align", toSec: 300 });
  });

  it("does not align on later references", () => {
    const decision = decideDrift({
      ...playing,
      driftSec: -(JOIN_ALIGN_SEC + 20),
      firstReference: false,
      expectedSec: 300,
    });
    expect(decision.kind).toBe("lagging");
  });

  it("stays idle for the host, the lobby, pause and room-pause", () => {
    expect(decideDrift({ ...playing, driftSec: -3, isHost: true })).toEqual({
      kind: "idle",
    });
    expect(decideDrift({ ...playing, driftSec: -3, watching: false })).toEqual({
      kind: "idle",
    });
    expect(decideDrift({ ...playing, driftSec: -3, isPlaying: false })).toEqual({
      kind: "idle",
    });
    expect(decideDrift({ ...playing, driftSec: -3, roomPlaying: false })).toEqual({
      kind: "idle",
    });
  });
});

describe("speedFactorForDrift", () => {
  it("stays inside the 0.95–1.05× band", () => {
    for (const drift of [-40, -5, -1, 0, 1, 5, 40]) {
      const factor = speedFactorForDrift(drift);
      expect(factor).toBeGreaterThanOrEqual(1 - SPEED_NUDGE_MAX);
      expect(factor).toBeLessThanOrEqual(1 + SPEED_NUDGE_MAX);
    }
  });

  it("is identity at zero drift", () => {
    expect(speedFactorForDrift(0)).toBe(1);
  });
});

describe("reduceSyncUi", () => {
  it("shows the sync badge while correcting", () => {
    const state = reduceSyncUi(SYNC_UI_IDLE, {
      decision: { kind: "correct", factor: 1.02 },
      driftSec: -2,
      now: 0,
    });
    expect(state.correcting).toBe(true);
    expect(state.promptVisible).toBe(false);
  });

  it("shows the lag prompt once and snoozes after dismissal", () => {
    let state = reduceSyncUi(SYNC_UI_IDLE, {
      decision: { kind: "lagging", driftSec: -6 },
      driftSec: -6,
      now: 1000,
    });
    expect(state.promptVisible).toBe(true);
    state = {
      ...state,
      promptVisible: false,
      promptDismissedAt: 1000,
    };
    // Still lagging, but inside the snooze window.
    state = reduceSyncUi(state, {
      decision: { kind: "lagging", driftSec: -7 },
      driftSec: -7,
      now: 1000 + PROMPT_SNOOZE_MS / 2,
    });
    expect(state.promptVisible).toBe(false);
    // Snooze over — the prompt comes back.
    state = reduceSyncUi(state, {
      decision: { kind: "lagging", driftSec: -7 },
      driftSec: -7,
      now: 1000 + PROMPT_SNOOZE_MS + 1,
    });
    expect(state.promptVisible).toBe(true);
  });

  it("hides everything once the drift is resolved", () => {
    const state = reduceSyncUi(
      { ...SYNC_UI_IDLE, correcting: true, lagging: true, driftSec: -4 },
      { decision: { kind: "idle" }, driftSec: -0.1, now: 0 },
    );
    expect(state.correcting).toBe(false);
    expect(state.lagging).toBe(false);
    expect(state.promptVisible).toBe(false);
    expect(state.driftSec).toBe(-0.1);
  });

  it("suppresses the prompt in strict mode (auto-pause instead)", () => {
    const state = reduceSyncUi(
      { ...SYNC_UI_IDLE, strict: true },
      { decision: { kind: "lagging", driftSec: -9 }, driftSec: -9, now: 0 },
    );
    expect(state.lagging).toBe(true);
    expect(state.promptVisible).toBe(false);
  });
});

describe("lobby helpers (#30)", () => {
  it("labels readiness", () => {
    expect(memberStatusText(null)).toBe("Подключается");
    expect(memberStatusText(true)).toBe("Готов");
    expect(memberStatusText(false)).toBe("Не готов");
  });

  it("allMembersReady needs everyone (and at least one member)", () => {
    expect(allMembersReady([])).toBe(false);
    expect(allMembersReady([{ ready: true }, { ready: true }])).toBe(true);
    expect(allMembersReady([{ ready: true }, { ready: null }])).toBe(false);
    expect(allMembersReady([{ ready: true }, { ready: false }])).toBe(false);
  });

  it("escalates the host hint over the ready-wait", () => {
    const host = { allReady: false, isHost: true };
    expect(lobbyHint(0, host)).toBe("none");
    expect(lobbyHint(LOBBY_SOFT_HINT_MS, host)).toBe("soft");
    expect(lobbyHint(LOBBY_STRONG_HINT_MS, host)).toBe("strong");
    expect(lobbyHint(LOBBY_STRONG_HINT_MS, { ...host, allReady: true })).toBe(
      "none",
    );
    expect(lobbyHint(LOBBY_STRONG_HINT_MS, { ...host, isHost: false })).toBe(
      "none",
    );
  });

  it("auto-starts for the host with at least one ready guest", () => {
    const self = { ready: true, isSelf: true };
    const guest = { ready: true, isSelf: false };
    expect(
      shouldAutoStart({
        isHost: true,
        watching: false,
        members: [self, guest],
      }),
    ).toBe(true);
    // Solo host waits for an explicit start.
    expect(
      shouldAutoStart({ isHost: true, watching: false, members: [self] }),
    ).toBe(false);
    // Not everyone ready — wait.
    expect(
      shouldAutoStart({
        isHost: true,
        watching: false,
        members: [self, { ready: null, isSelf: false }],
      }),
    ).toBe(false);
    // Guests never auto-start; nothing restarts after the lobby.
    expect(
      shouldAutoStart({
        isHost: false,
        watching: false,
        members: [self, guest],
      }),
    ).toBe(false);
    expect(
      shouldAutoStart({
        isHost: true,
        watching: true,
        members: [self, guest],
      }),
    ).toBe(false);
  });
});

function track(
  id: number,
  kind: string,
  selected = false,
): PlayerTrack {
  return {
    id,
    kind,
    title: "",
    lang: "",
    codec: "",
    selected,
    external: false,
  };
}

describe("track sync helpers (#31)", () => {
  const tracks = [track(1, "audio", true), track(2, "audio"), track(1, "sub")];

  it("reads the current selection", () => {
    expect(currentTrackSelection(tracks)).toEqual({
      audioId: 1,
      subId: null,
    });
    expect(
      currentTrackSelection([
        track(1, "audio"),
        track(2, "audio", true),
        track(3, "sub", true),
      ]),
    ).toEqual({ audioId: 2, subId: 3 });
  });

  it("plans writes only for real changes and present tracks", () => {
    const current = { audioId: 1, subId: null };
    // Move audio to track 2 (present) and turn subtitles off (already off).
    expect(planTrackApply(tracks, { audioId: 2, subId: null }, current)).toEqual({
      audio: "2",
      sub: null,
    });
    // Missing track id — silently skipped (issue #31).
    expect(
      planTrackApply(tracks, { audioId: 9, subId: 9 }, current),
    ).toEqual({ audio: null, sub: null });
    // Off switches write "no" when something is selected.
    expect(
      planTrackApply(tracks, { audioId: null, subId: null }, current),
    ).toEqual({ audio: "no", sub: null });
    // Already there — no writes.
    expect(planTrackApply(tracks, current, current)).toEqual({
      audio: null,
      sub: null,
    });
  });

  it("enforces only for guests in the synchronous mode", () => {
    expect(shouldEnforceTracks({ isHost: false, trackMode: "host" })).toBe(true);
    expect(shouldEnforceTracks({ isHost: false, trackMode: "free" })).toBe(false);
    expect(shouldEnforceTracks({ isHost: true, trackMode: "host" })).toBe(false);
  });

  it("compares track pairs", () => {
    expect(tracksEqual({ audioId: 1, subId: null }, { audioId: 1, subId: null })).toBe(
      true,
    );
    expect(tracksEqual({ audioId: 1, subId: null }, { audioId: 2, subId: null })).toBe(
      false,
    );
    expect(tracksEqual(null, null)).toBe(true);
    expect(tracksEqual(null, { audioId: 1, subId: null })).toBe(false);
  });

  it("labels the menu hints per role and mode", () => {
    expect(
      trackModeHint({
        active: true,
        isHost: false,
        trackMode: "host",
        hasHostTracks: true,
      }),
    ).toBe("Дорожка от хоста");
    expect(
      trackModeHint({
        active: true,
        isHost: true,
        trackMode: "host",
        hasHostTracks: true,
      }),
    ).toBe("Выбрано для всех");
    // Free mode carries no indicator (issue #31).
    expect(
      trackModeHint({
        active: true,
        isHost: false,
        trackMode: "free",
        hasHostTracks: true,
      }),
    ).toBe("");
    expect(
      trackModeHint({
        active: false,
        isHost: false,
        trackMode: "host",
        hasHostTracks: true,
      }),
    ).toBe("");
    // Guest before the host picked anything — no indicator either.
    expect(
      trackModeHint({
        active: true,
        isHost: false,
        trackMode: "host",
        hasHostTracks: false,
      }),
    ).toBe("");
  });
});

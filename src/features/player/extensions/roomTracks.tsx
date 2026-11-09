/**
 * Synchronized audio/subtitle tracks (issue #31, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * The host picks audio/subtitles for the whole room (`setTracks {audio_id,
 * sub_id}`, relay-compatible `state` frames). Guests apply the host's mpv
 * track ids automatically — same file (`room.task_file_id`) means the same
 * track ids; a missing track is skipped silently. Room modes:
 *
 * - «Синхронно от хоста» (default): the local per-media choice does not win
 *   until the host changes tracks — stray guest menu clicks are reverted and
 *   the track menu shows «Дорожка от хоста»; the host sees «выбрано для всех»;
 * - «Свободный выбор»: everyone picks their own, no indicators.
 *
 * Leaving the room (or the mode flipping to free) restores the local
 * selection that was in effect before the host override.
 *
 * Track application goes through `ctx.mpv` (`aid` / `sid`) — the same
 * properties the frozen `player_set_*_track` commands write (id ≤ 0 → "no").
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type { PlayerSnapshot, PlayerTrack } from "../playerTypes";
import type { PlayerExtension, Unsubscribe } from "./types";
import type { RoomChannel } from "../../rooms/roomChannel";
import { roomChannel } from "../../rooms/roomChannel";
import type { RoomTracks } from "../../rooms/roomReducer";
import "./roomOverlay.css";

export const ROOM_TRACKS_NONE: RoomTracks = { audioId: null, subId: null };

export type TrackApplyPlan = {
  /** mpv `aid` value to write, or `null` to leave alone. */
  audio: string | null;
  /** mpv `sid` value to write, or `null` to leave alone. */
  sub: string | null;
};

export function tracksEqual(a: RoomTracks | null, b: RoomTracks | null): boolean {
  if (a == null || b == null) return a === b;
  return a.audioId === b.audioId && a.subId === b.subId;
}

/** Currently selected mpv audio/sub track ids (`null` = off). */
export function currentTrackSelection(
  tracks: readonly PlayerTrack[],
): RoomTracks {
  const audio = tracks.find((t) => t.kind === "audio" && t.selected);
  const sub = tracks.find((t) => t.kind === "sub" && t.selected);
  return {
    audioId: audio ? audio.id : null,
    subId: sub ? sub.id : null,
  };
}

/**
 * mpv writes needed to move `current` onto `desired`. Tracks that are not in
 * the file are skipped silently (issue #31: «отсутствие дорожек — молча
 * пропустить»); already-correct tracks are left alone.
 */
export function planTrackApply(
  tracks: readonly PlayerTrack[],
  desired: RoomTracks,
  current: RoomTracks,
): TrackApplyPlan {
  const pick = (
    kind: "audio" | "sub",
    want: number | null,
    have: number | null,
  ): string | null => {
    if (want == null) return have != null ? "no" : null;
    if (want === have) return null;
    const present = tracks.some((t) => t.kind === kind && t.id === want);
    return present ? String(want) : null;
  };
  return {
    audio: pick("audio", desired.audioId, current.audioId),
    sub: pick("sub", desired.subId, current.subId),
  };
}

/** Guests in the synchronous mode follow the host's tracks. */
export function shouldEnforceTracks(input: {
  isHost: boolean;
  trackMode: "host" | "free";
}): boolean {
  return !input.isHost && input.trackMode === "host";
}

export type TracksHudState = {
  active: boolean;
  isHost: boolean;
  trackMode: "host" | "free";
  /** Host has issued at least one `setTracks`. */
  hasHostTracks: boolean;
};

export type TracksHudStore = {
  subscribe: (cb: () => void) => Unsubscribe;
  get: () => TracksHudState;
  update: (patch: Partial<TracksHudState>) => void;
};

export function createTracksHudStore(): TracksHudStore {
  let state: TracksHudState = {
    active: false,
    isHost: false,
    trackMode: "host",
    hasHostTracks: false,
  };
  const listeners = new Set<() => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => state,
    update(patch) {
      const next = { ...state, ...patch };
      if (
        next.active === state.active &&
        next.isHost === state.isHost &&
        next.trackMode === state.trackMode &&
        next.hasHostTracks === state.hasHostTracks
      ) {
        return;
      }
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function TrackModeSection({
  hud,
  onSetMode,
}: {
  hud: TracksHudStore;
  onSetMode: (mode: "host" | "free") => void;
}): ReactElement | null {
  const state = useSyncExternalStore(hud.subscribe, hud.get);
  if (!state.active) return null;
  return (
    <section>
      <h4 className="player-menu-title">Комната · дорожки</h4>
      {state.isHost ? (
        <>
          <div className="player-menu-row" role="group" aria-label="Режим дорожек">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={state.trackMode === "host"}
              className={`player-chip${state.trackMode === "host" ? " player-chip-active" : ""}`}
              onClick={() => onSetMode("host")}
            >
              Синхронно от хоста
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={state.trackMode === "free"}
              className={`player-chip${state.trackMode === "free" ? " player-chip-active" : ""}`}
              onClick={() => onSetMode("free")}
            >
              Свободный выбор
            </button>
          </div>
          {state.trackMode === "host" ? (
            <p className="player-menu-empty">Выбрано для всех</p>
          ) : null}
        </>
      ) : state.trackMode === "host" && state.hasHostTracks ? (
        <p className="player-menu-empty">Дорожка от хоста</p>
      ) : null}
    </section>
  );
}

export const roomTracks: PlayerExtension = {
  id: "room-tracks",
  name: "Дорожки комнаты",
  setup(ctx): Unsubscribe {
    const channel: RoomChannel = roomChannel;
    const hud = createTracksHudStore();

    /** Selection before the host override — restored on leave / free mode. */
    let localTracks: RoomTracks | null = null;
    let enforced = false;
    let lastBroadcast: RoomTracks | null = null;
    let lastMemberCount = 0;
    let applying = false;
    let applyingTimer: number | null = null;

    const applyPlan = (plan: TrackApplyPlan): void => {
      if (plan.audio != null) {
        void ctx.mpv.setProperty("aid", plan.audio).catch(() => {});
      }
      if (plan.sub != null) {
        void ctx.mpv.setProperty("sid", plan.sub).catch(() => {});
      }
    };

    const applyTracks = (tracks: RoomTracks, snapshot: PlayerSnapshot): void => {
      const current = currentTrackSelection(snapshot.tracks);
      const plan = planTrackApply(snapshot.tracks, tracks, current);
      if (plan.audio == null && plan.sub == null) return;
      applying = true;
      if (applyingTimer != null) window.clearTimeout(applyingTimer);
      applyPlan(plan);
      // The next snapshot confirms the write; until then ignore our own echo.
      applyingTimer = window.setTimeout(() => {
        applying = false;
        applyingTimer = null;
      }, 250);
    };

    const syncTracks = (): void => {
      const state = channel.get();
      const snapshot = ctx.getSnapshot();
      const current = currentTrackSelection(snapshot.tracks);
      const session = state.session;

      hud.update({
        active: session != null,
        isHost: session?.isHost ?? false,
        trackMode: state.trackMode,
        hasHostTracks: state.hostTracks != null,
      });

      if (!session) {
        // Session over — put the local selection back (issue #31).
        if (enforced && localTracks) {
          applyTracks(localTracks, snapshot);
        }
        localTracks = null;
        enforced = false;
        lastBroadcast = null;
        lastMemberCount = 0;
        return;
      }

      if (session.isHost) {
        // Host is the source: broadcast selection changes for the room.
        // Never broadcast before the tracks are known — a `{null, null}`
        // snapshot pre-open would make guests disable their audio.
        if (snapshot.tracks.length === 0) return;
        if (lastBroadcast == null) {
          lastBroadcast = current;
          channel.actions.setTracks(current);
        } else if (!tracksEqual(lastBroadcast, current)) {
          lastBroadcast = current;
          channel.actions.setTracks(current);
        }
        return;
      }

      // Guest.
      const desired = state.hostTracks;
      const enforcingNow =
        desired != null &&
        shouldEnforceTracks({ isHost: false, trackMode: state.trackMode });

      if (!enforcingNow) {
        if (enforced && localTracks) {
          applyTracks(localTracks, snapshot);
          enforced = false;
        } else if (!applying) {
          // Free choice evolves with the user's own menu clicks.
          localTracks = current;
        }
        return;
      }

      if (tracksEqual(desired, current)) return;
      // First override: remember the selection we are replacing.
      if (localTracks == null) localTracks = current;
      enforced = true;
      applyTracks(desired, snapshot);
    };

    const stopSnapshot = ctx.onSnapshot(() => {
      syncTracks();
    });

    // Member joins (host re-shares the current tracks) and room-mode changes.
    const stopChannel = channel.subscribe(() => {
      const state = channel.get();
      const count = state.members.length;
      const grew = count > lastMemberCount;
      lastMemberCount = count;
      if (state.session?.isHost && grew && lastBroadcast != null) {
        channel.actions.setTracks(lastBroadcast);
      }
      syncTracks();
    });

    // The file may already be open when the extension mounts.
    syncTracks();

    const stopSection = ctx.ui.add("settings.menu", () => (
      <TrackModeSection
        hud={hud}
        onSetMode={(mode) => {
          channel.actions.setTrackMode(mode);
          syncTracks();
        }}
      />
    ));

    return () => {
      stopSection();
      stopSnapshot();
      stopChannel();
      if (applyingTimer != null) window.clearTimeout(applyingTimer);
      // Dispose (player teardown): restore the local selection if overridden.
      if (enforced && localTracks) {
        const snapshot = ctx.getSnapshot();
        applyTracks(localTracks, snapshot);
        enforced = false;
      }
    };
  },
};

/** Exported for the settings section label tests. */
export function trackModeHint(state: TracksHudState): string {
  if (!state.active) return "";
  if (state.isHost) {
    return state.trackMode === "host" ? "Выбрано для всех" : "";
  }
  return state.trackMode === "host" && state.hasHostTracks ? "Дорожка от хоста" : "";
}

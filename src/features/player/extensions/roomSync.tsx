/**
 * Smart room sync (issue #27, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * The host is the source of truth: it broadcasts a position reference every
 * few seconds (`state` action `sync`, relay-compatible) and play/pause/seek
 * frames on user actions. Guests compare their playhead against the
 * interpolated host reference and:
 *
 * - drift ≤ 0.8 s — nothing (dead zone);
 * - 0.8–5 s — a gentle speed nudge (0.95–1.05×) while showing
 *   «синхронизация…», restoring the user's playback speed when aligned;
 * - > 5 s — «Вы отстаёте, перемотать к группе?» with a one-click resync
 *   (optional strict mode auto-pauses instead);
 * - the first reference after a join is an alignment, not a visible drift —
 *   a hard seek keeps late joiners with the group.
 *
 * Guests also report `buffered_ahead` (mpv `demuxer-cache-duration`) so the
 * host's lobby can see readiness (issues #27/#30).
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type { PlayerSnapshot } from "../playerTypes";
import type { PlayerExtension, Unsubscribe } from "./types";
import type { RoomChannel } from "../../rooms/roomChannel";
import { expectedPosition, roomChannel } from "../../rooms/roomChannel";
import "./roomOverlay.css";

/** Below this drift nothing happens — small jitter is invisible. */
export const DRIFT_SOFT_SEC = 0.8;
/** Above this drift the lag prompt takes over (issue #27 copy). */
export const DRIFT_LAG_SEC = 5;
/** First reference after a join with a bigger gap = alignment seek. */
export const JOIN_ALIGN_SEC = 10;
/** Issue #27: gentle correction stays within 0.95–1.05×. */
export const SPEED_NUDGE_MAX = 0.05;
/** How often the host re-broadcasts its position reference. */
export const SYNC_REF_INTERVAL_MS = 5_000;
/** Buffered-ahead telemetry cadence. */
export const BUFFER_POLL_MS = 2_000;
/** Do not re-show a dismissed lag prompt for this long. */
export const PROMPT_SNOOZE_MS = 30_000;

export type DriftDecision =
  | { kind: "idle" }
  | { kind: "correct"; factor: number }
  | { kind: "lagging"; driftSec: number }
  | { kind: "align"; toSec: number };

export type DriftInput = {
  /** local − expected host position; positive = local is ahead. */
  driftSec: number;
  /** Local playback is running. */
  isPlaying: boolean;
  /** The room (host) is playing. */
  roomPlaying: boolean;
  isHost: boolean;
  /** Past the lobby — only watch sessions drift-correct. */
  watching: boolean;
  /** No reference applied yet (join/reconnect alignment). */
  firstReference: boolean;
  /** Interpolated host position (for the alignment seek target). */
  expectedSec: number;
};

/**
 * Speed multiplier that closes the drift without visible jumps. Behind the
 * room → speed up slightly; ahead → slow down slightly.
 */
export function speedFactorForDrift(driftSec: number): number {
  const nudge = Math.max(
    -SPEED_NUDGE_MAX,
    Math.min(SPEED_NUDGE_MAX, -driftSec * 0.02),
  );
  return Math.round((1 + nudge) * 1000) / 1000;
}

/** Pure drift policy (issue #27 thresholds). */
export function decideDrift(input: DriftInput): DriftDecision {
  const { driftSec, isPlaying, roomPlaying, isHost, watching } = input;
  if (isHost || !watching || !isPlaying || !roomPlaying) {
    return { kind: "idle" };
  }
  const gap = Math.abs(driftSec);
  if (input.firstReference && gap > JOIN_ALIGN_SEC) {
    return { kind: "align", toSec: input.expectedSec };
  }
  if (gap > DRIFT_LAG_SEC) {
    return { kind: "lagging", driftSec };
  }
  if (gap > DRIFT_SOFT_SEC) {
    return { kind: "correct", factor: speedFactorForDrift(driftSec) };
  }
  return { kind: "idle" };
}

export type SyncUiState = {
  correcting: boolean;
  lagging: boolean;
  promptVisible: boolean;
  promptDismissedAt: number | null;
  driftSec: number | null;
  /** Strict mode: auto-pause the laggard instead of a passive prompt. */
  strict: boolean;
};

export const SYNC_UI_IDLE: SyncUiState = {
  correcting: false,
  lagging: false,
  promptVisible: false,
  promptDismissedAt: null,
  driftSec: null,
  strict: false,
};

/**
 * UI-state transition for one drift decision. Pure — `now` drives the prompt
 * snooze window so tests control time. Drift is rounded to 0.1 s so idle
 * jitter does not churn store notifications.
 */
export function reduceSyncUi(
  prev: SyncUiState,
  input: { decision: DriftDecision; driftSec: number | null; now: number },
): SyncUiState {
  const { decision, driftSec, now } = input;
  const rounded =
    driftSec == null || !Number.isFinite(driftSec)
      ? null
      : Math.round(driftSec * 10) / 10;
  switch (decision.kind) {
    case "correct":
      return {
        ...prev,
        correcting: true,
        lagging: false,
        driftSec: rounded,
      };
    case "lagging": {
      const snoozed =
        prev.promptDismissedAt != null &&
        now - prev.promptDismissedAt < PROMPT_SNOOZE_MS;
      return {
        ...prev,
        correcting: false,
        lagging: true,
        driftSec: rounded,
        promptVisible: prev.strict ? false : !snoozed,
      };
    }
    case "align":
      return {
        ...prev,
        correcting: false,
        lagging: false,
        promptVisible: false,
        driftSec: 0,
      };
    default:
      return {
        ...prev,
        correcting: false,
        lagging: false,
        promptVisible: false,
        driftSec: rounded ?? prev.driftSec,
      };
  }
}

export type SyncHudStore = {
  subscribe: (cb: () => void) => Unsubscribe;
  get: () => SyncUiState;
  setDecision: (input: {
    decision: DriftDecision;
    driftSec: number | null;
    now: number;
  }) => void;
  dismissPrompt: (now: number) => void;
  setStrict: (strict: boolean) => void;
  reset: () => void;
};

export function createSyncHudStore(initial?: Partial<SyncUiState>): SyncHudStore {
  let state: SyncUiState = { ...SYNC_UI_IDLE, ...initial };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const changed = (next: SyncUiState): boolean =>
    next.correcting !== state.correcting ||
    next.lagging !== state.lagging ||
    next.promptVisible !== state.promptVisible ||
    next.promptDismissedAt !== state.promptDismissedAt ||
    next.driftSec !== state.driftSec ||
    next.strict !== state.strict;
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => state,
    setDecision(input) {
      const next = reduceSyncUi(state, input);
      if (!changed(next)) return;
      state = next;
      notify();
    },
    dismissPrompt(now) {
      if (!state.promptVisible && state.promptDismissedAt == null) return;
      state = {
        ...state,
        promptVisible: false,
        promptDismissedAt: now,
      };
      notify();
    },
    setStrict(strict) {
      if (state.strict === strict) return;
      state = { ...state, strict, promptVisible: strict ? false : state.promptVisible };
      notify();
    },
    reset() {
      const next = { ...SYNC_UI_IDLE, strict: state.strict };
      if (!changed(next)) return;
      state = next;
      notify();
    },
  };
}

/** Read mpv's buffered-ahead estimate in seconds (0 when unknown). */
export async function readBufferedAhead(
  mpv: { getProperty(name: string): Promise<string> },
): Promise<number> {
  try {
    const raw = await mpv.getProperty("demuxer-cache-duration");
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

const STRICT_KEY = "strict";

function SyncBadge({ hud }: { hud: SyncHudStore }): ReactElement | null {
  const ui = useSyncExternalStore(hud.subscribe, hud.get);
  if (!ui.correcting && !ui.lagging) return null;
  return (
    <div
      className={`room-ext-sync-badge${ui.lagging ? " room-ext-sync-lag" : ""}`}
      role="status"
    >
      {ui.lagging
        ? `Отставание ${Math.round(Math.abs(ui.driftSec ?? 0))} с`
        : "Синхронизация…"}
    </div>
  );
}

function LagPrompt({
  hud,
  onResync,
}: {
  hud: SyncHudStore;
  onResync: () => void;
}): ReactElement | null {
  const ui = useSyncExternalStore(hud.subscribe, hud.get);
  if (!ui.promptVisible) return null;
  return (
    <div className="room-ext-lag-prompt" role="alertdialog" aria-label="Отставание">
      <p className="room-ext-lag-text">Вы отстаёте, перемотать к группе?</p>
      <div className="room-ext-lag-actions">
        <button
          type="button"
          className="room-ext-btn room-ext-btn-primary"
          onClick={onResync}
        >
          Перемотать
        </button>
        <button
          type="button"
          className="room-ext-btn"
          onClick={() => hud.dismissPrompt(Date.now())}
        >
          Позже
        </button>
      </div>
    </div>
  );
}

function SyncSettings({ hud }: { hud: SyncHudStore }): ReactElement {
  const ui = useSyncExternalStore(hud.subscribe, hud.get);
  return (
    <section>
      <h4 className="player-menu-title">Комната · синхронизация</h4>
      <div className="player-menu-row">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={ui.strict}
          className={`player-chip${ui.strict ? " player-chip-active" : ""}`}
          onClick={() => hud.setStrict(!ui.strict)}
        >
          Строгая синхронизация
        </button>
        <span className="player-menu-item-meta">
          {ui.driftSec == null
            ? "расхождение — н/д"
            : `расхождение ${ui.driftSec >= 0 ? "+" : ""}${ui.driftSec.toFixed(1)} с`}
        </span>
      </div>
      <p className="player-menu-empty">
        Отстающим показывается подсказка «перемотать к группе». В строгом
        режиме плеер ставится на паузу, пока вы не наверстаете.
      </p>
    </section>
  );
}

export const roomSync: PlayerExtension = {
  id: "room-sync",
  name: "Синхронизация комнаты",
  setup(ctx): Unsubscribe {
    const hud = createSyncHudStore({
      strict: ctx.storage.get<boolean>(STRICT_KEY, false),
    });
    const channel: RoomChannel = roomChannel;

    let seenFirstReference = false;
    let baseSpeed = 1;
    let appliedSpeed: number | null = null;
    let autoPaused = false;

    const stopSnapshot = ctx.onSnapshot((snapshot: PlayerSnapshot) => {
      const state = channel.get();
      const session = state.session;
      if (!session) {
        if (appliedSpeed != null) {
          ctx.transport.setSpeed(baseSpeed).catch(() => {});
          appliedSpeed = null;
        }
        hud.reset();
        seenFirstReference = false;
        return;
      }

      // The user changed the speed while we were correcting — new base.
      if (
        appliedSpeed != null &&
        Math.abs(snapshot.speed - appliedSpeed) > 0.001
      ) {
        baseSpeed = snapshot.speed;
      }

      const target = state.target;
      if (!target) return;
      const expected = expectedPosition(target, Date.now());
      const driftSec = snapshot.position - expected;
      const decision = decideDrift({
        driftSec,
        isPlaying: !snapshot.pause,
        roomPlaying: target.isPlaying,
        isHost: session.isHost,
        watching: state.phase === "watching",
        firstReference: !seenFirstReference,
        expectedSec: expected,
      });
      seenFirstReference = true;

      switch (decision.kind) {
        case "align":
          void ctx.transport.seek(decision.toSec, { personal: true });
          appliedSpeed = null;
          break;
        case "correct": {
          const next = Math.round(baseSpeed * decision.factor * 1000) / 1000;
          if (appliedSpeed == null || Math.abs(appliedSpeed - next) > 0.001) {
            appliedSpeed = next;
            void ctx.transport.setSpeed(next).catch(() => {});
          }
          break;
        }
        default:
          if (appliedSpeed != null) {
            void ctx.transport.setSpeed(baseSpeed).catch(() => {});
            appliedSpeed = null;
          }
      }

      // Strict mode: the laggard pauses itself (issue #27 opt-in).
      if (
        decision.kind === "lagging" &&
        hud.get().strict &&
        !snapshot.pause &&
        !autoPaused
      ) {
        autoPaused = true;
        void ctx.transport.pause();
      }
      if (decision.kind !== "lagging") autoPaused = false;

      hud.setDecision({ decision, driftSec, now: Date.now() });
    });

    // Host: periodic drift references + buffered-ahead telemetry.
    const syncTimer = window.setInterval(() => {
      const state = channel.get();
      if (!state.session) return;
      const snapshot = ctx.getSnapshot();
      if (state.session.isHost && state.phase === "watching") {
        channel.actions.sendSyncRef(snapshot.position);
      }
    }, SYNC_REF_INTERVAL_MS);

    const bufferTimer = window.setInterval(() => {
      if (!channel.get().session) return;
      void readBufferedAhead(ctx.mpv).then((seconds) => {
        channel.setBufferedAhead(seconds);
      });
    }, BUFFER_POLL_MS);

    const stopBadge = ctx.ui.add("overlay", () => <SyncBadge hud={hud} />);
    const stopPrompt = ctx.ui.add("overlay", () => (
      <LagPrompt
        hud={hud}
        onResync={() => {
          hud.dismissPrompt(Date.now());
          channel.actions.seekToGroup();
        }}
      />
    ));
    const stopSettings = ctx.ui.add("settings.menu", () => (
      <SyncSettings hud={hud} />
    ));

    return () => {
      stopBadge();
      stopPrompt();
      stopSettings();
      stopSnapshot();
      window.clearInterval(syncTimer);
      window.clearInterval(bufferTimer);
      if (appliedSpeed != null) {
        void ctx.transport.setSpeed(baseSpeed).catch(() => {});
      }
    };
  },
};

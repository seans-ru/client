/**
 * Auto-next trigger policy (issue #20) — pure, no DOM/network. Decides when
 * the «next episode» card may appear (last N seconds or eof), tracks the
 * playback position to tell viewing from seeking (a seek into the end zone
 * must NOT trigger — «перемотка ≠ просмотр»), and computes the countdown.
 */

export const TRIGGER_MODES = ["10", "15", "30", "5p", "10p"] as const;
export type TriggerMode = (typeof TRIGGER_MODES)[number];

export const TRIGGER_MODE_LABELS: Record<TriggerMode, string> = {
  "10": "10 с",
  "15": "15 с",
  "30": "30 с",
  "5p": "5%",
  "10p": "10%",
};

export type WatchedPolicy = "offer" | "skip";

/** Grace countdown when the card appears straight at eof (seconds). */
export const EOF_GRACE_SEC = 5;
/** Forward jump larger than `expected + this` is a seek (seconds). */
export const SEEK_JUMP_SLACK_SEC = 2.5;
/** Backward move beyond this is always a seek (seconds). */
export const SEEK_BACK_SLACK_SEC = 2;

export function parseTriggerMode(raw: unknown): TriggerMode {
  return (TRIGGER_MODES as readonly string[]).includes(String(raw))
    ? (raw as TriggerMode)
    : "15";
}

export function parseWatchedPolicy(raw: unknown): WatchedPolicy {
  return raw === "skip" ? "skip" : "offer";
}

/** Trigger window width in seconds (issue: 10/15/30 s or % of duration). */
export function triggerWindowSec(durationSec: number, mode: TriggerMode): number {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  switch (mode) {
    case "10":
      return 10;
    case "15":
      return 15;
    case "30":
      return 30;
    case "5p":
      return duration > 0 ? duration * 0.05 : 15;
    case "10p":
      return duration > 0 ? duration * 0.1 : 30;
  }
}

export type PositionTrack = {
  lastPos: number;
  lastTimeMs: number;
  lastSpeed: number;
  /** True when the user seeked into the end zone — suppress the card. */
  suppress: boolean;
  /** One-shot per file: «Отмена» pressed. */
  dismissed: boolean;
};

export function createPositionTrack(): PositionTrack {
  return {
    lastPos: 0,
    lastTimeMs: 0,
    lastSpeed: 1,
    suppress: false,
    dismissed: false,
  };
}

export type TrackInput = {
  positionSec: number;
  speed: number;
  nowMs: number;
  durationSec: number;
  windowSec: number;
  eof: boolean;
};

export type TrackResult = {
  track: PositionTrack;
  /** True when this update is a seek (not natural playback advance). */
  jumped: boolean;
  /** True when the playhead sits inside the trigger window / at eof. */
  inWindow: boolean;
};

/**
 * Fold one position sample into the track. A discontinuity that lands in the
 * end zone flips `suppress` on (user dragged/jumped to the end); a jump back
 * out of the zone resets it. Natural advance never suppresses.
 */
export function trackPosition(
  track: PositionTrack,
  input: TrackInput,
): TrackResult {
  const { positionSec, speed, nowMs, durationSec, windowSec, eof } = input;
  const dtSec = track.lastTimeMs > 0 ? Math.max(0, (nowMs - track.lastTimeMs) / 1000) : 0;
  const expected = Math.max(0, speed) * dtSec;
  const delta = positionSec - track.lastPos;
  const jumped =
    track.lastTimeMs > 0 &&
    (delta > expected + SEEK_JUMP_SLACK_SEC || delta < -SEEK_BACK_SLACK_SEC);
  const inEndZone =
    eof ||
    (durationSec > 0 && positionSec >= Math.max(0, durationSec - windowSec));

  let suppress = track.suppress;
  if (jumped) suppress = inEndZone;

  return {
    track: {
      ...track,
      lastPos: positionSec,
      lastTimeMs: nowMs,
      lastSpeed: speed,
      suppress,
    },
    jumped,
    inWindow: inEndZone,
  };
}

export type OfferInput = {
  enabled: boolean;
  hasPlayableNext: boolean;
  track: PositionTrack;
  inWindow: boolean;
  remainingSec: number;
  eof: boolean;
};

/** Whether the auto-next card may be visible right now. */
export function shouldOffer(input: OfferInput): boolean {
  const { enabled, hasPlayableNext, track, inWindow, remainingSec, eof } = input;
  if (!enabled || !hasPlayableNext) return false;
  if (track.suppress || track.dismissed) return false;
  if (eof) return true;
  return inWindow && remainingSec >= -1;
}

/**
 * Countdown value for the card: seconds left to the end of the file, or the
 * eof grace when the trigger fired exactly at the end.
 */
export function countdownSeconds(
  remainingSec: number,
  eof: boolean,
): number {
  if (remainingSec > 0) return remainingSec;
  return eof ? EOF_GRACE_SEC : 0;
}

/**
 * What to do with a «watched» next episode (issue: «всё равно предлагать
 * (с пометкой) или пропускать — настройка»).
 */
export function watchedDecision(
  nextWatched: boolean,
  policy: WatchedPolicy,
): "offer" | "offer-watched" | "skip" {
  if (!nextWatched) return "offer";
  return policy === "skip" ? "skip" : "offer-watched";
}

/**
 * Pure helpers for the reactions extension (issue #28): bubble pool with a
 * hard cap, TTL and lane assignment. No React/DOM — unit-testable.
 */

/** Bubble lifetime on screen (auto-hide 2–3 s per spec). */
export const REACTION_BUBBLE_TTL_MS = 2600;

/** Max simultaneous bubbles (oldest are dropped first). */
export const REACTION_MAX_BUBBLES = 12;

/** Horizontal lanes the bubbles rise in along the video edge. */
export const REACTION_LANES = 6;

export type ReactionBubble = {
  /** Stable render key. */
  key: number;
  emoji: string;
  senderName: string | null;
  /** Lane index `0..REACTION_LANES-1`. */
  lane: number;
};

/** Append a bubble, dropping the oldest once over `max`. */
export function pushBubble(
  list: readonly ReactionBubble[],
  bubble: ReactionBubble,
  max: number = REACTION_MAX_BUBBLES,
): ReactionBubble[] {
  const next = [...list, bubble];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Remove one bubble by key (no-op when absent). */
export function dropBubble(
  list: readonly ReactionBubble[],
  key: number,
): ReactionBubble[] {
  return list.filter((bubble) => bubble.key !== key);
}

/** Pick a lane with injected randomness (0 <= n < lanes). */
export function pickLane(
  rand: () => number,
  lanes: number = REACTION_LANES,
): number {
  const n = typeof rand === "function" ? rand() : 0.5;
  const clamped = Math.min(0.999, Math.max(0, Number.isFinite(n) ? n : 0.5));
  return Math.min(lanes - 1, Math.floor(clamped * lanes));
}

/** Left offset (%) of a lane inside the reactions layer. */
export function laneLeftPercent(
  lane: number,
  lanes: number = REACTION_LANES,
): number {
  const span = 78; // keep bubbles away from the very edges
  const step = lanes > 1 ? span / (lanes - 1) : 0;
  const index = Math.min(lanes - 1, Math.max(0, Math.floor(lane)));
  return 11 + index * step;
}

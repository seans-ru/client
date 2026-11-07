import type { PlayerSnapshot } from "../playerTypes";
import type { PipFrameLayout } from "./pipVideoLayout";

export const PIP_LABEL = "player-pip";
export const PIP_REQUEST = "pip://request";
export const PIP_INIT = "pip://init";
export const PIP_STATE = "pip://state";
export const PIP_LAYOUT = "pip://layout";
export const PIP_COMMAND = "pip://command";
export const PIP_ERROR = "pip://error";
export type PipState = Pick<PlayerSnapshot, "position" | "duration" | "pause">;
export type PipInit = { framesUrl: string; state: PipState; layout: PipFrameLayout | null };
export type PipCommand = "toggle-pause" | "back" | "forward" | { type: "seek"; position: number };
export function pipState(snapshot: PlayerSnapshot): PipState {
  return { position: snapshot.position, duration: snapshot.duration, pause: snapshot.pause };
}

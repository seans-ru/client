import type { PlayerSnapshot } from "../playerTypes";

export const PIP_LABEL = "player-pip";
export const PIP_REQUEST = "pip://request";
export const PIP_INIT = "pip://init";
export const PIP_STATE = "pip://state";
export const PIP_COMMAND = "pip://command";
export const PIP_ERROR = "pip://error";
export type PipState = Pick<PlayerSnapshot, "position" | "duration" | "pause">;
export type PipInit = { framesUrl: string; state: PipState };
export type PipCommand = "toggle-pause" | "back" | "forward" | { type: "seek"; position: number };
export function pipState(snapshot: PlayerSnapshot): PipState {
  return { position: snapshot.position, duration: snapshot.duration, pause: snapshot.pause };
}

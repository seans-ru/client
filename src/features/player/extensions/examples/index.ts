/**
 * Static extension registry (spec: docs/compose/spec/player-extensibility.md
 * §S2.3). First-party only, compiled in — add a new feature by appending its
 * `PlayerExtension` here (see the recipe in §S2.10).
 */

import type { PlayerExtension } from "../types";
import { ambientLightStub } from "./ambientLightStub";
import { constantVolumeStub } from "./constantVolumeStub";

export { ambientLightStub, constantVolumeStub };

export const PLAYER_EXTENSIONS: readonly PlayerExtension[] = [
  constantVolumeStub,
  ambientLightStub,
];

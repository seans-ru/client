/**
 * Static extension registry (spec: docs/compose/spec/player-extensibility.md
 * §S2.3). First-party only, compiled in — add a new feature by appending its
 * `PlayerExtension` here (see the recipe in §S2.10).
 *
 * The example stubs in this folder are living documentation (§S2.8): they
 * stay in the codebase for future development but are NOT registered, so
 * unfinished demo rows never appear in the player UI. To try one locally,
 * add it to the list below.
 */

import type { PlayerExtension } from "../types";
import { autoHide } from "../autoHide";
import { equalizer } from "../eq";
import { volumeProcessor } from "../volumeProcessor";
import { ambientLightStub } from "./ambientLightStub";
import { constantVolumeStub } from "./constantVolumeStub";
import { pipMiniPlayer } from "../pipMiniPlayer";
import { pictureQuality } from "../pictureQuality";
import { hdr } from "../hdr";
import { debandDenoise } from "../debandDenoise";
import { roomLobby } from "../roomLobby";
import { roomSync } from "../roomSync";
import { roomTracks } from "../roomTracks";

export { ambientLightStub, constantVolumeStub, pipMiniPlayer };

export const PLAYER_EXTENSIONS: readonly PlayerExtension[] = [
  autoHide,
  volumeProcessor,
  equalizer,
  pipMiniPlayer,
  pictureQuality,
  hdr,
  debandDenoise,
  roomLobby,
  roomSync,
  roomTracks,
];

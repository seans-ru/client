/**
 * Subtitle style extension (issue #25, «Субтитры»). Applies the user's style
 * from the chrome schema to the current file via mpv `sub-*` properties — on
 * every open and on every change — and contributes a quick preset row to the
 * player settings menu (the full editor lives in the settings section).
 */

import type { ReactElement } from "react";
import {
  chromeStore,
  useChromeSchema,
} from "../../playerSettings/chromeStore";
import {
  SUBTITLE_PRESETS,
  subtitleStyleProperties,
} from "../../playerSettings/subtitleStyles";
import type { MpvBridge, PlayerExtension, Unsubscribe } from "./types";

/** Fire-and-forget: a bridge reject must never break the player. */
export function applySubtitleStyle(mpv: MpvBridge): void {
  const style = chromeStore.get().subtitles;
  for (const [name, value] of Object.entries(subtitleStyleProperties(style))) {
    void mpv.setProperty(name, value).catch(() => {});
  }
}

function SubtitlePresetRow(): ReactElement {
  const schema = useChromeSchema();
  return (
    <section>
      <h4 className="player-menu-title">Стиль субтитров</h4>
      <div className="player-menu-row">
        {SUBTITLE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="menuitemradio"
            aria-checked={schema.subtitles.presetId === preset.id}
            className={`player-chip${schema.subtitles.presetId === preset.id ? " player-chip-active" : ""}`}
            onClick={() => chromeStore.setSubtitles({ ...preset.style })}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export const subtitleStyle: PlayerExtension = {
  id: "subtitle-style",
  name: "Стиль субтитров",
  setup(ctx): Unsubscribe {
    applySubtitleStyle(ctx.mpv);
    const stopOpen = ctx.onOpen(() => applySubtitleStyle(ctx.mpv));
    const stopSchema = chromeStore.subscribe(() => applySubtitleStyle(ctx.mpv));
    const stopRow = ctx.ui.add("settings.menu", () => <SubtitlePresetRow />);
    return () => {
      stopSchema();
      stopOpen();
      stopRow();
    };
  },
};

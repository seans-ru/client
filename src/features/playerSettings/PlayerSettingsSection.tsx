/**
 * «Оформление плеера» — the player chrome settings section (issue #25):
 * live preview + subtitle styles + function toggles + button constructor.
 */

import type { ReactElement } from "react";
import "./playerSettings.css";
import { PlayerPreview } from "./PlayerPreview";
import { SubtitleEditor } from "./SubtitleEditor";
import { FeatureList } from "./FeatureList";
import { LayoutEditor } from "./LayoutEditor";

export function PlayerSettingsSection(): ReactElement {
  return (
    <section className="panel" aria-label="Оформление плеера">
      <strong>Оформление плеера</strong>
      <p className="hint">
        Живой предпросмотр хрома плеера: субтитры, функции и кнопки. Изменения
        применяются к плееру сразу.
      </p>
      <div className="ps-layout">
        <div className="ps-preview-sticky">
          <PlayerPreview />
        </div>
        <div className="ps-col">
          <SubtitleEditor />
          <FeatureList />
          <LayoutEditor />
        </div>
      </div>
    </section>
  );
}

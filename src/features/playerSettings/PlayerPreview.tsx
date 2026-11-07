/**
 * Live player-chrome mockup (issue #25, «живой предпросмотр»). Reads the same
 * chrome schema as the real player — subtitle styles, button layout and
 * function rows — and repaints on every change.
 */

import type { CSSProperties, ReactElement } from "react";
import { useChromeSchema } from "./chromeStore";
import { isFeatureEnabled } from "./featureCatalog";
import type { ChromeEntry } from "./layoutModel";
import { resolveLayout } from "./layoutModel";
import { subtitlePreviewCss } from "./subtitleStyles";
import { PreviewIcon } from "./bits";

const SLOT_LABELS: Record<string, string> = {
  "controls.primary": "Слева",
  "controls.secondary": "Справа",
  "settings.menu": "Меню",
};

export function PlayerPreview(): ReactElement {
  const schema = useChromeSchema();
  const { slots, hidden } = resolveLayout(schema);
  const subtitleCss = subtitlePreviewCss(schema.subtitles);
  const showMarkers = isFeatureEnabled(schema, "markers");
  const hiddenCount = hidden.length;

  // The gear menu mock: function rows per current settings.menu placement.
  const menuEntries = slots["settings.menu"].filter((entry) =>
    entry.kind === "function"
      ? isFeatureEnabled(schema, entry.featureId ?? entry.id)
      : true,
  );

  return (
    <div className="ps-preview">
      <div className="ps-preview-label">
        <span>Предпросмотр плеера</span>
        <span>
          {hiddenCount > 0 ? `Скрыто: ${hiddenCount} · ` : ""}
          Меню: {menuEntries.length}
        </span>
      </div>
      <div className="ps-stage">
        <div
          className="ps-stage-subtitle"
          style={{
            ...subtitleCss,
            top: `${Math.max(4, schema.subtitles.position * 0.62)}%`,
            transform: "translateY(-50%)",
          } as CSSProperties}
        >
          Субтитры выглядят так
        </div>

        <div className="ps-stage-menu" role="presentation">
          <div className="ps-stage-menu-title">Настройки</div>
          {menuEntries.length === 0 ? (
            <div className="ps-stage-menu-empty">Пусто</div>
          ) : (
            menuEntries.map((entry) => (
              <div key={entry.id} className="ps-stage-menu-item">
                <span className="ps-stage-menu-item-dot" />
                {entry.label}
              </div>
            ))
          )}
        </div>

        <div className="ps-transport">
          <div className="ps-seek">
            <div className="ps-seek-fill" />
          </div>
          {showMarkers ? (
            <div
              aria-hidden="true"
              style={{
                height: 2,
                margin: "-6px 0 2px",
                background:
                  "repeating-linear-gradient(90deg, transparent 0 22px, rgba(240,113,120,0.9) 22px 26px, transparent 26px 48px, rgba(139,124,246,0.9) 48px 52px)",
                borderRadius: 2,
              }}
            />
          ) : null}
          <div className="ps-controls">
            {slots["controls.primary"].map((entry) => (
              <PreviewControl key={entry.id} entry={entry} />
            ))}
            <div className="ps-controls-spacer" />
            {slots["controls.secondary"].map((entry) => (
              <PreviewControl key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewControl({ entry }: { entry: ChromeEntry }): ReactElement {
  if (entry.kind === "function") {
    return <span className="ps-chip">{entry.label}</span>;
  }
  if (entry.id === "btn.time") {
    return <span className="ps-time">0:12 / 1:45</span>;
  }
  if (entry.id === "btn.volume") {
    return (
      <>
        <span className="ps-icon">
          <PreviewIcon id="btn.volume" />
        </span>
        <span className="ps-vol" />
      </>
    );
  }
  return (
    <span
      className={`ps-icon${entry.id === "btn.playPause" ? " ps-icon-primary" : ""}`}
      title={entry.label}
    >
      <PreviewIcon id={entry.id} />
    </span>
  );
}

export { SLOT_LABELS };

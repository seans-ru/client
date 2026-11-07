/**
 * Subtitle style editor (issue #25, «Субтитры») with instant preview: font,
 * size, colors, outline/shadow, background, position and ASS override.
 */

import type { ReactElement } from "react";
import type { SubtitleStyle } from "./chromeSchema";
import { sanitizeFontName } from "./chromeSchema";
import { useChromeSchema, chromeStore } from "./chromeStore";
import {
  SUBTITLE_PRESETS,
  matchPreset,
} from "./subtitleStyles";
import { Toggle } from "./bits";

export function SubtitleEditor(): ReactElement {
  const schema = useChromeSchema();
  const style = schema.subtitles;

  const apply = (patch: Partial<SubtitleStyle>) => {
    const next = { ...style, ...patch };
    next.presetId = matchPreset(next);
    chromeStore.setSubtitles(next);
  };

  return (
    <div className="ps-card">
      <h3>Субтитры</h3>
      <p className="hint">
        Стиль применяется к реальным субтитрам в плеере и обновляется на лету.
      </p>

      <div className="ps-chips">
        {SUBTITLE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="ps-chip-btn"
            aria-pressed={style.presetId === preset.id}
            onClick={() =>
              chromeStore.setSubtitles({ ...preset.style })
            }
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          className="ps-chip-btn"
          aria-pressed={style.presetId === "custom"}
          disabled
          title="Появляется, когда вы изменяете значения вручную"
        >
          Пользовательский
        </button>
      </div>

      <div className="ps-field-grid">
        <label className="ps-field">
          Шрифт
          <input
            type="text"
            value={style.fontFamily}
            onChange={(event) => apply({ fontFamily: sanitizeFontName(event.target.value) })}
          />
        </label>
        <label className="ps-field">
          Размер: {style.fontSize}
          <input
            type="range"
            min={20}
            max={120}
            step={1}
            value={style.fontSize}
            onChange={(event) => apply({ fontSize: Number(event.target.value) })}
          />
        </label>

        <label className="ps-field">
          Цвет текста
          <input
            type="color"
            value={style.color}
            onChange={(event) => apply({ color: event.target.value.toUpperCase() })}
          />
        </label>
        <label className="ps-field">
          Прозрачность текста: {Math.round(style.textOpacity * 100)}%
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(style.textOpacity * 100)}
            onChange={(event) => apply({ textOpacity: Number(event.target.value) / 100 })}
          />
        </label>

        <label className="ps-field">
          Цвет обводки
          <input
            type="color"
            value={style.outlineColor}
            onChange={(event) => apply({ outlineColor: event.target.value.toUpperCase() })}
          />
        </label>
        <label className="ps-field">
          Обводка: {style.outlineWidth}
          <input
            type="range"
            min={0}
            max={12}
            step={0.5}
            value={style.outlineWidth}
            onChange={(event) => apply({ outlineWidth: Number(event.target.value) })}
          />
        </label>

        <label className="ps-field">
          Тень: {style.shadow}
          <input
            type="range"
            min={0}
            max={12}
            step={0.5}
            value={style.shadow}
            onChange={(event) => apply({ shadow: Number(event.target.value) })}
          />
        </label>
        <label className="ps-field">
          Фон
          <input
            type="color"
            value={style.backgroundColor}
            onChange={(event) =>
              apply({ backgroundColor: event.target.value.toUpperCase() })
            }
          />
        </label>

        <label className="ps-field">
          Прозрачность фона: {Math.round(style.backgroundOpacity * 100)}%
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(style.backgroundOpacity * 100)}
            onChange={(event) =>
              apply({ backgroundOpacity: Number(event.target.value) / 100 })
            }
          />
        </label>
        <label className="ps-field">
          Позиция: {style.position}
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={style.position}
            onChange={(event) => apply({ position: Number(event.target.value) })}
          />
        </label>

        <div className="ps-field ps-field-wide">
          <span>ASS-субтитры</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Toggle
              checked={style.assOverride}
              onChange={(next) => apply({ assOverride: next })}
              label="Применять стиль к ASS-субтитрам"
            />
            <span className="hint">
              {style.assOverride
                ? "Наш стиль перекрывает стили, встроенные в файл"
                : "Стили из файла сохраняются"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

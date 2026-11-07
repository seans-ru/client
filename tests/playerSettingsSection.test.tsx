/**
 * Render smoke test for the «Оформление плеера» settings section (issue #25).
 * The project has no component-test layer — this renders the section through
 * react-dom/server to prove the tree mounts, every editor wires up, and the
 * live preview reads the chrome schema without throwing.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlayerSettingsSection } from "../src/features/playerSettings/PlayerSettingsSection";
import { PlayerPreview } from "../src/features/playerSettings/PlayerPreview";
import { LayoutEditor } from "../src/features/playerSettings/LayoutEditor";

describe("PlayerSettingsSection", () => {
  it("renders the section with subtitles, features and layout editors", () => {
    const html = renderToStaticMarkup(<PlayerSettingsSection />);
    expect(html).toContain("Оформление плеера");
    expect(html).toContain("Субтитры");
    expect(html).toContain("Функции");
    expect(html).toContain("Кнопки");
    expect(html).toContain("Сбросить раскладку");
    // Feature rows from the catalog.
    expect(html).toContain("Эквалайзер");
    expect(html).toContain("Обработка звука");
    expect(html).toContain("Автоскрытие контролов");
    expect(html).toContain("Стиль субтитров");
    expect(html).toContain("Статистика воспроизведения");
    expect(html).toContain("Маркеры сегментов");
    // Subtitle presets.
    expect(html).toContain("Классический");
    expect(html).toContain("Контрастный");
    expect(html).toContain("Крупный");
  });

  it("preview paints the chrome mockup with the default layout buttons", () => {
    const html = renderToStaticMarkup(<PlayerPreview />);
    expect(html).toContain("Предпросмотр плеера");
    expect(html).toContain("Субтитры выглядят так");
    expect(html).toContain("0:12 / 1:45");
    expect(html).toContain("ps-seek");
  });

  it("layout editor lists every catalog entry exactly once", () => {
    const html = renderToStaticMarkup(<LayoutEditor />);
    const names = [...html.matchAll(/ps-token-name">([^<]+)</g)].map(
      (match) => match[1],
    );
    expect(names.sort()).toEqual(
      [
        "Автоскрытие контролов",
        "Боковая панель",
        "Воспроизведение / Пауза",
        "Время",
        "Громкость",
        "Меню настроек",
        "Обработка звука",
        "Полный экран",
        "Стиль субтитров",
        "Эквалайзер",
      ].sort(),
    );
  });
});

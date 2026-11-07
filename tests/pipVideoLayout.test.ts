import { describe, expect, it } from "vitest";
import { parsePipFrameLayout, pipCanvasRect } from "../src/features/player/extensions/pipVideoLayout";

const frame = { width: 1920, height: 1200 };
const layout = { ...frame, left: 0, right: 0, top: 60, bottom: 60 };

describe("масштабирование изображения PiP", () => {
  it("заполняет окно 16:9, исключая поля основного рендера", () => {
    expect(pipCanvasRect({ width: 480, height: 270 }, frame, layout)).toEqual({ left: 0, top: -15, width: 480, height: 300 });
  });
  it("оставляет только верхнее и нижнее поля при несовпадении пропорций", () => {
    const rect = pipCanvasRect({ width: 400, height: 400 }, frame, layout)!;
    expect(rect.width).toBe(400);
    expect(rect.height).toBe(250);
    const imageTop = rect.top + layout.top * rect.width / frame.width;
    expect(imageTop).toBe(87.5);
    expect(400 - (imageTop + 1080 * rect.width / frame.width)).toBe(87.5);
  });
  it("убирает одновременно боковые и вертикальные поля из исходного кадра", () => {
    const source = { width: 1280, height: 800 };
    const margins = { ...source, left: 72, right: 72, top: 80, bottom: 81 };
    const rect = pipCanvasRect({ width: 480, height: 270 }, source, margins)!;
    const scale = rect.width / source.width;
    expect(rect.left + margins.left * scale).toBeCloseTo(0);
    expect(rect.top + margins.top * scale).toBeCloseTo(0);
    expect((source.width - margins.left - margins.right) * scale).toBeCloseTo(480);
    expect((source.height - margins.top - margins.bottom) * scale).toBeCloseTo(270);
  });
  it("добавляет только боковые поля для вертикального видео", () => {
    const source = { width: 800, height: 1200 };
    const rect = pipCanvasRect({ width: 300, height: 300 }, source, { ...source, left: 200, right: 200, top: 0, bottom: 0 })!;
    expect(rect).toEqual({ left: 50, top: 0, width: 200, height: 300 });
  });
  it("не применяет устаревшие поля после изменения размера рендера", () => {
    expect(pipCanvasRect({ width: 480, height: 270 }, { width: 1920, height: 1080 }, layout)).toEqual({ left: 0, top: 0, width: 480, height: 270 });
  });
  it("без геометрии сохраняет пропорции целого кадра", () => {
    expect(pipCanvasRect({ width: 480, height: 270 }, frame, null)).toEqual({ left: 24, top: 0, width: 432, height: 270 });
    expect(pipCanvasRect({ width: 0, height: 270 }, frame, layout)).toBeNull();
  });
  it("проверяет полученные от mpv размеры и поля", () => {
    expect(parsePipFrameLayout("1920,1200,0,0,60,60")).toEqual(layout);
    for (const value of [null, "", "0,0,0,0,0,0", "1920,1200,-1,0,0,0", "1920,1200,960,960,0,0", "1920,1200,0,0,NaN,0", "1920,1200,0,0,0", "1920,1200,0,0,,0"]) expect(parsePipFrameLayout(value)).toBeNull();
  });
});

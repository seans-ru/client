import { describe, expect, it } from "vitest";
import { parsePipFrameLayout, pipCanvasRect, pipContentAspect, pipResizeFrame } from "../src/features/player/extensions/pipVideoLayout";

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

describe("пропорции изображения", () => {
  it("использует изображение без полей mpv", () => {
    expect(pipContentAspect(frame, layout)).toBeCloseTo(1920 / 1080);
  });
  it("без геометрии берёт весь кадр, до кадра — null", () => {
    expect(pipContentAspect(frame, null)).toBeCloseTo(1920 / 1200);
    expect(pipContentAspect({ width: 0, height: 0 }, layout)).toBeNull();
  });
  it("игнорирует поля другого размера кадра", () => {
    expect(pipContentAspect({ width: 1280, height: 720 }, layout)).toBeCloseTo(1280 / 720);
  });
});

describe("resize окна с пропорциями изображения", () => {
  const start = { x: 100, y: 50, width: 480, height: 240 };
  const aspect = 2;

  it("правый край тянет ширину, высота следует за пропорциями", () => {
    expect(pipResizeFrame(start, { dx: 80, dy: 0 }, "East", aspect)).toEqual({ x: 100, y: 30, width: 560, height: 280 });
  });
  it("левый край сохраняет правую границу", () => {
    const next = pipResizeFrame(start, { dx: -80, dy: 0 }, "West", aspect);
    expect(next).toEqual({ x: 20, y: 30, width: 560, height: 280 });
    expect(next.x + next.width).toBe(start.x + start.width);
  });
  it("верхний край сохраняет нижнюю границу", () => {
    const next = pipResizeFrame(start, { dx: 0, dy: -40 }, "North", aspect);
    expect(next).toEqual({ x: 60, y: 10, width: 560, height: 280 });
    expect(next.y + next.height).toBe(start.y + start.height);
  });
  it("угол ведёт ось с большим относительным смещением", () => {
    expect(pipResizeFrame(start, { dx: 80, dy: 4 }, "SouthEast", aspect)).toEqual({ x: 100, y: 50, width: 560, height: 280 });
    expect(pipResizeFrame(start, { dx: 4, dy: 80 }, "SouthEast", aspect)).toEqual({ x: 100, y: 50, width: 640, height: 320 });
  });
  it("не даёт сжаться ниже минимума, сохраняя пропорции и опорный угол", () => {
    const next = pipResizeFrame(start, { dx: 400, dy: 200 }, "NorthWest", aspect);
    expect(next).toEqual({ x: 264, y: 132, width: 316, height: 158 });
    expect(next.width / next.height).toBeCloseTo(aspect);
  });
  it("при неизвестных пропорциях сохраняет текущие", () => {
    const next = pipResizeFrame(start, { dx: 40, dy: 0 }, "East", Number.NaN);
    expect(next.width / next.height).toBeCloseTo(start.width / start.height);
  });
});

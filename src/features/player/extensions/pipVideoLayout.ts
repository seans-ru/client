/** Геометрия изображения внутри RGBA-кадра mpv, включая поля основного окна. */
export type PipFrameLayout = { width: number; height: number; left: number; right: number; top: number; bottom: number };

/** Минимальный размер окна мини-плеера (совпадает с minWidth/minHeight webview). */
export const PIP_MIN_WIDTH = 280;
export const PIP_MIN_HEIGHT = 158;

export type PipResizeEdge = "North" | "NorthEast" | "East" | "SouthEast" | "South" | "SouthWest" | "West" | "NorthWest";

export function parsePipFrameLayout(value: string | null): PipFrameLayout | null {
  const fields = value?.split(",");
  if (!fields || fields.length !== 6 || fields.some(field => field.trim() === "")) return null;
  const [width, height, left, right, top, bottom] = fields.map(Number);
  if (![width, height, left, right, top, bottom].every(Number.isFinite) || width <= 0 || height <= 0 || Math.min(left, right, top, bottom) < 0 || left + right >= width || top + bottom >= height) return null;
  return { width, height, left, right, top, bottom };
}

/** Поля mpv, привязанные к кадру; при несовпадении размера кадра полей нет. */
function contentBox(frame: { width: number; height: number }, layout: PipFrameLayout | null) {
  const matching = layout && layout.width === frame.width && layout.height === frame.height ? layout : null;
  return {
    left: matching?.left ?? 0,
    top: matching?.top ?? 0,
    right: matching?.right ?? 0,
    bottom: matching?.bottom ?? 0,
  };
}

/** Соотношение сторон самого изображения (без полей mpv); null, пока кадр неизвестен. */
export function pipContentAspect(
  frame: { width: number; height: number },
  layout: PipFrameLayout | null,
): number | null {
  if (![frame.width, frame.height].every(value => Number.isFinite(value) && value > 0)) return null;
  const box = contentBox(frame, layout);
  const width = frame.width - box.left - box.right;
  const height = frame.height - box.top - box.bottom;
  return width > 0 && height > 0 ? width / height : null;
}

/** Масштабируем только изображение, вынося встроенные mpv-поля за границы PiP. */
export function pipCanvasRect(
  viewport: { width: number; height: number },
  frame: { width: number; height: number },
  layout: PipFrameLayout | null,
): { left: number; top: number; width: number; height: number } | null {
  if (![viewport.width, viewport.height, frame.width, frame.height].every(value => Number.isFinite(value) && value > 0)) return null;
  const box = contentBox(frame, layout);
  const contentWidth = frame.width - box.left - box.right;
  const contentHeight = frame.height - box.top - box.bottom;
  const scale = Math.min(viewport.width / contentWidth, viewport.height / contentHeight);
  return {
    left: (viewport.width - contentWidth * scale) / 2 - box.left * scale,
    top: (viewport.height - contentHeight * scale) / 2 - box.top * scale,
    width: frame.width * scale,
    height: frame.height * scale,
  };
}

/**
 * Прямоугольник окна при перетаскивании края/угла: одна сторона следует за
 * курсором, вторая — за пропорциями изображения, чёрные поля не появляются.
 * Опорный край/угол остаётся неподвижным.
 */
export function pipResizeFrame(
  start: { x: number; y: number; width: number; height: number },
  delta: { dx: number; dy: number },
  edge: PipResizeEdge,
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : start.width / start.height;
  const east = edge.includes("East");
  const west = edge.includes("West");
  const north = edge.includes("North");
  const south = edge.includes("South");
  const dragX = east || west;
  const dragY = north || south;
  const relX = Math.abs(delta.dx) / Math.max(1, start.width);
  const relY = Math.abs(delta.dy) / Math.max(1, start.height);
  // Угол ведёт ось с большим относительным смещением; край — свою ось.
  const width = dragX && (!dragY || relX >= relY)
    ? start.width + (east ? delta.dx : -delta.dx)
    : (start.height + (south ? delta.dy : -delta.dy)) * ratio;
  const clamped = Math.max(width, PIP_MIN_WIDTH, PIP_MIN_HEIGHT * ratio);
  const height = clamped / ratio;
  const x = west ? start.x + start.width - clamped : east ? start.x : start.x + (start.width - clamped) / 2;
  const y = north ? start.y + start.height - height : south ? start.y : start.y + (start.height - height) / 2;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(clamped), height: Math.round(height) };
}

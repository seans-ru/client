/** Геометрия изображения внутри RGBA-кадра mpv, включая поля основного окна. */
export type PipFrameLayout = { width: number; height: number; left: number; right: number; top: number; bottom: number };

export function parsePipFrameLayout(value: string | null): PipFrameLayout | null {
  const fields = value?.split(",");
  if (!fields || fields.length !== 6 || fields.some(field => field.trim() === "")) return null;
  const [width, height, left, right, top, bottom] = fields.map(Number);
  if (![width, height, left, right, top, bottom].every(Number.isFinite) || width <= 0 || height <= 0 || Math.min(left, right, top, bottom) < 0 || left + right >= width || top + bottom >= height) return null;
  return { width, height, left, right, top, bottom };
}

/** Масштабируем только изображение, вынося встроенные mpv-поля за границы PiP. */
export function pipCanvasRect(
  viewport: { width: number; height: number },
  frame: { width: number; height: number },
  layout: PipFrameLayout | null,
): { left: number; top: number; width: number; height: number } | null {
  if (![viewport.width, viewport.height, frame.width, frame.height].every(value => Number.isFinite(value) && value > 0)) return null;
  const matching = layout && layout.width === frame.width && layout.height === frame.height ? layout : null;
  const left = matching?.left ?? 0;
  const top = matching?.top ?? 0;
  const contentWidth = frame.width - left - (matching?.right ?? 0);
  const contentHeight = frame.height - top - (matching?.bottom ?? 0);
  const scale = Math.min(viewport.width / contentWidth, viewport.height / contentHeight);
  return {
    left: (viewport.width - contentWidth * scale) / 2 - left * scale,
    top: (viewport.height - contentHeight * scale) / 2 - top * scale,
    width: frame.width * scale,
    height: frame.height * scale,
  };
}

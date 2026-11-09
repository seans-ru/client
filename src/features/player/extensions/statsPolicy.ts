/**
 * Stats overlay metric model (issue #18) — pure formatting, unit-tested.
 *
 * Values come from `ctx.mpv.getProperty`; a failed / empty read renders as
 * an em dash («—») and never logs. Display formats are tuned for a compact
 * "stats for nerds" panel.
 */

/** One row of the stats panel. */
export type StatMetricDef = {
  id: string;
  label: string;
  /**
   * mpv property names tried in order (first successful read wins).
   * `@snapshot:*` entries are filled from the player snapshot instead of a
   * property read — cheaper and always available.
   */
  properties: readonly string[];
};

export const DASH = "—";

export const STATS_METRICS: readonly StatMetricDef[] = [
  { id: "videoCodec", label: "Видео", properties: ["video-codec"] },
  { id: "audioCodec", label: "Аудио", properties: ["audio-codec"] },
  {
    id: "resolution",
    label: "Разрешение",
    properties: ["video-params/w", "width"],
  },
  {
    id: "resolutionH",
    label: "",
    properties: ["video-params/h", "height"],
  },
  { id: "fpsSource", label: "FPS (источник)", properties: ["container-fps"] },
  { id: "fpsDisplay", label: "FPS (отображение)", properties: ["estimated-vf-fps"] },
  { id: "frameDrops", label: "Пропуски кадров", properties: ["frame-drop-count"] },
  { id: "hwdec", label: "Декодирование", properties: ["hwdec-current", "@snapshot:hwdec"] },
  { id: "vo", label: "Вывод (vo)", properties: ["current-vo", "@snapshot:vo"] },
  { id: "videoBitrate", label: "Битрейт видео", properties: ["video-bitrate"] },
  { id: "audioBitrate", label: "Битрейт аудио", properties: ["audio-bitrate"] },
  { id: "demuxerBitrate", label: "Битрейт (demuxer)", properties: ["demuxer-bitrate"] },
  { id: "buffer", label: "Буфер", properties: ["demuxer-cache-duration"] },
  { id: "position", label: "Позиция", properties: ["time-pos", "@snapshot:position"] },
  { id: "speed", label: "Скорость", properties: ["speed", "@snapshot:speed"] },
  { id: "mpvVersion", label: "mpv", properties: ["mpv-version"] },
];

/** All `@snapshot:` markers stripped — the set of real property reads. */
export const STATS_PROPERTY_NAMES: readonly string[] = [
  ...new Set(
    STATS_METRICS.flatMap((m) =>
      m.properties.filter((p) => !p.startsWith("@snapshot:")),
    ),
  ),
];

function isBlank(raw: string | null | undefined): boolean {
  return String(raw ?? "").trim().length === 0;
}

/** `23.976024` → `23.98`; `60/1` is passed through untouched. */
export function formatFps(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  if (!v || v === "0") return DASH;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return v;
  return n.toFixed(2);
}

/** mpv bitrates are bits/s (`"1234567"` → `1.24 Мбит/с`). */
export function formatBitrate(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  if (!v) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DASH;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} Мбит/с`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} кбит/с`;
  return `${Math.round(n)} бит/с`;
}

/** `123.456` → `2:03`; integer-ish cache durations keep one decimal. */
export function formatSeconds(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  if (!v) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  const total = Math.max(0, Math.floor(n));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Buffer line: `12.4 с`. */
export function formatBuffer(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  if (!v) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DASH;
  return `${n.toFixed(1)} с`;
}

/** `1.234` → `1.23×`; `1` → `1.00×`. */
export function formatSpeed(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  if (!v) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  return `${n.toFixed(2)}×`;
}

/** Truncate long codec strings («h264 (High) (avc1 / 0x31637661)»). */
export function formatCodec(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  if (!v) return DASH;
  return v.length > 42 ? `${v.slice(0, 41)}…` : v;
}

export function formatFrameCount(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  if (!v) return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return DASH;
  return String(Math.trunc(n));
}

/** Generic raw value with dash fallback. */
export function formatRaw(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  return v.length > 0 ? v : DASH;
}

const FORMATTERS: Record<string, (raw: string | null | undefined) => string> = {
  videoCodec: formatCodec,
  audioCodec: formatCodec,
  fpsSource: formatFps,
  fpsDisplay: formatFps,
  frameDrops: formatFrameCount,
  videoBitrate: formatBitrate,
  audioBitrate: formatBitrate,
  demuxerBitrate: formatBitrate,
  buffer: formatBuffer,
  position: formatSeconds,
  speed: formatSpeed,
};

/** Format one metric by id (dash for blank / unreadable values). */
export function formatMetric(id: string, raw: string | null | undefined): string {
  if (isBlank(raw)) return DASH;
  const formatter = FORMATTERS[id] ?? formatRaw;
  return formatter(raw);
}

/** `w` + `h` reads → `1920×1080`; partial data degrades gracefully. */
export function formatResolution(
  w: string | null | undefined,
  h: string | null | undefined,
): string {
  const wn = Number(String(w ?? "").trim());
  const hn = Number(String(h ?? "").trim());
  const okW = Number.isFinite(wn) && wn > 0;
  const okH = Number.isFinite(hn) && hn > 0;
  if (okW && okH) return `${Math.round(wn)}×${Math.round(hn)}`;
  if (okW) return `${Math.round(wn)}×?`;
  if (okH) return `?×${Math.round(hn)}`;
  return DASH;
}

/**
 * Build `id -> raw` from property reads. `resolution` merges two property
 * reads (`video-params/w` + `video-params/h`) into one display value.
 */
export function resolveMetricValues(input: {
  /** Successful property reads (`prop -> value`); failures are absent. */
  props: Record<string, string | null | undefined>;
  /** Snapshot fallbacks (`hwdec`, `vo`, `position`, `speed`, `video_w/h`). */
  snapshot?: {
    hwdec?: string;
    vo?: string;
    position?: number;
    speed?: number;
    video_w?: number;
    video_h?: number;
  };
}): Map<string, string> {
  const { props, snapshot } = input;
  const out = new Map<string, string>();
  for (const metric of STATS_METRICS) {
    if (metric.id === "resolutionH") continue;
    if (metric.id === "resolution") {
      const w = props["video-params/w"] ?? props.width;
      const h = props["video-params/h"] ?? props.height;
      const sw = snapshot?.video_w;
      const sh = snapshot?.video_h;
      out.set(
        "resolution",
        formatResolution(
          w ?? (sw && sw > 0 ? String(sw) : undefined),
          h ?? (sh && sh > 0 ? String(sh) : undefined),
        ),
      );
      continue;
    }
    let raw: string | null | undefined;
    for (const property of metric.properties) {
      if (property.startsWith("@snapshot:")) {
        const field = property.slice("@snapshot:".length);
        const value = snapshot?.[field as keyof NonNullable<typeof snapshot>];
        if (value !== undefined && value !== null && value !== "") {
          raw = typeof value === "number" ? String(value) : value;
          break;
        }
      } else if (props[property] != null && String(props[property]).length > 0) {
        raw = props[property];
        break;
      }
    }
    out.set(metric.id, formatMetric(metric.id, raw));
  }
  return out;
}

/** Plain-text block for the «копировать» button (stable row order). */
export function metricsToClipboardText(values: Map<string, string>): string {
  const lines: string[] = [];
  for (const metric of STATS_METRICS) {
    if (metric.id === "resolutionH") continue;
    const value = values.get(metric.id) ?? DASH;
    if (metric.label) {
      lines.push(`${metric.label}: ${value}`);
    }
  }
  return lines.join("\n");
}

/** Copy helper with a `document.execCommand` fallback (WebView2 quirks). */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const doc = globalThis.document;
    if (!doc?.body) return false;
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand?.("copy") ?? false;
    doc.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

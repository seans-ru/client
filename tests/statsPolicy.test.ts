import { describe, expect, it } from "vitest";
import {
  DASH,
  formatBitrate,
  formatBuffer,
  formatCodec,
  formatFps,
  formatFrameCount,
  formatMetric,
  formatRaw,
  formatResolution,
  formatSeconds,
  formatSpeed,
  metricsToClipboardText,
  resolveMetricValues,
  STATS_METRICS,
  STATS_PROPERTY_NAMES,
} from "../src/features/player/extensions/statsPolicy";

describe("formatters", () => {
  it("formats fps to two decimals and dashes junk", () => {
    expect(formatFps("23.976024")).toBe("23.98");
    expect(formatFps("60")).toBe("60.00");
    expect(formatFps("0")).toBe(DASH);
    expect(formatFps("")).toBe(DASH);
    expect(formatFps(null)).toBe(DASH);
  });

  it("formats bitrates in human units", () => {
    expect(formatBitrate("1234567")).toBe("1.23 Мбит/с");
    expect(formatBitrate("320000")).toBe("320 кбит/с");
    expect(formatBitrate("800")).toBe("800 бит/с");
    expect(formatBitrate("0")).toBe(DASH);
    expect(formatBitrate(null)).toBe(DASH);
  });

  it("formats seconds as mm:ss / h:mm:ss", () => {
    expect(formatSeconds("0")).toBe("0:00");
    expect(formatSeconds("123.4")).toBe("2:03");
    expect(formatSeconds("3723")).toBe("1:02:03");
    expect(formatSeconds("")).toBe(DASH);
    expect(formatSeconds("abc")).toBe(DASH);
  });

  it("formats buffer, speed, codecs and frame counts", () => {
    expect(formatBuffer("12.456")).toBe("12.5 с");
    expect(formatBuffer("0")).toBe(DASH);
    expect(formatSpeed("1.234")).toBe("1.23×");
    expect(formatSpeed("1")).toBe("1.00×");
    expect(formatCodec("h264 (High) (avc1 / 0x31637661)")).toContain("h264");
    expect(formatCodec("x".repeat(50)).length).toBe(42);
    expect(formatFrameCount("17")).toBe("17");
    expect(formatRaw("libmpv2")).toBe("libmpv2");
    expect(formatRaw("  ")).toBe(DASH);
  });

  it("formats resolution with graceful partials", () => {
    expect(formatResolution("1920", "1080")).toBe("1920×1080");
    expect(formatResolution("1920", undefined)).toBe("1920×?");
    expect(formatResolution(undefined, "1080")).toBe("?×1080");
    expect(formatResolution("", "")).toBe(DASH);
  });

  it("routes metric ids through their formatters and dashes blanks", () => {
    expect(formatMetric("fpsSource", "29.97")).toBe("29.97");
    expect(formatMetric("frameDrops", "0")).toBe("0");
    expect(formatMetric("videoCodec", "")).toBe(DASH);
    expect(formatMetric("hwdec", "no")).toBe("no");
    expect(formatMetric("position", "65")).toBe("1:05");
    expect(formatMetric("unknown-id", "raw")).toBe("raw");
  });
});

describe("resolveMetricValues", () => {
  it("merges property reads and snapshot fallbacks", () => {
    const values = resolveMetricValues({
      props: {
        "video-codec": "h264",
        "audio-codec": "aac",
        "video-params/w": "1280",
        "video-params/h": "720",
        "container-fps": "24",
        "frame-drop-count": "3",
      },
      snapshot: {
        hwdec: "d3d11va",
        vo: "libmpv",
        position: 42.2,
        speed: 1.5,
        video_w: 1280,
        video_h: 720,
      },
    });
    expect(values.get("videoCodec")).toBe("h264");
    expect(values.get("resolution")).toBe("1280×720");
    expect(values.get("fpsSource")).toBe("24.00");
    expect(values.get("frameDrops")).toBe("3");
    expect(values.get("hwdec")).toBe("d3d11va");
    expect(values.get("vo")).toBe("libmpv");
    expect(values.get("position")).toBe("0:42");
    expect(values.get("speed")).toBe("1.50×");
  });

  it("falls back to the snapshot resolution when properties fail", () => {
    const values = resolveMetricValues({
      props: {},
      snapshot: { video_w: 1920, video_h: 1080 },
    });
    expect(values.get("resolution")).toBe("1920×1080");
    expect(values.get("videoCodec")).toBe(DASH);
    expect(values.get("mpvVersion")).toBe(DASH);
  });

  it("prefers video-params over width/height", () => {
    const values = resolveMetricValues({
      props: {
        "video-params/w": "100",
        "video-params/h": "50",
        width: "999",
        height: "999",
      },
    });
    expect(values.get("resolution")).toBe("100×50");
  });
});

describe("clipboard text", () => {
  it("lists every labeled metric in stable order", () => {
    const values = new Map(STATS_METRICS.map((m) => [m.id, `v-${m.id}`]));
    const text = metricsToClipboardText(values);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Видео: v-videoCodec");
    expect(lines.some((l) => l.startsWith("Разрешение:"))).toBe(true);
    // The height helper row must not leak into the clipboard.
    expect(lines).toHaveLength(STATS_METRICS.filter((m) => m.id !== "resolutionH").length);
  });
});

describe("property name set", () => {
  it("collects unique real mpv properties (no snapshot markers)", () => {
    expect(STATS_PROPERTY_NAMES).toContain("video-codec");
    expect(STATS_PROPERTY_NAMES).toContain("mpv-version");
    expect(STATS_PROPERTY_NAMES.every((p) => !p.startsWith("@snapshot:"))).toBe(true);
    expect(new Set(STATS_PROPERTY_NAMES).size).toBe(STATS_PROPERTY_NAMES.length);
  });
});

import { describe, expect, it } from "vitest";
import {
  applySubtitleStyle,
  subtitleStyle,
} from "../src/features/player/extensions/subtitleStyle";
import { createExtensionRuntime } from "../src/features/player/extensions/registry";
import type { MpvBridge } from "../src/features/player/extensions/types";
import { DEFAULT_SUBTITLE_STYLE } from "../src/features/playerSettings/chromeSchema";

function makeMpv(): MpvBridge & { calls: [string, string | number | boolean][] } {
  const calls: [string, string | number | boolean][] = [];
  return {
    calls,
    getProperty: async () => "",
    setProperty: async (name, value) => {
      calls.push([name, value]);
    },
    command: async () => null,
  };
}

describe("applySubtitleStyle", () => {
  it("writes the schema style to mpv sub-* properties", () => {
    const mpv = makeMpv();
    applySubtitleStyle(mpv);
    const asMap = new Map(mpv.calls);
    expect(asMap.get("sub-font")).toBe(DEFAULT_SUBTITLE_STYLE.fontFamily);
    expect(asMap.get("sub-font-size")).toBe(DEFAULT_SUBTITLE_STYLE.fontSize);
    expect(asMap.get("sub-color")).toBe("&H00FFFFFF");
    expect(asMap.get("sub-border-size")).toBe(3);
    expect(asMap.get("sub-pos")).toBe(100);
    expect(asMap.get("sub-ass-override")).toBe("force");
    // Never touches the bridge deny-listed properties.
    for (const [name] of mpv.calls) {
      expect(["wid", "vo", "gpu-context", "init-options"]).not.toContain(name);
    }
  });

  it("re-applies the style on file open and contributes the preset row", () => {
    const mpv = makeMpv();
    const runtime = createExtensionRuntime([subtitleStyle], {
      transport: {
        play: async () => {},
        pause: async () => {},
        togglePause: async () => {},
        seek: async () => {},
        setSpeed: async () => {},
        setVolume: async () => {},
        setMute: async () => {},
        setFullscreen: async () => {},
      },
      getSnapshot: () => {
        throw new Error("not used");
      },
      mpv,
      frames: { subscribe: () => () => {} },
      storageFor: () => ({ get: (_k, fallback) => fallback, set: () => {} }),
      setChromeHidden: () => {},
    });

    mpv.calls.length = 0;
    runtime.notifyOpen({ url: "file:///a.mkv", startAt: null, source: "vod" });
    expect(mpv.calls.some(([name]) => name === "sub-font")).toBe(true);

    const rows = runtime.getSlotEntries("settings.menu");
    expect(rows).toHaveLength(1);
    expect(typeof rows[0].render()).toBe("object");
    runtime.dispose();
  });
});

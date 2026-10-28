import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type TauriConf = {
  productName: string;
  version: string;
  identifier: string;
  mainBinaryName?: string;
  app: {
    windows: Array<{
      label?: string;
      title?: string;
      width: number;
      height: number;
      minWidth?: number;
      minHeight?: number;
    }>;
  };
  bundle?: {
    publisher?: string;
    copyright?: string;
  };
  plugins: Record<string, unknown>;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8")) as TauriConf;

describe("tauri.conf.json identity", () => {
  it("uses identifier ru.tedeshi.seans", () => {
    expect(conf.identifier).toBe("ru.tedeshi.seans");
  });

  it("uses productName Seans and version 0.1.0", () => {
    expect(conf.productName).toBe("Seans");
    expect(conf.version).toBe("0.1.0");
  });

  it("names the main binary seans", () => {
    expect(conf.mainBinaryName).toBe("seans");
  });

  it("has a single main window 1280x800 with min 960x600", () => {
    expect(conf.app.windows).toHaveLength(1);
    const win = conf.app.windows[0];
    expect(win.width).toBe(1280);
    expect(win.height).toBe(800);
    expect(win.minWidth).toBe(960);
    expect(win.minHeight).toBe(600);
  });

  it("registers deep-link and single-instance plugins", () => {
    expect(Object.keys(conf.plugins)).toContain("deep-link");
    expect(Object.keys(conf.plugins)).toContain("single-instance");
  });

  it("registers the updater plugin with the Seans update endpoint", () => {
    expect(Object.keys(conf.plugins)).toContain("updater");
    const updater = conf.plugins["updater"] as {
      endpoints?: string[];
      pubkey?: string;
    };
    expect(Array.isArray(updater.endpoints)).toBe(true);
    expect(updater.endpoints?.[0]).toBe(
      "https://seans.tedeshi.ru/updates/latest.json",
    );
    // Pinned release signing key (matches keys/tauri-updater.key, private half in CI secrets).
    expect(typeof updater.pubkey).toBe("string");
    expect(updater.pubkey?.length ?? 0).toBeGreaterThan(0);
  });

  it("registers the seans scheme for desktop deep links", () => {
    const deepLink = conf.plugins["deep-link"] as {
      desktop?: { schemes?: string[] };
    };
    expect(deepLink.desktop?.schemes).toContain("seans");
  });

  it("sets Windows VersionInfo fields for later Authenticode", () => {
    // tauri-build embeds PE VersionInfo from these fields:
    // CompanyName=bundle.publisher, ProductName, File/ProductVersion=version.
    expect(conf.bundle?.publisher).toBe("tedeshi");
    expect(conf.bundle?.copyright).toBe("tedeshi");
    expect(conf.productName).toBe("Seans");
    expect(conf.version).toBe("0.1.0");
  });
});

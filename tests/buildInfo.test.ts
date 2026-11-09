import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config";
import { formatAppVersionLabel } from "../src/lib/buildInfo";

describe("formatAppVersionLabel", () => {
  it("shows the commit next to the version", () => {
    expect(formatAppVersionLabel("0.1.0", "86bc520")).toBe("0.1.0 (86bc520)");
  });

  it("omits the commit when it is unknown (build without git)", () => {
    expect(formatAppVersionLabel("0.1.0", "")).toBe("0.1.0");
    expect(formatAppVersionLabel("0.1.0", "unknown")).toBe("0.1.0 (unknown)");
  });

  it("keeps the unavailable fallback outside the Tauri shell", () => {
    expect(formatAppVersionLabel(null, "86bc520")).toBe("недоступна (86bc520)");
    expect(formatAppVersionLabel(null, "")).toBe("недоступна");
  });
});

describe("vite build identity (issue #73)", () => {
  it("defines import.meta.env.VITE_APP_COMMIT as a short hash or empty", () => {
    const define = viteConfig.define as Record<string, string>;
    const injected = define["import.meta.env.VITE_APP_COMMIT"];
    expect(typeof injected).toBe("string");
    expect(JSON.parse(injected) as string).toMatch(/^([0-9a-f]{7,40})?$/);
  });
});

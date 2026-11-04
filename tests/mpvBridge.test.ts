import { describe, expect, it } from "vitest";
import { preparePropertyWrite } from "../src/features/player/bridge/mpvBridge";

describe("preparePropertyWrite (bridge validation)", () => {
  it("rejects reserved render-surface property names", () => {
    for (const name of ["wid", "vo", "gpu-context", "init-options"]) {
      expect(() => preparePropertyWrite(name, 1)).toThrow("property is reserved");
      expect(() => preparePropertyWrite(name, "x")).toThrow(
        "property is reserved",
      );
      expect(() => preparePropertyWrite(name, true)).toThrow(
        "property is reserved",
      );
    }
  });

  it("rejects empty property names", () => {
    expect(() => preparePropertyWrite("", 1)).toThrow("property name is empty");
  });

  it("allows normal property names", () => {
    expect(preparePropertyWrite("af", "loudnorm")).toEqual({
      name: "af",
      kind: "string",
      value: "loudnorm",
    });
    expect(preparePropertyWrite("volume", 50).name).toBe("volume");
    expect(preparePropertyWrite("mute", true).name).toBe("mute");
  });

  it("classifies value kinds like the Rust untagged enum", () => {
    expect(preparePropertyWrite("af", "loudnorm").kind).toBe("string");
    expect(preparePropertyWrite("speed", 1.5).kind).toBe("double");
    expect(preparePropertyWrite("pause", true).kind).toBe("flag");
  });

  it("rejects non-finite numbers", () => {
    expect(() => preparePropertyWrite("speed", Number.NaN)).toThrow(
      "property value must be string, number or boolean",
    );
    expect(() => preparePropertyWrite("speed", Number.POSITIVE_INFINITY)).toThrow(
      "property value must be string, number or boolean",
    );
    expect(() => preparePropertyWrite("speed", Number.NEGATIVE_INFINITY)).toThrow(
      "property value must be string, number or boolean",
    );
  });

  it("rejects values outside string | number | boolean", () => {
    expect(() =>
      preparePropertyWrite("af", { nested: true } as unknown as number),
    ).toThrow("property value must be string, number or boolean");
    expect(() =>
      preparePropertyWrite("af", null as unknown as number),
    ).toThrow("property value must be string, number or boolean");
    expect(() =>
      preparePropertyWrite("af", undefined as unknown as number),
    ).toThrow("property value must be string, number or boolean");
  });
});

/**
 * Universal mpv bridge (spec: docs/compose/spec/player-extensibility.md §S2.5).
 *
 * Thin invoke wrappers over the generic Rust commands (`player_get_property` /
 * `player_set_property` / `player_command`) so extensions can reach any mpv
 * feature without new Tauri commands. Validation is a pure, unit-tested step
 * (`preparePropertyWrite`) — the reserved-name deny-list protects the
 * embedded render surface.
 */

import { invoke } from "@tauri-apps/api/core";
import type { MpvBridge } from "../extensions/types";

/** Names the bridge must never write — they break the embedded surface. */
const RESERVED_PROPERTIES = new Set([
  "wid",
  "vo",
  "gpu-context",
  "init-options",
]);

export type PropertyValue = string | number | boolean;

export type PreparedPropertyWrite = {
  name: string;
  /** Dispatch label mirroring the Rust `PropertyValue` variant. */
  kind: "string" | "double" | "flag";
  value: PropertyValue;
};

/**
 * Validate a property write and classify its value kind. Throws on empty or
 * reserved names and on values outside `string | finite number | boolean`.
 */
export function preparePropertyWrite(
  name: string,
  value: PropertyValue,
): PreparedPropertyWrite {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("property name is empty");
  }
  if (RESERVED_PROPERTIES.has(name)) {
    throw new Error("property is reserved");
  }
  if (typeof value === "string") {
    return { name, kind: "string", value };
  }
  if (typeof value === "boolean") {
    return { name, kind: "flag", value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { name, kind: "double", value };
  }
  throw new Error("property value must be string, number or boolean");
}

export function playerGetProperty(name: string): Promise<string> {
  return invoke<string>("player_get_property", { name });
}

export function playerSetProperty(
  name: string,
  value: PropertyValue,
): Promise<void> {
  const write = preparePropertyWrite(name, value);
  return invoke<void>("player_set_property", {
    name: write.name,
    value: write.value,
  });
}

/** Run a raw mpv command; resolves to the scalar result text or `null`. */
export function playerCommand(args: string[]): Promise<string | null> {
  return invoke<string | null>("player_command", { args });
}

/** The `MpvBridge` surface extensions receive via `ctx.mpv`. */
export function createMpvBridge(): MpvBridge {
  return {
    getProperty: playerGetProperty,
    setProperty: playerSetProperty,
    command: playerCommand,
  };
}

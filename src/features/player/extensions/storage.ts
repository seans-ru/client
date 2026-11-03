/**
 * Namespaced extension storage (spec: docs/compose/spec/player-extensibility.md
 * §S2.2, §S2.3). Keys live in localStorage as `seans.player.ext.<id>.<key>`,
 * matching the `seans.audio.episode.*` convention. All access is best-effort:
 * plain vite / SSR / quota errors degrade to the fallback, never throw.
 */

import type { ExtensionStorage } from "./types";

export function extensionStorageKey(extId: string, key: string): string {
  return `seans.player.ext.${extId}.${key}`;
}

export function createExtensionStorage(extId: string): ExtensionStorage {
  return {
    get<T>(key: string, fallback: T): T {
      try {
        const raw = globalThis.localStorage?.getItem(
          extensionStorageKey(extId, key),
        );
        if (raw == null) return fallback;
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    set(key: string, value: unknown): void {
      try {
        globalThis.localStorage?.setItem(
          extensionStorageKey(extId, key),
          JSON.stringify(value ?? null),
        );
      } catch (error) {
        // Quota / private mode — extension state stays in-memory only.
        console.warn("[player.ext]", extId, error);
      }
    },
  };
}

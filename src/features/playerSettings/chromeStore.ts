/**
 * Observable chrome-schema store shared by the settings section and the
 * player. Every mutation is persisted to `seans.player.chrome` (best-effort)
 * and broadcast to subscribers; React reads it via `useChromeSchema`.
 */

import { useSyncExternalStore } from "react";
import type { ChromeSchema, StorageLike } from "./chromeSchema";
import {
  defaultChromeSchema,
  loadChromeSchema,
  saveChromeSchema,
} from "./chromeSchema";
import type { LayoutSlotId } from "./chromeSchema";
import {
  defaultPlacement,
  hideEntry,
  moveEntry,
  resetLayout as resetLayoutPlacement,
  showEntry,
  toggleEntryHidden,
} from "./layoutModel";
import { setFeatureEnabled } from "./featureCatalog";
import type { SubtitleStyle } from "./chromeSchema";

export type ChromeStore = {
  get(): ChromeSchema;
  subscribe(cb: () => void): () => void;
  /** Replace the schema wholesale (editor drafts, migrations). */
  set(next: ChromeSchema): void;
  /** Immutably update the schema; the result is persisted. */
  update(fn: (schema: ChromeSchema) => ChromeSchema): void;
  setFeature(featureId: string, enabled: boolean): void;
  setSubtitles(style: SubtitleStyle): void;
  moveEntry(entryId: string, toSlot: LayoutSlotId, toIndex: number): void;
  hideEntry(entryId: string): void;
  showEntry(entryId: string): void;
  toggleEntryHidden(entryId: string): void;
  resetLayout(): void;
};

export function createChromeStore(storage?: StorageLike): ChromeStore {
  let schema: ChromeSchema = loadChromeSchema(storage);
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const apply = (next: ChromeSchema) => {
    if (next === schema) return;
    schema = next;
    saveChromeSchema(schema, storage);
    notify();
  };

  return {
    get: () => schema,
    subscribe(cb) {
      listeners.add(cb);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(cb);
      };
    },
    set(next) {
      apply(next);
    },
    update(fn) {
      apply(fn(schema));
    },
    setFeature(featureId, enabled) {
      apply(setFeatureEnabled(schema, featureId, enabled));
    },
    setSubtitles(style) {
      apply({ ...schema, subtitles: style });
    },
    moveEntry(entryId, toSlot, toIndex) {
      apply(moveEntry(schema, entryId, toSlot, toIndex));
    },
    hideEntry(entryId) {
      apply(hideEntry(schema, entryId));
    },
    showEntry(entryId) {
      apply(showEntry(schema, entryId));
    },
    toggleEntryHidden(entryId) {
      apply(toggleEntryHidden(schema, entryId));
    },
    resetLayout() {
      apply({ ...schema, ...resetLayoutPlacement(schema) });
    },
  };
}

/** App-wide singleton (settings screen + player sessions share one schema). */
export const chromeStore: ChromeStore = createChromeStore();

export function useChromeSchema(): ChromeSchema {
  return useSyncExternalStore(chromeStore.subscribe, chromeStore.get, chromeStore.get);
}

export { defaultChromeSchema, defaultPlacement };

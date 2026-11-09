/**
 * Shared seek-bar marker track (issues #19/#21, extended `SegmentMarker`
 * format in features/theintrodb/types.ts). Timeline extensions publish their
 * markers here (one source slot per extension id); `SeekMarkers` merges the
 * store with the TheIntroDB props so every marker kind shares one rail.
 *
 * Snapshots are referentially stable between mutations (useSyncExternalStore).
 */

import type {
  SegmentMarker,
} from "../../theintrodb/types";

export type MarkerTrack = {
  subscribe(cb: () => void): () => void;
  /** Merged markers from every source, sorted by startMs. */
  getMarkers(): readonly SegmentMarker[];
  /** Replace one source's markers (empty array removes the source). */
  setMarkers(source: string, markers: readonly SegmentMarker[]): void;
  clearSource(source: string): void;
  clearAll(): void;
};

const EMPTY: readonly SegmentMarker[] = [];

export function createMarkerTrack(): MarkerTrack {
  const sources = new Map<string, readonly SegmentMarker[]>();
  const listeners = new Set<() => void>();
  let cache: readonly SegmentMarker[] = EMPTY;

  const rebuild = (): void => {
    const merged: SegmentMarker[] = [];
    for (const list of sources.values()) merged.push(...list);
    merged.sort((a, b) => a.startMs - b.startMs);
    cache = merged;
    for (const listener of [...listeners]) listener();
  };

  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getMarkers: () => cache,
    setMarkers(source, markers) {
      if (markers.length === 0) {
        if (!sources.has(source)) return;
        sources.delete(source);
      } else {
        // Copy: callers may reuse their array after publishing.
        sources.set(source, [...markers]);
      }
      rebuild();
    },
    clearSource(source) {
      if (!sources.delete(source)) return;
      rebuild();
    },
    clearAll() {
      if (sources.size === 0) return;
      sources.clear();
      rebuild();
    },
  };
}

/** Session-wide track — the player session is a singleton. */
export const markerTrack = createMarkerTrack();

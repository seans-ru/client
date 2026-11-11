import { describe, expect, it, vi } from "vitest";
import {
  createMarkerTrack,
  markerTrack,
} from "../src/features/player/extensions/markerTrack";
import type { SegmentMarker } from "../src/features/theintrodb/types";

function marker(startMs: number, type: SegmentMarker["type"] = "chapter"): SegmentMarker {
  return { type, startMs, endMs: null, label: `m${startMs}` };
}

describe("createMarkerTrack", () => {
  it("merges sources and sorts by startMs", () => {
    const track = createMarkerTrack();
    track.setMarkers("chapters", [marker(30000), marker(1000)]);
    track.setMarkers("bookmarks", [marker(5000, "bookmark")]);
    const merged = track.getMarkers();
    expect(merged.map((m) => m.startMs)).toEqual([1000, 5000, 30000]);
  });

  it("keeps a referentially stable snapshot between mutations", () => {
    const track = createMarkerTrack();
    track.setMarkers("chapters", [marker(1000)]);
    const first = track.getMarkers();
    expect(track.getMarkers()).toBe(first);
    track.setMarkers("chapters", [marker(2000)]);
    expect(track.getMarkers()).not.toBe(first);
  });

  it("setMarkers with an empty list removes the source", () => {
    const track = createMarkerTrack();
    track.setMarkers("chapters", [marker(1000)]);
    track.setMarkers("chapters", []);
    expect(track.getMarkers()).toEqual([]);
  });

  it("clearSource drops only that source", () => {
    const track = createMarkerTrack();
    track.setMarkers("chapters", [marker(1000)]);
    track.setMarkers("bookmarks", [marker(2000, "bookmark")]);
    track.clearSource("chapters");
    expect(track.getMarkers().map((m) => m.startMs)).toEqual([2000]);
  });

  it("clearAll empties the track", () => {
    const track = createMarkerTrack();
    track.setMarkers("chapters", [marker(1000)]);
    track.clearAll();
    expect(track.getMarkers()).toEqual([]);
  });

  it("notifies subscribers on set and clear", () => {
    const track = createMarkerTrack();
    const listener = vi.fn();
    const stop = track.subscribe(listener);
    track.setMarkers("chapters", [marker(1000)]);
    track.setMarkers("chapters", []);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    track.setMarkers("chapters", [marker(1000)]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("copies the input array so callers cannot mutate the store", () => {
    const track = createMarkerTrack();
    const input = [marker(1000)];
    track.setMarkers("chapters", input);
    input.push(marker(2000));
    expect(track.getMarkers()).toHaveLength(1);
  });

  it("the session singleton starts empty and is importable", () => {
    expect(markerTrack.getMarkers()).toEqual([]);
  });
});

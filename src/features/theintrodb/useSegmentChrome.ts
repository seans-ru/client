/**
 * Segment chrome state (M8): skip-button linger, credits popup gate, markers.
 * Personal (not broadcast). Session-only popup gate per media id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isSegmentActive,
  markerList,
  shouldShowCreditsPopup,
  skipTargetMs,
} from "./introSegments";
import type { ActiveSkip, SegmentMarker, TheIntroDbBundle } from "./types";
import { useChromeSchema } from "../playerSettings/chromeStore";
import { isFeatureEnabled } from "../playerSettings/featureCatalog";

/** Skip buttons stay visible this long after leaving the range. */
export const SKIP_LINGER_MS = 2000;

export type SegmentChromeState = {
  markers: SegmentMarker[];
  /** Skip buttons currently offered (includes linger after exit). */
  skips: ActiveSkip[];
  skipVisible: boolean;
  onSkip: (targetMs: number) => void;
  creditsPopupOpen: boolean;
  onDismissCredits: () => void;
  onCreditsSubmitted: () => void;
};

export function useSegmentChrome(options: {
  bundle: TheIntroDbBundle;
  /** Playback position in milliseconds. */
  positionMs: number;
  /** Seeks the player; argument is milliseconds. */
  onSeekMs: (ms: number) => void;
  /** Media id for the credits review PUT (null → popup never opens). */
  mediaId: string | number | null;
  alreadyReviewed: boolean;
}): SegmentChromeState {
  const { bundle, positionMs, onSeekMs, mediaId, alreadyReviewed } = options;

  // «Маркеры сегментов» (issue #25): off → a clean seek rail.
  const chromeSchema = useChromeSchema();
  const markersOn = isFeatureEnabled(chromeSchema, "markers");
  const markers = useMemo(
    () => (markersOn ? markerList(bundle) : []),
    [bundle, markersOn],
  );

  const [skips, setSkips] = useState<ActiveSkip[]>([]);
  const [skipVisible, setSkipVisible] = useState(false);
  const wasInRange = useRef(false);

  // Active intro/recap skips at the current position.
  const activeSkips = useMemo(() => {
    const next: ActiveSkip[] = [];
    for (const type of ["intro", "recap"] as const) {
      if (!isSegmentActive(type, bundle, positionMs)) continue;
      const segment = bundle[type].find((s) => {
        const start = s.startMs == null ? 0 : s.startMs;
        const end = s.endMs == null ? Number.POSITIVE_INFINITY : s.endMs;
        return positionMs >= start && positionMs < end;
      });
      if (segment) {
        next.push({ type, targetMs: skipTargetMs(segment) });
      }
    }
    return next;
  }, [bundle, positionMs]);

  const inRange = activeSkips.length > 0;

  useEffect(() => {
    if (inRange) {
      wasInRange.current = true;
      setSkips(activeSkips);
      setSkipVisible(true);
    }
  }, [inRange, activeSkips]);

  // Linger 2s after leaving the range (or until unmount).
  useEffect(() => {
    if (inRange) return;
    if (!wasInRange.current) return;
    const timer = setTimeout(() => {
      setSkipVisible(false);
      setSkips([]);
      wasInRange.current = false;
    }, SKIP_LINGER_MS);
    return () => clearTimeout(timer);
  }, [inRange]);

  const onSkip = useCallback(
    (targetMs: number) => {
      onSeekMs(targetMs);
    },
    [onSeekMs],
  );

  // Credits popup: at most once per session per media; never when reviewed.
  // Opening consumes the gate immediately (stays visible until dismissed).
  const consumedRef = useRef<Set<string>>(new Set());
  const [popupOpen, setPopupOpen] = useState(false);
  const mediaKey = mediaId == null ? null : String(mediaId);

  useEffect(() => {
    if (mediaKey == null || alreadyReviewed) {
      setPopupOpen(false);
      return;
    }
    if (consumedRef.current.has(mediaKey)) return;
    const shouldOpen = shouldShowCreditsPopup(bundle.credits, positionMs, {
      shown: false,
      alreadyReviewed: false,
    });
    if (shouldOpen) {
      consumedRef.current.add(mediaKey);
      setPopupOpen(true);
    }
  }, [bundle.credits, positionMs, mediaKey, alreadyReviewed]);

  const closePopup = useCallback(() => {
    setPopupOpen(false);
    if (mediaKey != null) consumedRef.current.add(mediaKey);
  }, [mediaKey]);

  return {
    markers,
    skips,
    skipVisible,
    onSkip,
    creditsPopupOpen: popupOpen,
    onDismissCredits: closePopup,
    onCreditsSubmitted: closePopup,
  };
}

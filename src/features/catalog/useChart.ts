/**
 * Home chart shelf (ui-ux-redesign). GET /api/catalog/chart.
 * Failure is silent-empty so the hero never blocks search.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchChart } from "../../api/endpoints";
import type { MediaSearchResult } from "../../api/types";

export type ChartStatus = "loading" | "ready" | "error";

export type ChartState = {
  items: MediaSearchResult[];
  status: ChartStatus;
  retry: () => void;
};

export function useChart(limit = 20): ChartState {
  const [items, setItems] = useState<MediaSearchResult[]>([]);
  const [status, setStatus] = useState<ChartStatus>("loading");
  const [retryToken, setRetryToken] = useState(0);

  const retry = useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setStatus("loading");

    void (async () => {
      try {
        const list = await fetchChart({
          type: "popular_series",
          limit,
          signal: controller.signal,
        });
        if (cancelled || controller.signal.aborted) return;
        setItems(list);
        setStatus("ready");
      } catch {
        if (cancelled || controller.signal.aborted) return;
        // Chart is decorative — empty backdrop, search stays available.
        setItems([]);
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [limit, retryToken]);

  return { items, status, retry };
}

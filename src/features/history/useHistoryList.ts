/**
 * Continue-watching list loader (M9). One-shot GET /api/history (limit 50)
 * + manual refresh. Abort + unmount-safe; no polling.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchHistory } from "../../api/endpoints";
import type { HistoryListItem } from "../../api/types";

/** Default page size for the History screen (contract allows 1..200). */
export const HISTORY_LIST_LIMIT = 50;

export type HistoryListStatus = "loading" | "ready" | "error";

export type HistoryListState = {
  items: HistoryListItem[];
  status: HistoryListStatus;
  error: string | null;
  refresh: () => void;
};

export function useHistoryList(
  limit: number = HISTORY_LIST_LIMIT,
): HistoryListState {
  const [items, setItems] = useState<HistoryListItem[]>([]);
  const [status, setStatus] = useState<HistoryListStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setStatus("loading");
    setError(null);

    void (async () => {
      try {
        const list = await fetchHistory({ limit, signal: controller.signal });
        if (cancelled || controller.signal.aborted) return;
        setItems(list);
        setStatus("ready");
      } catch (cause) {
        if (cancelled || controller.signal.aborted) return;
        setStatus("error");
        setError(
          cause instanceof Error ? cause.message : "Не удалось загрузить историю",
        );
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [limit, reloadToken]);

  return { items, status, error, refresh };
}

/**
 * Progressive status chrome: dual progress («Скачано» / «Доступно»),
 * grey-zone toast, and the buffer-waiting banner at the seekable edge.
 */

import { useEffect, useState } from "react";
import {
  BUFFER_WAITING_LABEL,
  formatProgressLabels,
  formatSeekableUntil,
  SEEK_BLOCKED_TOAST,
  type DownloadProgress,
  type SeekLimit,
} from "./progressiveHelpers";

export type ProgressiveStatusProps = {
  mode: "vod" | "progressive" | "waiting";
  progress: DownloadProgress;
  limit: SeekLimit;
  /** True while playback is paused at the contiguous-prefix edge. */
  waitingAtEdge: boolean;
  /** Bump to show the grey-zone toast (seek past max_seekable). */
  blockedToastToken: number;
};

export function ProgressiveStatus({
  mode,
  progress,
  limit,
  waitingAtEdge,
  blockedToastToken,
}: ProgressiveStatusProps) {
  const [toastVisible, setToastVisible] = useState(false);
  const labels = formatProgressLabels(progress);
  const seekableUntil = formatSeekableUntil(limit);

  useEffect(() => {
    if (blockedToastToken === 0) return;
    setToastVisible(true);
    const timer = setTimeout(() => setToastVisible(false), 3200);
    return () => clearTimeout(timer);
  }, [blockedToastToken]);

  if (mode === "vod") return null;

  return (
    <div className="player-progressive" role="status" aria-live="polite">
      <div className="player-progressive-row">
        <span className="player-progressive-item" title="Объём, который уже на сервере">
          {labels.downloaded}
        </span>
        <span
          className="player-progressive-item player-progressive-item-seekable"
          title="Моменты, куда уже можно перематывать"
        >
          {labels.seekable}
          {seekableUntil ? <span className="player-progressive-until"> · {seekableUntil}</span> : null}
        </span>
      </div>

      {waitingAtEdge || mode === "waiting" ? (
        <div className="player-buffer-wait">
          <span className="player-buffer-spinner" aria-hidden="true" />
          {mode === "waiting" ? "Готовим первые сегменты…" : BUFFER_WAITING_LABEL}
        </div>
      ) : null}

      {toastVisible ? (
        <div className="player-toast" role="alert">
          {SEEK_BLOCKED_TOAST}
          <span className="player-toast-hint">
            {seekableUntil ? ` ${seekableUntil}` : " Подождите следующего обновления"}
          </span>
        </div>
      ) : null}
    </div>
  );
}

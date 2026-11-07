/**
 * Playback stats overlay (issue #25, «базовые возможности плеера»): a small
 * always-on badge with the live snapshot — position, speed, tracks, decoder.
 * Registered only while the «Статистика воспроизведения» feature is enabled.
 */

import { useEffect, useState, type ReactElement } from "react";
import type { PlayerSnapshot } from "../playerTypes";
import type {
  PlayerExtension,
  PlayerExtensionContext,
  Unsubscribe,
} from "./types";

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function trackCount(snapshot: PlayerSnapshot, kind: "audio" | "sub"): number {
  return snapshot.tracks.filter((track) => track.kind === kind).length;
}

export function StatsBadge({ ctx }: { ctx: PlayerExtensionContext }): ReactElement {
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(() => ctx.getSnapshot());

  useEffect(() => ctx.onSnapshot(setSnapshot), [ctx]);

  return (
    <div
      className="ps-stats-overlay"
      title="Статистика воспроизведения"
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        padding: "6px 10px",
        borderRadius: 8,
        background: "rgba(8, 9, 12, 0.78)",
        border: "1px solid rgba(242, 241, 247, 0.18)",
        color: "#f2f1f7",
        font: "12px/1.5 'JetBrains Mono', Consolas, monospace",
        pointerEvents: "none",
        whiteSpace: "nowrap",
      }}
    >
      <div>
        {formatTime(snapshot.position)} / {formatTime(snapshot.duration)} ·{" "}
        {snapshot.speed.toFixed(2)}×
      </div>
      <div>
        {snapshot.hwdec || "—" } · {snapshot.vo || "—"} · аудио {trackCount(snapshot, "audio")} ·
        суб {trackCount(snapshot, "sub")}
      </div>
    </div>
  );
}

export const statsOverlay: PlayerExtension = {
  id: "stats-overlay",
  name: "Статистика воспроизведения",
  setup(ctx): Unsubscribe {
    return ctx.ui.add("overlay", () => <StatsBadge ctx={ctx} />);
  },
};

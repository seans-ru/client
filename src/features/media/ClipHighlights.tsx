/**
 * Open clips in the movie card (clips-cloud.md, phase 2).
 *
 * `GET /api/clips?media_id=…` filtered client-side: the contract says the
 * media card only shows `visibility=open` rows; spoiler rows stay hidden
 * until the media is watched (local `seans.watch.*` flag). Screenshots never
 * appear here — only clips. Network failures degrade to a quiet hint.
 */

import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
} from "react";
import { Spinner } from "../../design/primitives";
import {
  createClipsApi,
  isMediaWatched,
  shouldRevealSpoiler,
  shareUrlForCode,
  type CloudAssetRecord,
  type ClipsApi,
} from "../clips";

export type ClipHighlightsState = {
  status: "idle" | "loading" | "ready" | "error";
  clips: CloudAssetRecord[];
};

export function visibleOpenClips(
  clips: readonly CloudAssetRecord[],
  watched: boolean | null | undefined,
): CloudAssetRecord[] {
  return clips.filter(
    (clip) =>
      clip.visibility === "open" && shouldRevealSpoiler(clip.spoiler, watched),
  );
}

export function formatClipTimecode(
  startSec: number | null,
  endSec: number | null,
): string {
  if (startSec == null) return "";
  const fmt = (sec: number): string => {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  };
  return endSec != null ? `${fmt(startSec)}–${fmt(endSec)}` : fmt(startSec);
}

export function ClipHighlights({
  mediaId,
  api,
}: {
  mediaId: string;
  api?: ClipsApi;
}): ReactElement | null {
  const [state, setState] = useState<ClipHighlightsState>({
    status: "idle",
    clips: [],
  });
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((t) => t + 1), []);

  useEffect(() => {
    const client = api ?? createClipsApi();
    const controller = new AbortController();
    setState((s) => ({ ...s, status: "loading" }));
    void (async () => {
      try {
        const clips = await client.listClips(mediaId);
        if (controller.signal.aborted) return;
        setState({ status: "ready", clips });
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: "error", clips: [] });
      }
    })();
    return () => controller.abort();
  }, [mediaId, api, token]);

  if (state.status === "error") {
    // The cloud is optional — the movie card stays useful without it.
    return null;
  }

  const watched = isMediaWatched(mediaId);
  const visible = visibleOpenClips(state.clips, watched);

  return (
    <section className="media-clips" aria-label="Лучшие моменты">
      <h3>Лучшие моменты</h3>
      {state.status === "loading" ? (
        <Spinner label="Загрузка клипов…" />
      ) : visible.length === 0 ? (
        <p className="hint">Открытых клипов пока нет.</p>
      ) : (
        <ul className="media-clip-list">
          {visible.map((clip) => (
            <li key={clip.id} className="media-clip-item">
              <a
                className="media-clip-link"
                href={clip.url || shareUrlForCode(clip.code)}
                target="_blank"
                rel="noreferrer"
              >
                {clip.title || `Клип ${formatClipTimecode(clip.startSec, clip.endSec)}`}
              </a>
              <span className="hint">
                {formatClipTimecode(clip.startSec, clip.endSec)}
                {clip.spoiler ? " · спойлер" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="hint" onClick={reload}>
        Обновить
      </button>
    </section>
  );
}

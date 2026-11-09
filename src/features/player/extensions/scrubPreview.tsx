/**
 * Scrub preview extension (issue #17, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Thumbnail + timecode tooltip over the seek bar on hover / drag — the
 * Netflix-style scrub «wow». Frames are sampled from the `ctx.frames` tap
 * while watching (в‰Ґ one frame per `captureStepSec`, в‰¤ MAX per file), cached
 * per file in `ctx.storage` (`seans.player.ext.scrub-preview.frames.*`) with a
 * size cap, and looked up nearest-to-cursor on hover. Until a frame is cached
 * (or for unwatched stretches) the tooltip shows the timecode only — never an
 * error. The tooltip is driven through refs (no React re-render per pointer
 * move) so scrubbing never blocks the UI.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { formatTime } from "../playerHelpers";
import type {
  ExtensionStorage,
  FrameSample,
  PlayerExtension,
  Unsubscribe,
} from "./types";
import { currentMediaKey } from "./fileKey";
import {
  addPreviewFrame,
  captureStepSec,
  nearestPreview,
  parsePreviewCache,
  serializePreviewCache,
  MAX_CACHE_BYTES,
  MAX_PREVIEW_FRAMES,
  type PreviewFrame,
} from "./scrubPreviewPolicy";
import "./scrubPreview.css";
import "./markers.css";

const ENABLED_KEY = "enabled";
/** Persist cadence: every N captured frames (plus dispose / file close). */
const PERSIST_EVERY = 8;
/** Frame-tap sampling rate: buckets are в‰Ґ5 s wide, 2 fps is plenty. */
const CAPTURE_MAX_FPS = 2;

/**
 * Encode a stride-sampled frame into a small PNG data URL. Returns null when
 * canvas is unavailable (tests / SSR) or the sample is corrupt — the cache
 * then stays empty and the tooltip falls back to the timecode.
 */
export function frameSampleToDataUrl(sample: FrameSample): string | null {
  try {
    const doc = globalThis.document;
    if (!doc?.createElement) return null;
    const { width, height, rgb } = sample;
    if (width <= 0 || height <= 0 || rgb.length < width * height * 3) return null;
    const canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return null;
    const image = ctx2d.createImageData(width, height);
    for (let i = 0, p = 0; i < width * height; i += 1, p += 3) {
      const o = i * 4;
      image.data[o] = rgb[p];
      image.data[o + 1] = rgb[p + 1];
      image.data[o + 2] = rgb[p + 2];
      image.data[o + 3] = 255;
    }
    ctx2d.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

type PreviewToggle = {
  subscribe(cb: () => void): Unsubscribe;
  get(): boolean;
  set(next: boolean): void;
};

function createToggle(storage: ExtensionStorage): PreviewToggle {
  let value = storage.get<unknown>(ENABLED_KEY, true) !== false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: () => value,
    set(next) {
      value = next;
      storage.set(ENABLED_KEY, next);
      notify();
    },
  };
}

/** Mutable capture session (owned by setup, read by the tooltip component). */
type PreviewSession = {
  storage: ExtensionStorage;
  toggle: PreviewToggle;
  fileKey: string;
  durationSec: number;
  frames: PreviewFrame[];
  sincePersist: number;
  /** Cache version counter — bumped when frames[] changes (settings UI). */
  version: number;
  subscribe(cb: () => void): Unsubscribe;
  notify(): void;
  /** Current nearest frame for `tSec` (null → timecode-only). */
  nearest(tSec: number): PreviewFrame | null;
  capture(sample: FrameSample): void;
  persist(): void;
  clear(): void;
};

function createSession(storage: ExtensionStorage): PreviewSession {
  const listeners = new Set<() => void>();
  const session: PreviewSession = {
    storage,
    toggle: createToggle(storage),
    fileKey: "unknown",
    durationSec: 0,
    frames: [],
    sincePersist: 0,
    version: 0,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    notify() {
      session.version += 1;
      for (const listener of [...listeners]) listener();
    },
    nearest(tSec) {
      return nearestPreview(session.frames, tSec);
    },
    capture(sample) {
      if (!session.toggle.get()) return;
      const stepSec = captureStepSec(session.durationSec);
      // Position fallback when the wire pts is missing: live playback start.
      const tSec = Number.isFinite(sample.pts) && sample.pts > 0 ? sample.pts : 0;
      const dataUrl = frameSampleToDataUrl(sample);
      if (!dataUrl) return;
      const updated = addPreviewFrame(
        session.frames,
        { tSec, dataUrl },
        stepSec,
        MAX_PREVIEW_FRAMES,
      );
      if (!updated) return;
      session.frames = updated;
      session.sincePersist += 1;
      if (session.sincePersist >= PERSIST_EVERY) session.persist();
      session.notify();
    },
    persist() {
      session.sincePersist = 0;
      const key = `frames.${session.fileKey}`;
      const raw = serializePreviewCache(session.frames, MAX_CACHE_BYTES);
      if (raw == null) return;
      try {
        session.storage.set(key, JSON.parse(raw));
      } catch {
        // Quota — the in-memory cache still serves the session.
      }
    },
    clear() {
      session.frames = [];
      session.sincePersist = 0;
      try {
        session.storage.set(`frames.${session.fileKey}`, []);
      } catch {
        // ignore
      }
      session.notify();
    },
  };
  return session;
}

/* --------------------------------------------------------------- tooltip */

type HoverInfo = {
  visible: boolean;
  /** Left offset (px) inside the overlay layer. */
  left: number;
  tSec: number;
};

const HIDE_DELAY_MS = 120;

function ScrubPreviewTooltip({
  session,
}: {
  session: PreviewSession;
}): ReactElement | null {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const hoverRef = useRef<HoverInfo>({ visible: false, left: 0, tSec: 0 });
  const scrubbingRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFrameT = useRef<number | null>(null);
  const enabled = useSyncExternalStore(
    session.toggle.subscribe,
    session.toggle.get,
    session.toggle.get,
  );

  useEffect(() => {
    if (!enabled) return;

    const apply = () => {
      const root = rootRef.current;
      if (!root) return;
      const hover = hoverRef.current;
      root.style.display = hover.visible ? "flex" : "none";
      if (!hover.visible) return;
      root.style.left = `${Math.round(hover.left)}px`;
      if (timeRef.current) {
        timeRef.current.textContent = formatTime(hover.tSec);
      }
      const img = imgRef.current;
      if (img) {
        const frame = session.nearest(hover.tSec);
        const t = frame ? frame.tSec : null;
        if (t !== lastFrameT.current) {
          lastFrameT.current = t;
          if (frame) {
            img.src = frame.dataUrl;
            img.style.display = "block";
          } else {
            img.removeAttribute("src");
            img.style.display = "none";
          }
        }
      }
    };

    const scheduleHide = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        hoverRef.current = { ...hoverRef.current, visible: false };
        apply();
      }, HIDE_DELAY_MS);
    };

    const railRect = (): DOMRect | null => {
      const rail = document.querySelector(".player-seek");
      return rail ? rail.getBoundingClientRect() : null;
    };

    const updateFromEvent = (event: PointerEvent, force: boolean) => {
      const rect = railRect();
      if (!rect || rect.width <= 0) return;
      const duration = session.durationSec;
      if (duration <= 0) return;
      const tip = rootRef.current;
      const overTooltip = Boolean(
        tip && event.target instanceof Node && tip.contains(event.target),
      );
      const insideX = event.clientX >= rect.left && event.clientX <= rect.right;
      const insideY = event.clientY >= rect.top - 12 && event.clientY <= rect.bottom + 10;
      const overRail = (insideX && insideY) || overTooltip || scrubbingRef.current;
      if (!overRail && !force) {
        if (hoverRef.current.visible) scheduleHide();
        return;
      }
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      if (overTooltip && !scrubbingRef.current) {
        // Keep the tooltip where it is while the pointer explores it.
        return;
      }
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const layer = rootRef.current?.offsetParent as HTMLElement | null;
      const left = event.clientX - (layer ? layer.getBoundingClientRect().left : 0);
      const maxLeft = layer ? Math.max(96, layer.clientWidth - 48) : left;
      const next: HoverInfo = {
        visible: true,
        left: Math.min(Math.max(left, 48), maxLeft),
        tSec: ratio * duration,
      };
      const prev = hoverRef.current;
      // Skip identical frames of work while the pointer hovers in place.
      if (
        prev.visible === next.visible &&
        Math.abs(prev.left - next.left) < 1 &&
        Math.abs(prev.tSec - next.tSec) < 0.4
      ) {
        return;
      }
      hoverRef.current = next;
      apply();
    };

    const onMove = (event: PointerEvent) => updateFromEvent(event, scrubbingRef.current);
    const onDown = (event: PointerEvent) => {
      const rect = railRect();
      if (!rect) return;
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (inside) {
        scrubbingRef.current = true;
        updateFromEvent(event, true);
      }
    };
    const onUp = () => {
      scrubbingRef.current = false;
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [enabled, session]);

  if (!enabled) return null;
  return (
    <div className="player-scrub-preview" ref={rootRef} style={{ display: "none" }}>
      <img className="player-scrub-preview-img" ref={imgRef} alt="" />
      <span className="player-scrub-preview-time" ref={timeRef}>
        0:00
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- settings */

function ScrubPreviewRow({
  session,
}: {
  session: PreviewSession;
}): ReactElement {
  const enabled = useSyncExternalStore(
    session.toggle.subscribe,
    session.toggle.get,
    session.toggle.get,
  );
  const version = useSyncExternalStore(session.subscribe, () => session.version);
  const count = session.frames.length;
  return (
    <section>
      <h4 className="player-menu-title">Превью перемотки</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={enabled}
          className={`player-menu-item${enabled ? " player-menu-item-active" : ""}`}
          onClick={() => session.toggle.set(!enabled)}
        >
          {enabled ? "Включено" : "Выключено"}
        </button>
        <button
          type="button"
          role="menuitem"
          className="player-menu-item"
          onClick={() => session.clear()}
          disabled={count === 0}
          title="Очистить сохранённые кадры этого файла"
        >
          {`Очистить кэш (${count} кадр.)`}
        </button>
      </div>
      <p className="player-menu-empty" key={version}>
        {count > 0
          ? "Кадры копятся при просмотре — чем дольше смотришь, тем богаче перемотка."
          : "Пока без кадров: подсказка показывает только таймкод."}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------- extension */

export const scrubPreview: PlayerExtension = {
  id: "scrub-preview",
  name: "Превью перемотки",
  setup(ctx): Unsubscribe {
    const session = createSession(ctx.storage);
    const stopOpen = ctx.onOpen((info) => {
      session.persist();
      session.fileKey = currentMediaKey(info.url);
      session.frames = parsePreviewCache(
        ctx.storage.get(`frames.${session.fileKey}`, []),
      );
      session.sincePersist = 0;
      session.durationSec = ctx.getSnapshot().duration;
      session.notify();
    });
    const stopClose = ctx.onClose(() => {
      session.persist();
      session.frames = [];
    });
    const stopSnap = ctx.onSnapshot((snapshot) => {
      if (snapshot.duration > 0 && snapshot.duration !== session.durationSec) {
        session.durationSec = snapshot.duration;
      }
    });
    const stopFrames = ctx.frames.subscribe(
      (sample) => session.capture(sample),
      { maxFps: CAPTURE_MAX_FPS },
    );
    const stopTooltip = ctx.ui.add("overlay", () => (
      <ScrubPreviewTooltip session={session} />
    ));
    const stopRow = ctx.ui.add("settings.menu", () => (
      <ScrubPreviewRow session={session} />
    ));
    // A file may already be playing when the extension mounts.
    session.fileKey = currentMediaKey(ctx.getSnapshot().url);
    session.frames = parsePreviewCache(
      ctx.storage.get(`frames.${session.fileKey}`, []),
    );
    session.durationSec = ctx.getSnapshot().duration;
    return () => {
      session.persist();
      stopTooltip();
      stopRow();
      stopFrames();
      stopSnap();
      stopClose();
      stopOpen();
    };
  },
};

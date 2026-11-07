import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { PlayerSnapshot } from "../playerTypes";
import type { PlayerExtension, PlayerExtensionContext } from "./types";
import "./pipMiniPlayer.css";

const POSITION_KEY = "position";
const DEFAULT_POSITION = { x: 1, y: 1 };
const WINDOW_WIDTH = 320;
const WINDOW_HEIGHT = 265;

type Position = { x: number; y: number };
type MiniPlayerState = {
  open: boolean;
  snapshot: PlayerSnapshot;
  position: Position;
};

function loadPosition(ctx: PlayerExtensionContext): Position {
  const saved = ctx.storage.get<unknown>(POSITION_KEY, DEFAULT_POSITION);
  if (
    typeof saved === "object" && saved !== null &&
    "x" in saved && "y" in saved &&
    typeof saved.x === "number" && typeof saved.y === "number"
  ) {
    return {
      x: Math.min(1, Math.max(0, saved.x)),
      y: Math.min(1, Math.max(0, saved.y)),
    };
  }
  return DEFAULT_POSITION;
}

function MiniPlayer({
  ctx,
  showToggle,
  subscribe,
  getState,
  setOpen,
  setPosition,
}: {
  ctx: PlayerExtensionContext;
  showToggle: boolean;
  subscribe: (listener: () => void) => () => void;
  getState: () => MiniPlayerState;
  setOpen: (open: boolean) => void;
  setPosition: (position: Position) => void;
}) {
  const liveState = useSyncExternalStore(subscribe, getState, getState);
  const miniCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [surfaceBounds, setSurfaceBounds] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!liveState.open) return;
    const target = miniCanvasRef.current;
    if (!target) return;
    const context = target.getContext("2d");
    if (!context) return;

    let frameId = 0;
    let previousDraw = 0;
    const draw = (time: number) => {
      if (time - previousDraw >= 1000 / 15) {
        previousDraw = time;
        const source = document.querySelector<HTMLCanvasElement>(".player-video-canvas");
        if (source?.width && source.height) {
          const ratio = Math.min(target.clientWidth / source.width, target.clientHeight / source.height);
          const width = Math.max(1, Math.round(source.width * ratio));
          const height = Math.max(1, Math.round(source.height * ratio));
          const left = Math.round((target.clientWidth - width) / 2);
          const top = Math.round((target.clientHeight - height) / 2);
          if (target.width !== target.clientWidth || target.height !== target.clientHeight) {
            target.width = target.clientWidth;
            target.height = target.clientHeight;
          }
          context.clearRect(0, 0, target.width, target.height);
          try {
            context.drawImage(source, left, top, width, height);
          } catch {
            // The main renderer may be replacing its WebGL context during resize.
          }
        }
      }
      frameId = requestAnimationFrame(draw);
    };
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [liveState.open]);

  useEffect(() => {
    if (!liveState.open) return;
    const surface = miniCanvasRef.current?.closest(".player-video-area");
    if (!surface) return;
    const update = () => {
      const bounds = surface.getBoundingClientRect();
      setSurfaceBounds({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [liveState.open]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const surface = event.currentTarget.closest(".player-video-area");
    if (!surface) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    const surface = event.currentTarget.closest(".player-video-area");
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    const maxX = Math.max(0, bounds.width - Math.min(WINDOW_WIDTH, Math.max(0, bounds.width - 16)));
    const maxY = Math.max(0, bounds.height - WINDOW_HEIGHT);
    const left = Math.min(maxX, Math.max(0, event.clientX - bounds.left - dragRef.current.x));
    const top = Math.min(maxY, Math.max(0, event.clientY - bounds.top - dragRef.current.y));
    setPosition({ x: maxX ? left / maxX : 0, y: maxY ? top / maxY : 0 });
  }, [setPosition]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }, []);

  if (showToggle) {
    return (
      <button className="pip-mini-toggle" type="button" onClick={() => setOpen(!liveState.open)}>
        {liveState.open ? "Закрыть мини-плеер" : "Открыть мини-плеер"}
      </button>
    );
  }
  if (!liveState.open) return null;

  const position = liveState.position;
  const width = Math.min(WINDOW_WIDTH, Math.max(0, surfaceBounds.width - 16));
  const left = surfaceBounds.left + position.x * Math.max(0, surfaceBounds.width - width);
  const top = surfaceBounds.top + position.y * Math.max(0, surfaceBounds.height - WINDOW_HEIGHT);
  return (
    <div
      className="pip-mini-window"
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px` }}
      role="region"
      aria-label="Мини-плеер"
    >
      <div
        className={`pip-mini-title${dragging ? " pip-mini-title-dragging" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span>Мини-плеер</span>
        <button type="button" aria-label="Закрыть мини-плеер" onClick={() => setOpen(false)}>×</button>
      </div>
      <canvas className="pip-mini-video" ref={miniCanvasRef} aria-label="Видео" />
      <div className="pip-mini-controls">
        <button type="button" aria-label="Назад на 10 секунд" onClick={() => void ctx.transport.seek(Math.max(0, ctx.getSnapshot().position - 10))}>−10</button>
        <button type="button" aria-label={liveState.snapshot.pause ? "Воспроизвести" : "Пауза"} onClick={() => void ctx.transport.togglePause()}>
          {liveState.snapshot.pause ? "▶" : "Ⅱ"}
        </button>
        <span>{formatTime(liveState.snapshot.position)} / {formatTime(liveState.snapshot.duration)}</span>
        <button type="button" aria-label="Вперёд на 10 секунд" onClick={() => void ctx.transport.seek(Math.min(liveState.snapshot.duration, ctx.getSnapshot().position + 10))}>+10</button>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export const pipMiniPlayer: PlayerExtension = {
  id: "pip-mini-player",
  name: "Мини-плеер (прототип)",
  setup(ctx) {
    let current: MiniPlayerState = {
      open: false,
      snapshot: ctx.getSnapshot(),
      position: loadPosition(ctx),
    };
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((listener) => listener());
    const setOpen = (open: boolean) => {
      current = { ...current, open };
      notify();
    };
    const setPosition = (position: Position) => {
      current = { ...current, position };
      ctx.storage.set(POSITION_KEY, position);
      notify();
    };
    const unsubscribeSnapshot = ctx.onSnapshot((snapshot) => {
      current = { ...current, snapshot };
      notify();
    });
    const unsubscribeClose = ctx.onClose(() => setOpen(false));
    const unsubscribeSettings = ctx.ui.add("settings.menu", () => (
      <MiniPlayer
        ctx={ctx}
        showToggle
        subscribe={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
        getState={() => current}
        setOpen={setOpen}
        setPosition={setPosition}
      />
    ));
    const unsubscribeOverlay = ctx.ui.add("overlay", () => (
      <MiniPlayer
        ctx={ctx}
        showToggle={false}
        subscribe={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
        getState={() => current}
        setOpen={setOpen}
        setPosition={setPosition}
      />
    ));
    return () => {
      unsubscribeSnapshot();
      unsubscribeClose();
      unsubscribeSettings();
      unsubscribeOverlay();
      listeners.clear();
    };
  },
};

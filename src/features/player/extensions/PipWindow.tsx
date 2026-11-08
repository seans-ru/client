import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { availableMonitors } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { CanvasVideoRenderer, FrameStream } from "../frameSink";
import { formatTime } from "../playerHelpers";
import { createExtensionStorage } from "./storage";
import { PIP_COMMAND, PIP_ERROR, PIP_INIT, PIP_LAYOUT, PIP_REQUEST, PIP_STATE, type PipCommand, type PipInit, type PipState } from "./pipProtocol";
import { pipCanvasRect, pipContentAspect, pipResizeFrame, PIP_MIN_WIDTH, PIP_MIN_HEIGHT, type PipFrameLayout, type PipResizeEdge } from "./pipVideoLayout";
import "./pipWindow.css";

type Bounds = { x: number; y: number; width: number; height: number };
const RESIZE_EDGES: readonly PipResizeEdge[] = ["North", "NorthEast", "East", "SouthEast", "South", "SouthWest", "West", "NorthWest"];
/** Движение мыши больше порога — перетаскивание окна; меньше — клик (play/pause). */
const DRAG_THRESHOLD_PX = 4;

function PlayPauseIcon({ paused }: { paused: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    {paused ? <path d="M8 4.5 20 12 8 19.5Z" fill="currentColor" stroke="none" /> : <path d="M8 5v14M16 5v14" strokeWidth="3.5" />}
  </svg>;
}

function SeekIcon({ forward }: { forward: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <g transform={forward ? "translate(24 0) scale(-1 1)" : undefined}>
      <path d="M7 7a8 8 0 1 1-2.5 8M7 2.5V7H2.5" />
    </g>
    <text x="12" y="16" textAnchor="middle" fill="currentColor" stroke="none" fontSize="10" fontWeight="600">5</text>
  </svg>;
}

/** Свободная область окна: клик здесь переключает play/pause, перетаскивание двигает окно. */
function isFreeArea(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !target.closest("button, input, .pip-controls, .pip-status, .pip-resize");
}

export function PipWindow() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<PipState>({ position: 0, duration: 0, pause: true });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const contentAspect = useRef<number | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const resize = useRef<{ edge: PipResizeEdge; sx: number; sy: number; lx: number; ly: number; bounds: Bounds | null } | null>(null);

  const applyResize = (attempt: { edge: PipResizeEdge; sx: number; sy: number; lx: number; ly: number; bounds: Bounds | null }) => {
    if (!attempt.bounds) return;
    // Deltas приходят в CSS-пикселях; размеры окна — физические.
    const scale = window.devicePixelRatio || 1;
    const aspect = contentAspect.current ?? attempt.bounds.width / attempt.bounds.height;
    const next = pipResizeFrame(
      attempt.bounds,
      { dx: (attempt.lx - attempt.sx) * scale, dy: (attempt.ly - attempt.sy) * scale },
      attempt.edge,
      aspect,
    );
    const win = getCurrentWebviewWindow();
    void win.setSize(new PhysicalSize(next.width, next.height)).catch(() => setError("Не удалось изменить размер окна."));
    void win.setPosition(new PhysicalPosition(next.x, next.y)).catch(() => setError("Не удалось изменить размер окна."));
  };

  useEffect(() => {
    let active = true;
    const stops: (() => void)[] = [];
    const stream = new FrameStream();
    const renderer = new CanvasVideoRenderer(canvas.current!);
    const element = canvas.current!;
    let sourceLayout: PipFrameLayout | null = null;
    let frameSize = { width: 0, height: 0 };
    const syncAspect = () => { contentAspect.current = pipContentAspect(frameSize, sourceLayout); };
    const applyLayout = () => {
      const viewport = element.parentElement!;
      const rect = pipCanvasRect({ width: viewport.clientWidth, height: viewport.clientHeight }, frameSize, sourceLayout);
      if (!rect) return;
      element.style.left = `${rect.left}px`;
      element.style.top = `${rect.top}px`;
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
    };
    const resizeObserver = new ResizeObserver(applyLayout);
    resizeObserver.observe(element.parentElement!);
    const current = getCurrentWebviewWindow();
    const storage = createExtensionStorage("pip-mini-player");
    let started = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let restored = false;
    const keep = (stop: () => void) => { if (active) stops.push(stop); else stop(); };
    const save = () => {
      if (!restored) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        void Promise.all([current.outerPosition(), current.innerSize()]).then(([position, size]) => {
          if (active) storage.set("bounds", { x: position.x, y: position.y, width: size.width, height: size.height });
        }).catch(() => {});
      }, 150);
    };
    void (async () => {
      try {
        await listen<PipInit>(PIP_INIT, ({ payload }) => {
          if (!active) return;
          setState(payload.state);
          sourceLayout = payload.layout;
          syncAspect();
          applyLayout();
          setReady(true);
          if (started) return;
          started = true;
          void stream.connect(payload.framesUrl, frame => {
            if (!active) return;
            if (frameSize.width !== frame.width || frameSize.height !== frame.height) {
              frameSize = { width: frame.width, height: frame.height };
              syncAspect();
              applyLayout();
            }
            renderer.push(frame.width, frame.height, frame.pixels);
          }).catch(() => { if (active) setError("Не удалось получить видео. Откройте мини-плеер повторно."); });
        }, { target: { kind: "WebviewWindow", label: current.label } }).then(keep);
        await listen<PipState>(PIP_STATE, ({ payload }) => { if (active) setState(payload); }, { target: { kind: "WebviewWindow", label: current.label } }).then(keep);
        await listen<PipFrameLayout | null>(PIP_LAYOUT, ({ payload }) => {
          if (active) { sourceLayout = payload; syncAspect(); applyLayout(); }
        }, { target: { kind: "WebviewWindow", label: current.label } }).then(keep);
        await listen<string>(PIP_ERROR, ({ payload }) => { if (active) setError(payload); }, { target: { kind: "WebviewWindow", label: current.label } }).then(keep);
        const saved = storage.get<Bounds | null>("bounds", null);
        if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && saved.width >= PIP_MIN_WIDTH && saved.height >= PIP_MIN_HEIGHT) {
          const monitors = await availableMonitors();
          if (monitors.some(m => saved.x >= m.position.x && saved.y >= m.position.y && saved.x + saved.width <= m.position.x + m.size.width && saved.y + saved.height <= m.position.y + m.size.height)) {
            await current.setPosition(new PhysicalPosition(saved.x, saved.y));
            await current.setSize(new PhysicalSize(saved.width, saved.height));
          }
        }
        restored = true;
        await current.onMoved(save).then(keep);
        await current.onResized(save).then(keep);
        if (!active) return;
        await current.show();
        await emitTo("main", PIP_REQUEST);
      } catch (cause) {
        console.warn("[player.pip]", cause);
        if (active) { setError("Не удалось подключить мини-плеер. Закройте его и откройте снова."); await current.show().catch(() => {}); }
      }
    })();
    return () => { active = false; clearTimeout(saveTimer); resizeObserver.disconnect(); stops.forEach(stop => stop()); stream.close(); renderer.destroy(); };
  }, []);

  const command = (value: PipCommand) => {
    setError(null);
    void emitTo("main", PIP_COMMAND, value).catch(() => setError("Главное окно недоступно."));
  };
  const commitSeek = (position: number) => {
    if (scrub === null) return;
    command({ type: "seek", position });
    setScrub(null);
  };
  const onFreePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !isFreeArea(event.target)) return;
    drag.current = { x: event.clientX, y: event.clientY, moved: false };
  };
  const onFreePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const attempt = drag.current;
    if (!attempt || attempt.moved) return;
    if (Math.abs(event.clientX - attempt.x) + Math.abs(event.clientY - attempt.y) < DRAG_THRESHOLD_PX) return;
    attempt.moved = true;
    void getCurrentWebviewWindow().startDragging().catch(() => setError("Не удалось переместить окно."));
  };
  const onFreePointerUp = () => {
    const attempt = drag.current;
    drag.current = null;
    if (attempt && !attempt.moved && ready) command("toggle-pause");
  };

  const displayedPosition = scrub ?? state.position;
  const percent = state.duration > 0 ? Math.max(0, Math.min(100, displayedPosition / state.duration * 100)) : 0;
  return <main className="pip-window"
    onPointerDown={onFreePointerDown}
    onPointerMove={onFreePointerMove}
    onPointerUp={onFreePointerUp}
    onPointerCancel={() => { drag.current = null; }}
  >
    <canvas ref={canvas} className="pip-video" aria-label="Видео в отдельном окне" />
    {RESIZE_EDGES.map(direction => <div key={direction} className={`pip-resize pip-resize-${direction}`} aria-hidden="true"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        const attempt = { edge: direction, sx: event.screenX, sy: event.screenY, lx: event.screenX, ly: event.screenY, bounds: null as Bounds | null };
        resize.current = attempt;
        void Promise.all([getCurrentWebviewWindow().outerPosition(), getCurrentWebviewWindow().innerSize()]).then(([position, size]) => {
          if (resize.current !== attempt) return;
          attempt.bounds = { x: position.x, y: position.y, width: size.width, height: size.height };
          applyResize(attempt);
        }).catch(() => setError("Не удалось изменить размер окна."));
      }}
      onPointerMove={event => {
        const attempt = resize.current;
        if (!attempt) return;
        attempt.lx = event.screenX;
        attempt.ly = event.screenY;
        if (attempt.bounds) applyResize(attempt);
      }}
      onPointerUp={() => { resize.current = null; }}
      onPointerCancel={() => { resize.current = null; }}
    />)}
    <button className="pip-close pip-icon" type="button" aria-label="Закрыть мини-плеер" title="Закрыть"
      onClick={() => { void getCurrentWebviewWindow().close().catch(() => setError("Не удалось закрыть мини-плеер.")); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>
    {!ready && !error && <p className="pip-status" role="status">Подключаем видео…</p>}
    {error && <p className="pip-status" role="alert">{error}</p>}
    <div className="pip-controls" role="group" aria-label="Управление мини-плеером">
      <div className="pip-transport">
        <button className="pip-icon" type="button" disabled={!ready} onClick={() => command("toggle-pause")} aria-label={state.pause ? "Воспроизвести" : "Пауза"}><PlayPauseIcon paused={state.pause} /></button>
        <button className="pip-icon" type="button" disabled={!ready} onClick={() => command("back")} aria-label="Назад на 5 секунд"><SeekIcon forward={false} /></button>
        <button className="pip-icon" type="button" disabled={!ready} onClick={() => command("forward")} aria-label="Вперёд на 5 секунд"><SeekIcon forward /></button>
      </div>
      <div className="pip-timeline">
        <input className="pip-seek" type="range" min={0} max={Math.max(0, state.duration)} step={1}
          disabled={!ready || state.duration <= 0} value={displayedPosition}
          style={{ "--pip-progress": `${percent}%` } as CSSProperties}
          aria-label="Позиция воспроизведения" aria-valuetext={`${formatTime(displayedPosition)} / ${formatTime(state.duration)}`}
          onChange={event => setScrub(Number(event.target.value))}
          onPointerUp={event => commitSeek(Number(event.currentTarget.value))}
          onPointerCancel={() => setScrub(null)}
          onKeyUp={event => commitSeek(Number(event.currentTarget.value))}
          onBlur={event => commitSeek(Number(event.currentTarget.value))} />
        <span className="pip-time">{formatTime(displayedPosition)} / {formatTime(state.duration)}</span>
      </div>
    </div>
  </main>;
}

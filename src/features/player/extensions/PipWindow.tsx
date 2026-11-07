import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { availableMonitors } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { CanvasVideoRenderer, FrameStream } from "../frameSink";
import { formatTime } from "../playerHelpers";
import { createExtensionStorage } from "./storage";
import { PIP_COMMAND, PIP_ERROR, PIP_INIT, PIP_REQUEST, PIP_STATE, type PipCommand, type PipInit, type PipState } from "./pipProtocol";
import "./pipWindow.css";

type Bounds = { x: number; y: number; width: number; height: number };
export function PipWindow() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<PipState>({ position: 0, duration: 0, pause: true });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const stops: (() => void)[] = [];
    const stream = new FrameStream();
    const renderer = new CanvasVideoRenderer(canvas.current!);
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
          setReady(true);
          if (started) return;
          started = true;
          void stream.connect(payload.framesUrl, frame => {
            if (active) renderer.push(frame.width, frame.height, frame.pixels);
          }).catch(() => { if (active) setError("Не удалось получить видео. Откройте мини-плеер повторно."); });
        }, { target: { kind: "WebviewWindow", label: current.label } }).then(keep);
        await listen<PipState>(PIP_STATE, ({ payload }) => { if (active) setState(payload); }, { target: { kind: "WebviewWindow", label: current.label } }).then(keep);
        await listen<string>(PIP_ERROR, ({ payload }) => { if (active) setError(payload); }, { target: { kind: "WebviewWindow", label: current.label } }).then(keep);
        const saved = storage.get<Bounds | null>("bounds", null);
        if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && saved.width >= 280 && saved.height >= 210) {
          const monitors = await availableMonitors();
          if (monitors.some(m => saved.x >= m.position.x && saved.y >= m.position.y && saved.x + saved.width <= m.position.x + m.size.width && saved.y + saved.height + 40 <= m.position.y + m.size.height)) {
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
    return () => { active = false; clearTimeout(saveTimer); stops.forEach(stop => stop()); stream.close(); renderer.destroy(); };
  }, []);
  const command = (value: PipCommand) => {
    setError(null);
    void emitTo("main", PIP_COMMAND, value).catch(() => setError("Главное окно недоступно."));
  };
  return <main className="pip-window">
    <canvas ref={canvas} className="pip-video" aria-label="Видео в отдельном окне" />
    {!ready && !error && <p className="pip-status" role="status">Подключаем видео…</p>}
    {error && <p className="pip-status" role="alert">{error}</p>}
    <div className="pip-controls" role="group" aria-label="Управление мини-плеером">
      <button disabled={!ready} onClick={() => command("back")} aria-label="Назад на 10 секунд">−10</button>
      <button disabled={!ready} onClick={() => command("toggle-pause")} aria-label={state.pause ? "Воспроизвести" : "Пауза"}>{state.pause ? "▶" : "Ⅱ"}</button>
      <span>{formatTime(state.position)} / {formatTime(state.duration)}</span>
      <button disabled={!ready} onClick={() => command("forward")} aria-label="Вперёд на 10 секунд">+10</button>
      <button onClick={() => command("return")} title="Вернуться в главное окно" aria-label="Вернуться в главное окно">↗</button>
    </div>
  </main>;
}

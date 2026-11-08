import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { playerFramesUrl } from "../playerApi";
import type { PlayerExtension } from "./types";
import { PIP_COMMAND, PIP_ERROR, PIP_INIT, PIP_LABEL, PIP_LAYOUT, PIP_REQUEST, PIP_STATE, pipState } from "./pipProtocol";
import { parsePipFrameLayout, PIP_MIN_WIDTH, PIP_MIN_HEIGHT } from "./pipVideoLayout";
import { pipPresentation } from "./pipPresentation";

type Status = { open: boolean; pending: boolean; error: string | null };
function Toggle({ subscribe, getStatus, toggle }: {
  subscribe: (cb: () => void) => () => void;
  getStatus: () => Status;
  toggle: () => void;
}) {
  const state = useSyncExternalStore(subscribe, getStatus, getStatus);
  return <section>
    <button className="player-menu-item" type="button" disabled={state.pending} onClick={toggle}>
      {state.pending ? "Открываем мини-плеер…" : state.open ? "Закрыть мини-плеер" : "Мини-плеер поверх окон"}
    </button>
    {state.error && <p role="alert" className="player-menu-empty">{state.error}</p>}
  </section>;
}

export const pipMiniPlayer: PlayerExtension = {
  id: "pip-mini-player",
  name: "Мини-плеер поверх окон",
  setup(ctx) {
    let active = true;
    let pip: WebviewWindow | null = null;
    let generation = 0;
    let layoutPending = false;
    let layoutKey = "";
    // Один запрос через существующий мост, без изменений frame-wire и Rust.
    const readLayout = async () => {
      try {
        return parsePipFrameLayout(await ctx.mpv.command(["expand-text", "${osd-dimensions/w},${osd-dimensions/h},${osd-dimensions/ml},${osd-dimensions/mr},${osd-dimensions/mt},${osd-dimensions/mb}"]));
      } catch { return null; }
    };
    let status: Status = { open: false, pending: false, error: null };
    const listeners = new Set<() => void>();
    const stops: (() => void)[] = [];
    const update = (next: Partial<Status>) => {
      status = { ...status, ...next };
      listeners.forEach(cb => cb());
    };
    const fail = (error: unknown) => {
      console.warn("[player.pip]", error);
      if (active) update({ pending: false, error: "Не удалось открыть мини-плеер. Попробуйте ещё раз." });
    };
    const close = () => {
      generation++;
      if (pip && status.open) void pip.close().catch(fail);
      if (!pip && active) update({ pending: false });
    };
    const stopReturn = pipPresentation.registerReturn(close);
    const keep = (stop: () => void) => { if (active) stops.push(stop); else stop(); };
    const ready = isTauri() ? Promise.all([
      listen(PIP_REQUEST, async () => {
        if (!active || !pip) return;
        try {
          const requestGeneration = generation;
          const [framesUrl, layout] = await Promise.all([playerFramesUrl(), readLayout()]);
          if (active && pip && requestGeneration === generation) {
            layoutKey = JSON.stringify(layout);
            await emitTo(PIP_LABEL, PIP_INIT, { framesUrl, layout, state: pipState(ctx.getSnapshot()) });
            if (active && pip && requestGeneration === generation) pipPresentation.setActive(true);
          }
        } catch (error) { fail(error); }
      }, { target: { kind: "WebviewWindow", label: "main" } }).then(keep),
      listen<unknown>(PIP_COMMAND, async ({ payload }) => {
        if (!active || !pip) return;
        try {
          const snapshot = ctx.getSnapshot();
          if (typeof payload === "object" && payload !== null && "type" in payload && payload.type === "seek" && "position" in payload && typeof payload.position === "number" && Number.isFinite(payload.position)) {
            await ctx.transport.seek(Math.max(0, snapshot.duration > 0 ? Math.min(snapshot.duration, payload.position) : payload.position));
            return;
          }
          switch (payload) {
            case "toggle-pause": await ctx.transport.togglePause(); break;
            case "back": await ctx.transport.seek(Math.max(0, snapshot.position - 5)); break;
            case "forward": await ctx.transport.seek(snapshot.duration > 0 ? Math.min(snapshot.duration, snapshot.position + 5) : snapshot.position + 5); break;
          }
        } catch (error) {
          console.warn("[player.pip]", error);
          await emitTo(PIP_LABEL, PIP_ERROR, "Не удалось выполнить действие.").catch(() => {});
        }
      }, { target: { kind: "WebviewWindow", label: "main" } }).then(keep),
      getCurrentWebviewWindow().onCloseRequested(close).then(keep),
    ]) : Promise.resolve();
    // Обработчики регистрируются до открытия окна: первый запрос не потеряется.
    void ready.catch(fail);
    const toggle = async () => {
      if (pip || status.pending) { if (pip) close(); return; }
      if (!isTauri()) { update({ error: "Мини-плеер доступен в настольном приложении Seans." }); return; }
      update({ pending: true, error: null });
      const opening = ++generation;
      try {
        await ready;
        if (!active || opening !== generation) return;
        const created = new WebviewWindow(PIP_LABEL, {
          url: "index.html#/pip", title: "Seans — мини-плеер",
          width: 480, height: 270, minWidth: PIP_MIN_WIDTH, minHeight: PIP_MIN_HEIGHT,
          decorations: false, alwaysOnTop: true, resizable: true, center: true, visible: false,
          // Без parent: Windows скрывает owned-окно при сворачивании владельца.
        });
        pip = created;
        await created.once("tauri://created", () => {
          if (!active || opening !== generation) void created.close().catch(fail);
          else update({ open: true, pending: false });
        });
        await created.once("tauri://error", event => { pip = null; if (active) pipPresentation.setActive(false); update({ open: false }); fail(event.payload); });
        await created.once("tauri://destroyed", () => {
          if (pip === created) {
            pip = null;
            if (active) { pipPresentation.setActive(false); update({ open: false, pending: false }); }
          }
        });
      } catch (error) { pip = null; fail(error); }
    };
    const stopSnapshot = ctx.onSnapshot(snapshot => {
      if (pip && status.open) void emitTo(PIP_LABEL, PIP_STATE, pipState(snapshot)).catch(() => {});
    });
    const layoutTimer = setInterval(() => {
      if (!active || !pip || !status.open || layoutPending) return;
      const requestGeneration = generation;
      layoutPending = true;
      void readLayout().then(async layout => {
        if (!active || !pip || requestGeneration !== generation) return;
        const key = JSON.stringify(layout);
        if (key !== layoutKey) {
          layoutKey = key;
          await emitTo(PIP_LABEL, PIP_LAYOUT, layout);
        }
      }).catch(() => {}).finally(() => { layoutPending = false; });
    }, 500);
    const stopClose = ctx.onClose(close);
    const stopUi = ctx.ui.add("settings.menu", () => <Toggle
      subscribe={cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }}
      getStatus={() => status} toggle={() => { void toggle(); }}
    />);
    return () => {
      active = false;
      pipPresentation.setActive(false);
      stopReturn();
      clearInterval(layoutTimer);
      close();
      stopSnapshot(); stopClose(); stopUi();
      stops.forEach(stop => stop());
      listeners.clear();
    };
  },
};

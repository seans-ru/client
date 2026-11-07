import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { PlayerExtensionContext } from "../src/features/player/extensions/types";
import { DEFAULT_SNAPSHOT } from "../src/features/player/playerTypes";
import { PIP_COMMAND, PIP_INIT, PIP_LABEL, PIP_REQUEST } from "../src/features/player/extensions/pipProtocol";

const mock = vi.hoisted(() => ({
  events: new Map<string, (event: { payload: unknown }) => unknown>(),
  windows: [] as { options: Record<string, unknown>; events: Map<string, (event: { payload: unknown }) => unknown>; close: ReturnType<typeof vi.fn> }[],
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: mock.emit,
  listen: async (name: string, handler: (event: { payload: unknown }) => unknown) => {
    mock.events.set(name, handler);
    return () => { mock.events.delete(name); };
  },
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onCloseRequested: async () => () => {}, unminimize: async () => {}, setFocus: async () => {} }),
  WebviewWindow: class {
    events = new Map<string, (event: { payload: unknown }) => unknown>();
    close = vi.fn(async () => {});
    constructor(_label: string, public options: Record<string, unknown>) { mock.windows.push(this); }
    async once(name: string, handler: (event: { payload: unknown }) => unknown) { this.events.set(name, handler); return () => {}; }
  },
}));
vi.mock("../src/features/player/playerApi", () => ({ playerFramesUrl: async () => "http://127.0.0.1:1234/frames" }));
import { pipMiniPlayer } from "../src/features/player/extensions/pipMiniPlayer";
import { pipPresentation } from "../src/features/player/extensions/pipPresentation";

function setup() {
  let render: () => unknown = () => null;
  let sourceClosed = () => {};
  const transport = { togglePause: vi.fn(async () => {}), seek: vi.fn(async () => {}) };
  const ctx = {
    transport,
    mpv: { command: async () => "1920,1200,0,0,60,60" },
    getSnapshot: () => ({ ...DEFAULT_SNAPSHOT, position: 42, duration: 100, file_loaded: true }),
    onSnapshot: () => () => {},
    onClose: (callback: () => void) => { sourceClosed = callback; return () => {}; },
    ui: { add: (_slot: string, callback: () => unknown) => { render = callback; return () => {}; } },
  } as unknown as PlayerExtensionContext;
  const dispose = pipMiniPlayer.setup(ctx) as () => void;
  return {
    dispose, transport,
    closeSource: () => sourceClosed(),
    toggle: () => (render() as ReactElement<{ toggle: () => void }>).props.toggle(),
  };
}
beforeEach(() => { mock.events.clear(); mock.windows.length = 0; mock.emit.mockClear(); pipPresentation.setActive(false); });
describe("системное окно PiP", () => {
  it("открывает единственное независимое topmost-окно", async () => {
    const fixture = setup();
    fixture.toggle(); fixture.toggle();
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    expect(mock.windows[0].options).toMatchObject({ alwaysOnTop: true, decorations: false, url: "index.html#/pip" });
    expect(mock.windows[0].options).not.toHaveProperty("parent");
    fixture.dispose();
  });
  it("направляет управление в guarded transport, игнорирует неизвестные команды", async () => {
    const fixture = setup(); fixture.toggle();
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    await mock.events.get(PIP_COMMAND)!({ payload: "forward" });
    await mock.events.get(PIP_COMMAND)!({ payload: "toggle-pause" });
    await mock.events.get(PIP_COMMAND)!({ payload: "loadfile" });
    expect(fixture.transport.seek).toHaveBeenCalledExactlyOnceWith(47);
    expect(fixture.transport.togglePause).toHaveBeenCalledTimes(1);
    fixture.dispose();
  });
  it("передаёт таймбар в guarded transport и отсекает недопустимые позиции", async () => {
    const fixture = setup(); fixture.toggle();
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    const send = (position: unknown) => mock.events.get(PIP_COMMAND)!({ payload: { type: "seek", position } });
    await send(75); await send(-5); await send(120); await send(NaN); await send("60");
    expect(fixture.transport.seek.mock.calls).toEqual([[75], [0], [100]]);
    fixture.dispose();
  });
  it("передаёт геометрию изображения mpv вместе с подключением потока кадров", async () => {
    const fixture = setup(); fixture.toggle();
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    await mock.events.get(PIP_REQUEST)!({ payload: null });
    expect(mock.emit).toHaveBeenCalledWith(PIP_LABEL, PIP_INIT, {
      framesUrl: "http://127.0.0.1:1234/frames",
      state: { position: 42, duration: 100, pause: true },
      layout: { width: 1920, height: 1200, left: 0, right: 0, top: 60, bottom: 60 },
    });
    fixture.dispose();
  });
  it("отменяет незавершённое открытие при закрытии источника", async () => {
    const fixture = setup(); fixture.toggle(); fixture.closeSource();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mock.windows).toHaveLength(0);
    fixture.dispose();
  });
  it("передаёт изображение в PiP после подключения и возвращает после закрытия", async () => {
    const fixture = setup(); fixture.toggle();
    await vi.waitFor(() => expect(mock.windows[0]?.events.has("tauri://destroyed")).toBe(true));
    expect(pipPresentation.isActive()).toBe(false);
    mock.windows[0].events.get("tauri://created")!({ payload: null });
    await mock.events.get(PIP_REQUEST)!({ payload: null });
    expect(pipPresentation.isActive()).toBe(true);
    mock.windows[0].events.get("tauri://destroyed")!({ payload: null });
    expect(pipPresentation.isActive()).toBe(false);
    expect(fixture.transport.togglePause).not.toHaveBeenCalled();
    fixture.dispose();
  });
  it("возвращает изображение по кнопке основного окна только после закрытия PiP", async () => {
    const fixture = setup(); fixture.toggle();
    await vi.waitFor(() => expect(mock.windows[0]?.events.has("tauri://destroyed")).toBe(true));
    mock.windows[0].events.get("tauri://created")!({ payload: null });
    await mock.events.get(PIP_REQUEST)!({ payload: null });
    pipPresentation.returnToMain();
    expect(mock.windows[0].close).toHaveBeenCalledTimes(1);
    expect(pipPresentation.isActive()).toBe(true);
    mock.windows[0].events.get("tauri://destroyed")!({ payload: null });
    expect(pipPresentation.isActive()).toBe(false);
    fixture.dispose();
  });
  it("освобождает основной видеовывод при завершении сессии", async () => {
    const fixture = setup(); fixture.toggle();
    await vi.waitFor(() => expect(mock.windows[0]?.events.has("tauri://created")).toBe(true));
    mock.windows[0].events.get("tauri://created")!({ payload: null });
    await mock.events.get(PIP_REQUEST)!({ payload: null });
    fixture.dispose();
    expect(pipPresentation.isActive()).toBe(false);
    expect(mock.windows[0].close).toHaveBeenCalledTimes(1);
    pipPresentation.returnToMain();
    expect(mock.windows[0].close).toHaveBeenCalledTimes(1);
  });
  it("закрывает созданное окно, если источник закрылся до события created", async () => {
    const fixture = setup(); fixture.toggle();
    await vi.waitFor(() => expect(mock.windows[0]?.events.has("tauri://created")).toBe(true));
    fixture.closeSource();
    mock.windows[0].events.get("tauri://created")!({ payload: null });
    expect(mock.windows[0].close).toHaveBeenCalledTimes(1);
    fixture.dispose();
  });
});

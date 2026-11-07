import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { PlayerExtensionContext } from "../src/features/player/extensions/types";
import { DEFAULT_SNAPSHOT } from "../src/features/player/playerTypes";
import { PIP_COMMAND } from "../src/features/player/extensions/pipProtocol";

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

function setup() {
  let render: () => unknown = () => null;
  let sourceClosed = () => {};
  const transport = { togglePause: vi.fn(async () => {}), seek: vi.fn(async () => {}) };
  const ctx = {
    transport,
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
beforeEach(() => { mock.events.clear(); mock.windows.length = 0; mock.emit.mockClear(); });
describe("системное окно PiP", () => {
  it("открывает единственное независимое topmost-окно", async () => {
    const fixture = setup();
    fixture.toggle(); fixture.toggle();
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    expect(mock.windows[0].options).toMatchObject({ alwaysOnTop: true, url: "index.html#/pip" });
    expect(mock.windows[0].options).not.toHaveProperty("parent");
    fixture.dispose();
  });
  it("направляет управление в guarded transport, игнорирует неизвестные команды", async () => {
    const fixture = setup(); fixture.toggle();
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    await mock.events.get(PIP_COMMAND)!({ payload: "forward" });
    await mock.events.get(PIP_COMMAND)!({ payload: "toggle-pause" });
    await mock.events.get(PIP_COMMAND)!({ payload: "loadfile" });
    expect(fixture.transport.seek).toHaveBeenCalledExactlyOnceWith(52);
    expect(fixture.transport.togglePause).toHaveBeenCalledTimes(1);
    fixture.dispose();
  });
  it("отменяет незавершённое открытие при закрытии источника", async () => {
    const fixture = setup(); fixture.toggle(); fixture.closeSource();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mock.windows).toHaveLength(0);
    fixture.dispose();
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

/**
 * Command palette + rebindable hotkeys (issue #23).
 *
 * Palette modal in the `overlay` slot (Ctrl+K / Ctrl+P): search, Enter runs,
 * Esc closes, recent commands float to the top. Extensions contribute their
 * own actions through `ctx.registerCommand` (see `commands.ts`).
 *
 * Hotkeys: the default map lives in `hotkeys.ts` (Space, arrows, F, M, N =
 * bookmark, S = screenshot, I = stats …); user overrides persist in
 * `ctx.storage`. The rebinding table in `settings.menu` captures keys, flags
 * conflicts and can reset to defaults. The dispatch engine owns those keys
 * outright — the core `PlayerSurface` handler never sees them (capture-phase
 * supersede in `hotkeys.ts`).
 *
 * Bookmarks (N) and the screenshot command (S) live here as well: both are
 * palette-level actions with storage / mpv-bridge side effects only.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import {
  filterCommands,
  listCommands,
  orderForPalette,
  runCommand as busRunCommand,
  subscribeCommands,
  type RegisteredCommand,
} from "./commands";
import {
  attachHotkeyEngine,
  comboFromEvent,
  combosEqual,
  DEFAULT_KEYMAP,
  formatCombosForDisplay,
  parseCombo,
  type Keymap,
  type Unsubscribe,
} from "./hotkeys";
import { trapFocus } from "./focusTrap";
import { pipPresentation } from "./pipPresentation";
import { applySeekDelta, clampSpeed, SEEK_STEP_SEC } from "../playerHelpers";
import type {
  ExtensionStorage,
  PlayerCommand,
  PlayerExtension,
  PlayerExtensionContext,
} from "./types";
import { showToast } from "./toast";
import "./commandPalette.css";

/** Larger seek step for Shift+arrows (issue #23 default map). */
export const LARGE_SEEK_STEP_SEC = 30;

const HOTKEYS_KEY = "hotkeys";
const RECENT_KEY = "recent";
const BOOKMARKS_KEY = "bookmarks";
const RECENT_MAX = 6;
const BOOKMARKS_PER_FILE = 20;

type Bookmark = { pos: number; at: number };

/** Keys never accepted as bindings during capture. */
const CAPTURE_IGNORED_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "Tab",
  "CapsLock",
]);

/* ------------------------------------------------------------------ stores */

type PaletteStore = {
  subscribe(cb: () => void): Unsubscribe;
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
};

function createPaletteStore(): PaletteStore {
  let open = false;
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
    isOpen: () => open,
    open() {
      if (open) return;
      open = true;
      notify();
    },
    close() {
      if (!open) return;
      open = false;
      notify();
    },
    toggle() {
      open = !open;
      notify();
    },
  };
}

type HotkeyStore = {
  subscribe(cb: () => void): Unsubscribe;
  /** Merged `commandId -> combos` map (stable identity between changes). */
  getKeymap(): Keymap;
  setBinding(commandId: string, combos: readonly string[]): void;
  resetBinding(commandId: string): void;
  resetAll(): void;
  isCapturing(): boolean;
  setCapturing(commandId: string | null): void;
  subscribeCapture(cb: () => void): Unsubscribe;
};

function createHotkeyStore(storage: ExtensionStorage): HotkeyStore {
  const stored = storage.get<Record<string, string[]>>(HOTKEYS_KEY, {});
  let overrides: Record<string, string[]> =
    stored && typeof stored === "object" ? stored : {};
  let keymap: Keymap = { ...DEFAULT_KEYMAP, ...overrides };
  let capturing: string | null = null;
  const listeners = new Set<() => void>();
  const captureListeners = new Set<() => void>();
  const notify = () => {
    keymap = { ...DEFAULT_KEYMAP, ...overrides };
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getKeymap: () => keymap,
    setBinding(commandId, combos) {
      overrides = { ...overrides, [commandId]: [...combos] };
      storage.set(HOTKEYS_KEY, overrides);
      notify();
    },
    resetBinding(commandId) {
      const next = { ...overrides };
      delete next[commandId];
      overrides = next;
      storage.set(HOTKEYS_KEY, overrides);
      notify();
    },
    resetAll() {
      overrides = {};
      storage.set(HOTKEYS_KEY, overrides);
      notify();
    },
    isCapturing: () => capturing !== null,
    setCapturing(commandId) {
      capturing = commandId;
      for (const listener of [...captureListeners]) listener();
    },
    subscribeCapture(cb) {
      captureListeners.add(cb);
      return () => {
        captureListeners.delete(cb);
      };
    },
  };
}

type RecentStore = {
  get(): readonly string[];
  push(id: string): void;
};

function createRecentStore(storage: ExtensionStorage): RecentStore {
  const stored = storage.get<string[]>(RECENT_KEY, []);
  let recent = Array.isArray(stored)
    ? stored.filter((id): id is string => typeof id === "string")
    : [];
  return {
    get: () => recent,
    push(id) {
      recent = [id, ...recent.filter((x) => x !== id)].slice(0, RECENT_MAX);
      storage.set(RECENT_KEY, recent);
    },
  };
}

type BookmarkStore = {
  list(url: string): readonly Bookmark[];
  add(url: string, pos: number): Bookmark;
  clear(url: string): void;
};

function createBookmarkStore(storage: ExtensionStorage): BookmarkStore {
  const read = (): Record<string, Bookmark[]> => {
    const raw = storage.get<Record<string, Bookmark[]>>(BOOKMARKS_KEY, {});
    return raw && typeof raw === "object" ? raw : {};
  };
  return {
    list(url) {
      return read()[url] ?? [];
    },
    add(url, pos) {
      const all = read();
      const entry: Bookmark = { pos, at: Date.now() };
      all[url] = [entry, ...(all[url] ?? [])].slice(0, BOOKMARKS_PER_FILE);
      storage.set(BOOKMARKS_KEY, all);
      return entry;
    },
    clear(url) {
      const all = read();
      delete all[url];
      storage.set(BOOKMARKS_KEY, all);
    },
  };
}

/* -------------------------------------------------------------- hotkey UI */

function HotkeyRow({
  store,
  command,
  capturingId,
  onStartCapture,
  onReset,
}: {
  store: HotkeyStore;
  command: RegisteredCommand;
  capturingId: string | null;
  onStartCapture: (id: string) => void;
  onReset: (id: string) => void;
}): ReactElement {
  const keymap = useSyncExternalStore(store.subscribe, store.getKeymap);
  const capturing = capturingId === command.id;
  return (
    <div className="palette-hotkey-row">
      <button
        type="button"
        className={`palette-hotkey-key${capturing ? " palette-hotkey-key-capturing" : ""}`}
        onClick={() => onStartCapture(command.id)}
        aria-label={`Переназначить клавишу для «${command.title}»`}
      >
        {capturing ? "Нажмите клавишу…" : formatCombosForDisplay(keymap[command.id])}
      </button>
      <span className="palette-hotkey-title">{command.title}</span>
      <button
        type="button"
        className="palette-hotkey-reset"
        title="Сбросить к дефолту"
        aria-label={`Сбросить клавишу для «${command.title}»`}
        onClick={() => onReset(command.id)}
      >
        ⟲
      </button>
    </div>
  );
}

function HotkeySettings({ store }: { store: HotkeyStore }): ReactElement {
  const commands = useSyncExternalStore(subscribeCommands, listCommands);
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState("");

  const stopCapture = useCallback(() => {
    setCapturingId(null);
    store.setCapturing(null);
  }, [store]);

  const startCapture = useCallback(
    (id: string) => {
      setConflict("");
      setCapturingId(id);
      store.setCapturing(id);
    },
    [store],
  );

  // One-shot window listener while a row is capturing a key.
  useEffect(() => {
    if (!capturingId) return;
    const onKey = (event: KeyboardEvent) => {
      // Capture mode owns the keyboard: never let the combo leak anywhere.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        stopCapture();
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        store.setBinding(capturingId, []);
        stopCapture();
        return;
      }
      if (CAPTURE_IGNORED_KEYS.has(event.key)) return;
      const comboText = comboFromEvent(event);
      const parsed = parseCombo(comboText);
      if (!parsed?.key) return;

      // Conflict check: reject combos already owned by another command.
      const keymap = store.getKeymap();
      for (const [otherId, combos] of Object.entries(keymap)) {
        if (otherId === capturingId) continue;
        if (combos.some((c) => combosEqual(c, comboText))) {
          const other = commands.find((cmd) => cmd.id === otherId);
          setConflict(
            `Клавиша ${comboText} уже занята: ${other?.title ?? otherId}`,
          );
          stopCapture();
          return;
        }
      }
      store.setBinding(capturingId, [comboText]);
      stopCapture();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturingId, commands, stopCapture, store]);

  return (
    <section>
      <h4 className="player-menu-title">Горячие клавиши</h4>
      {conflict ? <p className="palette-conflict">{conflict}</p> : null}
      <div className="palette-hotkey-list">
        {commands.map((command) => (
          <HotkeyRow
            key={command.id}
            store={store}
            command={command}
            capturingId={capturingId}
            onStartCapture={startCapture}
            onReset={(id) => {
              if (capturingId === id) stopCapture();
              store.resetBinding(id);
            }}
          />
        ))}
      </div>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitem"
          className="player-menu-item"
          onClick={() => {
            stopCapture();
            store.resetAll();
          }}
        >
          Сбросить все клавиши к дефолту
        </button>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- palette UI */

function PaletteModal({
  palette,
  recent,
  hotkeys,
  onRun,
}: {
  palette: PaletteStore;
  recent: RecentStore;
  hotkeys: HotkeyStore;
  onRun: (command: RegisteredCommand) => void;
}): ReactElement | null {
  const open = useSyncExternalStore(palette.subscribe, palette.isOpen);
  const commands = useSyncExternalStore(subscribeCommands, listCommands);
  const keymap = useSyncExternalStore(hotkeys.subscribe, hotkeys.getKeymap);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Recency is read at render time (cheap: ~30 commands max).
  const entries = useMemo(() => {
    const ordered = orderForPalette(commands, recent.get());
    return filterCommands(ordered, query);
  }, [commands, query, open]);

  useEffect(() => {
    setSelected(0);
  }, [query, open]);

  // Focus trap + restore (issue #26 modal rules).
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trap = trapFocus(dialog, {
      autoFocus: false,
      restoreTo: document.activeElement as HTMLElement | null,
    });
    inputRef.current?.focus();
    return () => trap.release();
  }, [open]);

  if (!open) return null;

  const run = (command: RegisteredCommand | undefined) => {
    if (!command) return;
    onRun(command);
    setQuery("");
    palette.close();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      palette.close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) =>
        entries.length === 0 ? 0 : (index + 1) % entries.length,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) =>
        entries.length === 0 ? 0 : (index - 1 + entries.length) % entries.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      run(entries[selected]);
    }
  };

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setQuery("");
          palette.close();
        }
      }}
    >
      <div
        className="palette-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Командная палитра"
        data-player-modal
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder="Поиск команды…"
          value={query}
          aria-label="Поиск команды"
          onChange={(event) => setQuery(event.target.value)}
        />
        {entries.length === 0 ? (
          <p className="palette-empty">Ничего не найдено</p>
        ) : (
          <ul className="palette-list" role="listbox" aria-label="Команды">
            {entries.map((command, index) => (
              <li key={command.id} role="option" aria-selected={index === selected}>
                <button
                  type="button"
                  className={`palette-item${index === selected ? " palette-item-active" : ""}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => run(command)}
                >
                  <span className="palette-item-title">{command.title}</span>
                  {command.category ? (
                    <span className="palette-item-category">{command.category}</span>
                  ) : null}
                  <kbd className="palette-item-key">
                    {formatCombosForDisplay(keymap[command.id])}
                  </kbd>
                </button>
              </li>
            ))}
          </ul>
        )}
        <footer className="palette-hint">
          Enter — выполнить · ↑/↓ — выбор · Esc — закрыть · Ctrl+K — палитра
        </footer>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- commands */

function formatBookmarkPos(pos: number): string {
  const total = Math.max(0, Math.floor(pos));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function registerBaseCommands(
  ctx: PlayerExtensionContext,
  deps: {
    palette: PaletteStore;
    bookmarks: BookmarkStore;
  },
): Unsubscribe[] {
  const { palette, bookmarks } = deps;
  const offs: Unsubscribe[] = [];
  const register = (command: PlayerCommand) => {
    offs.push(ctx.registerCommand(command));
  };

  register({
    id: "playback.togglePause",
    title: "Пауза / воспроизведение",
    category: "Воспроизведение",
    keywords: ["play", "pause", "стоп", "пауза", "пробел"],
    run: () => ctx.transport.togglePause(),
  });
  register({
    id: "playback.seekBack",
    title: "Перемотка назад (5 с)",
    category: "Воспроизведение",
    keywords: ["seek", "перемотка", "назад"],
    run: () => {
      const s = ctx.getSnapshot();
      void ctx.transport.seek(
        applySeekDelta(s.position, -SEEK_STEP_SEC, s.duration),
      );
    },
  });
  register({
    id: "playback.seekForward",
    title: "Перемотка вперёд (5 с)",
    category: "Воспроизведение",
    keywords: ["seek", "перемотка", "вперёд"],
    run: () => {
      const s = ctx.getSnapshot();
      void ctx.transport.seek(
        applySeekDelta(s.position, SEEK_STEP_SEC, s.duration),
      );
    },
  });
  register({
    id: "playback.seekBackLarge",
    title: "Перемотка назад (30 с)",
    category: "Воспроизведение",
    keywords: ["seek", "перемотка", "назад", "крупно"],
    run: () => {
      const s = ctx.getSnapshot();
      void ctx.transport.seek(
        applySeekDelta(s.position, -LARGE_SEEK_STEP_SEC, s.duration),
      );
    },
  });
  register({
    id: "playback.seekForwardLarge",
    title: "Перемотка вперёд (30 с)",
    category: "Воспроизведение",
    keywords: ["seek", "перемотка", "вперёд", "крупно"],
    run: () => {
      const s = ctx.getSnapshot();
      void ctx.transport.seek(
        applySeekDelta(s.position, LARGE_SEEK_STEP_SEC, s.duration),
      );
    },
  });
  register({
    id: "playback.speedDown",
    title: "Уменьшить скорость",
    category: "Воспроизведение",
    keywords: ["speed", "скорость"],
    run: () => {
      const s = ctx.getSnapshot();
      void ctx.transport.setSpeed(clampSpeed(s.speed - 0.25));
    },
  });
  register({
    id: "playback.speedUp",
    title: "Увеличить скорость",
    category: "Воспроизведение",
    keywords: ["speed", "скорость"],
    run: () => {
      const s = ctx.getSnapshot();
      void ctx.transport.setSpeed(clampSpeed(s.speed + 0.25));
    },
  });
  register({
    id: "playback.speedReset",
    title: "Скорость 1×",
    category: "Воспроизведение",
    keywords: ["speed", "скорость", "сброс"],
    run: () => void ctx.transport.setSpeed(1),
  });
  register({
    id: "playback.fullscreen",
    title: "Полный экран",
    category: "Воспроизведение",
    keywords: ["fullscreen", "экран"],
    run: () => void ctx.transport.setFullscreen(!ctx.getSnapshot().fullscreen),
  });
  register({
    id: "volume.up",
    title: "Громкость +5",
    category: "Звук",
    keywords: ["volume", "громкость"],
    run: () => {
      const s = ctx.getSnapshot();
      void ctx.transport.setVolume(Math.min(100, s.volume + 5));
    },
  });
  register({
    id: "volume.down",
    title: "Громкость −5",
    category: "Звук",
    keywords: ["volume", "громкость"],
    run: () => {
      const s = ctx.getSnapshot();
      void ctx.transport.setVolume(Math.max(0, s.volume - 5));
    },
  });
  register({
    id: "playback.mute",
    title: "Звук вкл / выкл",
    category: "Звук",
    keywords: ["mute", "звук", "тишина"],
    run: () => void ctx.transport.setMute(!ctx.getSnapshot().mute),
  });
  register({
    id: "subtitles.toggle",
    title: "Субтитры вкл / выкл",
    category: "Дорожки",
    keywords: ["subtitles", "субтитры"],
    run: () => void ctx.mpv.command(["cycle", "sub-visibility"]),
  });
  register({
    id: "subtitles.next",
    title: "Следующая дорожка субтитров",
    category: "Дорожки",
    keywords: ["subtitles", "субтитры", "дорожка"],
    run: () => void ctx.mpv.command(["cycle", "sid"]),
  });
  register({
    id: "audio.next",
    title: "Следующая аудиодорожка",
    category: "Дорожки",
    keywords: ["audio", "аудио", "озвучка", "дорожка"],
    run: () => void ctx.mpv.command(["cycle", "aid"]),
  });
  register({
    id: "screenshot",
    title: "Скриншот",
    category: "Диагностика",
    keywords: ["screenshot", "скриншот", "кадр"],
    run: async () => {
      try {
        await ctx.mpv.command(["screenshot", "window"]);
        showToast("Скриншот сохранён");
      } catch {
        showToast("Не удалось сделать скриншот");
      }
    },
  });
  register({
    id: "bookmark.add",
    title: "Добавить закладку",
    category: "Закладки",
    keywords: ["bookmark", "закладка"],
    run: () => {
      const s = ctx.getSnapshot();
      const entry = bookmarks.add(s.url || "unknown", s.position);
      showToast(`Закладка: ${formatBookmarkPos(entry.pos)}`);
    },
  });
  register({
    id: "bookmark.gotoLast",
    title: "Перейти к последней закладке",
    category: "Закладки",
    keywords: ["bookmark", "закладка", "перейти"],
    run: () => {
      const s = ctx.getSnapshot();
      const last = bookmarks.list(s.url || "unknown")[0];
      if (!last) {
        showToast("Закладок нет");
        return;
      }
      void ctx.transport.seek(last.pos);
    },
  });
  register({
    id: "bookmark.clear",
    title: "Очистить закладки",
    category: "Закладки",
    keywords: ["bookmark", "закладка", "очистить"],
    run: () => {
      const s = ctx.getSnapshot();
      bookmarks.clear(s.url || "unknown");
      showToast("Закладки очищены");
    },
  });
  register({
    id: "palette.toggle",
    title: "Командная палитра",
    category: "Палитра",
    keywords: ["palette", "команды", "поиск"],
    run: () => palette.toggle(),
  });

  return offs;
}

/* ---------------------------------------------------------------- extension */

export const commandPalette: PlayerExtension = {
  id: "command-palette",
  name: "Командная палитра и хоткеи",
  setup(ctx): Unsubscribe {
    const palette = createPaletteStore();
    const hotkeys = createHotkeyStore(ctx.storage);
    const recent = createRecentStore(ctx.storage);
    const bookmarks = createBookmarkStore(ctx.storage);

    const runAndRemember = (id: string) => {
      recent.push(id);
      busRunCommand(id);
    };

    const commandOffs = registerBaseCommands(ctx, { palette, bookmarks });

    // Dispatch engine: owns the default keymap over the core handler.
    const stopEngine = attachHotkeyEngine(window, {
      getKeymap: () => hotkeys.getKeymap(),
      runCommand: runAndRemember,
      // Palette open / key capture / PiP owns the keyboard — engine idles
      // (matches the core handler being off while the mini player is up).
      isSuspended: () =>
        palette.isOpen() || hotkeys.isCapturing() || pipPresentation.isActive(),
    });

    const stopPalette = ctx.ui.add("overlay", () => (
      <PaletteModal
        palette={palette}
        recent={recent}
        hotkeys={hotkeys}
        onRun={(command) => runAndRemember(command.id)}
      />
    ));
    const stopHotkeysUi = ctx.ui.add("settings.menu", () => (
      <HotkeySettings store={hotkeys} />
    ));

    return () => {
      stopPalette();
      stopHotkeysUi();
      stopEngine();
      for (const off of commandOffs) off();
    };
  },
};

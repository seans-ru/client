/**
 * Stats overlay extension (issue #18) — "stats for nerds" panel.
 *
 * Eye button in `controls.secondary` + rows in `settings.menu`; the panel
 * itself renders into the `overlay` slot (compact semi-transparent card over
 * the video, collapsible). Metrics come from `ctx.mpv.getProperty` polled at
 * 1 Hz while visible (never faster — issue limit 1–2 р/с); failed reads show
 * «—» and never log. «Копировать» puts every metric into the clipboard.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import type {
  ExtensionStorage,
  PlayerExtension,
  PlayerExtensionContext,
  Unsubscribe,
} from "./types";
import { showToast } from "./toast";
import {
  copyTextToClipboard,
  metricsToClipboardText,
  resolveMetricValues,
  STATS_METRICS,
  STATS_PROPERTY_NAMES,
  DASH,
} from "./statsPolicy";
import "./statsOverlay.css";

const VISIBLE_KEY = "visible";
const COLLAPSED_KEY = "collapsed";

/** Metric refresh period while the panel is open (issue: 1–2 р/с). */
const POLL_MS = 1000;

type StatsStore = {
  subscribe(cb: () => void): Unsubscribe;
  isVisible(): boolean;
  isCollapsed(): boolean;
  setVisible(next: boolean): void;
  toggleVisible(): void;
  setCollapsed(next: boolean): void;
};

function createStatsStore(storage: ExtensionStorage): StatsStore {
  let visible = Boolean(storage.get(VISIBLE_KEY, false));
  let collapsed = Boolean(storage.get(COLLAPSED_KEY, false));
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
    isVisible: () => visible,
    isCollapsed: () => collapsed,
    setVisible(next) {
      visible = next;
      storage.set(VISIBLE_KEY, next);
      notify();
    },
    toggleVisible() {
      visible = !visible;
      storage.set(VISIBLE_KEY, visible);
      notify();
    },
    setCollapsed(next) {
      collapsed = next;
      storage.set(COLLAPSED_KEY, next);
      notify();
    },
  };
}

function EyeIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M1.8 9c1.6-3 4.2-4.6 7.2-4.6S14.6 6 16.2 9c-1.6 3-4.2 4.6-7.2 4.6S3.4 12 1.8 9z"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
      <circle cx="9" cy="9" r="2.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      {open ? null : (
        <path d="M3.5 3.5l11 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      )}
    </svg>
  );
}

function StatsButton({
  store,
}: {
  store: StatsStore;
}): ReactElement {
  const visible = useSyncExternalStore(store.subscribe, store.isVisible);
  return (
    <button
      type="button"
      className={`player-icon-btn${visible ? " player-icon-btn-active" : ""}`}
      aria-label={visible ? "Скрыть статистику" : "Показать статистику"}
      aria-pressed={visible}
      title="Статистика воспроизведения"
      onClick={() => store.toggleVisible()}
    >
      <EyeIcon open={visible} />
    </button>
  );
}

type StatsValues = Map<string, string>;

/** Poll mpv properties at 1 Hz; failures resolve to «—» silently. */
function useStatsValues(
  ctx: PlayerExtensionContext,
  active: boolean,
): StatsValues {
  const [values, setValues] = useState<StatsValues>(() => new Map());
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const tick = async () => {
      const bridge = ctxRef.current.mpv;
      const props: Record<string, string | null> = {};
      await Promise.all(
        STATS_PROPERTY_NAMES.map(async (name) => {
          try {
            props[name] = await bridge.getProperty(name);
          } catch {
            // Unreadable property → dash; never spam the console (issue #18).
            props[name] = null;
          }
        }),
      );
      if (cancelled) return;
      const snapshot = ctxRef.current.getSnapshot();
      setValues(
        resolveMetricValues({
          props,
          snapshot: {
            hwdec: snapshot.hwdec,
            vo: snapshot.vo,
            position: snapshot.position,
            speed: snapshot.speed,
            video_w: snapshot.video_w,
            video_h: snapshot.video_h,
          },
        }),
      );
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  return values;
}

function StatsPanel({
  ctx,
  store,
}: {
  ctx: PlayerExtensionContext;
  store: StatsStore;
}): ReactElement | null {
  const visible = useSyncExternalStore(store.subscribe, store.isVisible);
  const collapsed = useSyncExternalStore(store.subscribe, store.isCollapsed);
  const values = useStatsValues(ctx, visible);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(metricsToClipboardText(values));
    showToast(ok ? "Метрики скопированы" : "Не удалось скопировать");
    if (ok) {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    }
  }, [values]);

  if (!visible) return null;

  const rows = STATS_METRICS.filter((m) => m.id !== "resolutionH").map(
    (metric) => (
      <div className="stats-row" key={metric.id}>
        <span className="stats-label">{metric.label}</span>
        <span className="stats-value">{values.get(metric.id) ?? DASH}</span>
      </div>
    ),
  );

  return (
    <section className="stats-panel" aria-label="Статистика воспроизведения">
      <header className="stats-header">
        <span className="stats-title">Статистика</span>
        <button
          type="button"
          className="stats-icon-btn"
          aria-label={collapsed ? "Развернуть статистику" : "Свернуть статистику"}
          title={collapsed ? "Развернуть" : "Свернуть"}
          onClick={() => store.setCollapsed(!collapsed)}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button
          type="button"
          className="stats-icon-btn"
          aria-label="Скопировать метрики"
          title="Скопировать метрики"
          onClick={() => void onCopy()}
        >
          {copied ? "✓" : "⧉"}
        </button>
        <button
          type="button"
          className="stats-icon-btn"
          aria-label="Закрыть статистику"
          title="Закрыть"
          onClick={() => store.setVisible(false)}
        >
          ✕
        </button>
      </header>
      {collapsed ? (
        <div className="stats-row stats-summary">
          <span className="stats-value">
            {values.get("resolution") ?? DASH} · {values.get("fpsDisplay") ?? DASH} fps ·{" "}
            {values.get("videoCodec") ?? DASH}
          </span>
        </div>
      ) : (
        <div className="stats-body">{rows}</div>
      )}
    </section>
  );
}

function StatsSettingsRow({
  store,
  onCopy,
}: {
  store: StatsStore;
  onCopy: () => void;
}): ReactElement {
  const visible = useSyncExternalStore(store.subscribe, store.isVisible);
  const collapsed = useSyncExternalStore(store.subscribe, store.isCollapsed);
  return (
    <section>
      <h4 className="player-menu-title">Статистика</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={visible}
          className={`player-menu-item${visible ? " player-menu-item-active" : ""}`}
          onClick={() => store.setVisible(!visible)}
        >
          {visible ? "Панель показана" : "Панель скрыта"}
        </button>
        <button
          type="button"
          role="menuitem"
          className="player-menu-item"
          onClick={() => store.setCollapsed(!collapsed)}
        >
          {collapsed ? "Развернуть панель" : "Свернуть панель"}
        </button>
        <button type="button" role="menuitem" className="player-menu-item" onClick={onCopy}>
          Скопировать метрики
        </button>
      </div>
    </section>
  );
}

export const statsOverlay: PlayerExtension = {
  id: "stats-overlay",
  name: "Статистика воспроизведения",
  setup(ctx): Unsubscribe {
    const store = createStatsStore(ctx.storage);

    // Refresh once before copying so copies made from settings are not stale.
    const copyLatest = async () => {
      const props: Record<string, string | null> = {};
      await Promise.all(
        STATS_PROPERTY_NAMES.map(async (name) => {
          try {
            props[name] = await ctx.mpv.getProperty(name);
          } catch {
            props[name] = null;
          }
        }),
      );
      const snapshot = ctx.getSnapshot();
      const values = resolveMetricValues({
        props,
        snapshot: {
          hwdec: snapshot.hwdec,
          vo: snapshot.vo,
          position: snapshot.position,
          speed: snapshot.speed,
          video_w: snapshot.video_w,
          video_h: snapshot.video_h,
        },
      });
      const ok = await copyTextToClipboard(metricsToClipboardText(values));
      showToast(ok ? "Метрики скопированы" : "Не удалось скопировать");
    };

    const stopEye = ctx.ui.add("controls.secondary", () => <StatsButton store={store} />);
    const stopRow = ctx.ui.add("settings.menu", () => (
      <StatsSettingsRow store={store} onCopy={() => void copyLatest()} />
    ));
    const stopPanel = ctx.ui.add("overlay", () => <StatsPanel ctx={ctx} store={store} />);

    const stopCommand = ctx.registerCommand({
      id: "stats.toggle",
      title: "Статистика воспроизведения",
      category: "Диагностика",
      keywords: ["stats", "кодек", "fps", "битрейт", "nerds"],
      run: () => store.toggleVisible(),
    });

    return () => {
      stopEye();
      stopRow();
      stopPanel();
      stopCommand();
    };
  },
};

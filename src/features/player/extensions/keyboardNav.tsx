/**
 * Keyboard / remote / gesture navigation (issue #26) — the accessibility
 * and TV-port foundation.
 *
 * Focus system: a visible focus ring (keyboardNav.css), modal focus trap for
 * the core settings menu (`.player-menu-panel`, MutationObserver) and shared
 * `focusTrap.ts` used by the palette. Tab order is the DOM zone order
 * (seek → buttons → slots) — no core changes needed.
 *
 * D-pad model: up/down volume, left/right seek (Shift = 30 s), OK/Enter
 * play/pause, Back/Esc close overlay / exit fullscreen — all of it flows
 * through the shared keymap (`hotkeys.ts`), so it is rebindable in the
 * palette settings and works over the existing shortcuts.
 *
 * Gestures (touch / trackpad emulation on the video area): single tap
 * play/pause, double-tap left/right thirds ±10 s, vertical drag on the left
 * edge = volume, right edge = brightness (mpv `brightness` property),
 * downward flick in the center exits fullscreen. The seek bar already has
 * native horizontal drag (issue #26 is covered there by `PlayerControls`).
 * Settings (on/off + sensitivity) live in `ctx.storage`.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type {
  ExtensionStorage,
  PlayerExtension,
  Unsubscribe,
} from "./types";
import { trapFocus, type FocusTrap } from "./focusTrap";
import { pipPresentation } from "./pipPresentation";
import { showToast } from "./toast";
import {
  BRIGHTNESS_PER_PX,
  clampBrightness,
  clampSensitivity,
  clampVolume,
  classifySwipe,
  classifyTap,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SEEK_SEC,
  deltaFromSwipe,
  SENSITIVITY_OPTIONS,
  SWIPE_THRESHOLD_PX,
  tapZoneForX,
  TAP_SLOP_PX,
  VOLUME_PER_PX,
  type TapRecord,
} from "./gesturePolicy";
import "./keyboardNav.css";

const GESTURES_KEY = "gesturesEnabled";
const SENSITIVITY_KEY = "gestureSensitivity";

type NavSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getGesturesEnabled(): boolean;
  getSensitivity(): number;
  setGesturesEnabled(next: boolean): void;
  setSensitivity(next: number): void;
};

function createSettings(storage: ExtensionStorage): NavSettings {
  let enabled = Boolean(storage.get(GESTURES_KEY, true));
  let sensitivity = clampSensitivity(storage.get(SENSITIVITY_KEY, 1));
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
    getGesturesEnabled: () => enabled,
    getSensitivity: () => sensitivity,
    setGesturesEnabled(next) {
      enabled = next;
      storage.set(GESTURES_KEY, next);
      notify();
    },
    setSensitivity(next) {
      sensitivity = clampSensitivity(next);
      storage.set(SENSITIVITY_KEY, sensitivity);
      notify();
    },
  };
}

function NavSettingsRow({ settings }: { settings: NavSettings }): ReactElement {
  const enabled = useSyncExternalStore(
    settings.subscribe,
    settings.getGesturesEnabled,
  );
  const sensitivity = useSyncExternalStore(
    settings.subscribe,
    settings.getSensitivity,
  );
  return (
    <section>
      <h4 className="player-menu-title">Жесты</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={enabled}
          className={`player-menu-item${enabled ? " player-menu-item-active" : ""}`}
          onClick={() => settings.setGesturesEnabled(!enabled)}
        >
          {enabled ? "Жесты включены" : "Жесты выключены"}
        </button>
      </div>
      <h4 className="player-menu-title">Чувствительность</h4>
      <div className="player-menu-row">
        {SENSITIVITY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={option.value === sensitivity}
            className={`player-chip${option.value === sensitivity ? " player-chip-active" : ""}`}
            onClick={() => settings.setSensitivity(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Target hit-testing for gesture listeners (window-level, no DOM refs).
 * Excludes popup children, status-screen buttons and any interactive
 * control — gestures only speak for the bare video surface.
 */
function videoAreaFor(target: unknown): HTMLElement | null {
  const el = target as (Element & { closest?: (s: string) => Element | null }) | null;
  if (!el || typeof el.closest !== "function") return null;
  const area = el.closest(".player-video-area");
  if (!area) return null;
  if (
    el.closest(
      "button, input, select, textarea, a[href], [role='button'], [role='menuitem'], [role='slider'], .player-surface-status, .player-overlay-layer",
    )
  ) {
    return null;
  }
  return area as HTMLElement;
}

/**
 * Watch for the core settings panel (`.player-menu-panel`, portaled into the
 * overlay layer) and trap focus inside it while it is open (issue #26:
 * "модалки — ловушка фокуса + Esc"; Escape closing is core behavior).
 */
export function watchSettingsMenuFocus(): Unsubscribe {
  let trap: FocusTrap | null = null;
  let panel: HTMLElement | null = null;

  const release = () => {
    trap?.release();
    trap = null;
    panel = null;
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof HTMLElement &&
          node.matches(".player-menu-panel") &&
          node !== panel
        ) {
          release();
          panel = node;
          trap = trapFocus(node, {
            autoFocus: true,
            restoreTo: document.activeElement as HTMLElement | null,
          });
        }
      }
      for (const node of record.removedNodes) {
        if (node === panel) release();
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    release();
  };
}

type GestureHandlers = {
  togglePause(): void;
  seekBy(delta: number): void;
  setVolume(value: number): void;
  getVolume(): number;
  exitFullscreen(): void;
  isFullscreen(): boolean;
  seedBrightness(): Promise<number | null>;
  applyBrightness(value: number): void;
  getBrightness(): number;
};

/**
 * Pointer gesture recognizer over the video area. Touch taps are handled
 * here (delayed single-tap so double-tap zones work) and their synthetic
 * clicks are suppressed; mouse keeps native clicks and adds `dblclick`
 * zone seeks; swipes apply live (volume / brightness) and suppress their
 * trailing click.
 */
export function attachGestures(
  target: EventTarget,
  handlers: GestureHandlers,
  options: { isEnabled: () => boolean; getSensitivity: () => number },
): Unsubscribe {
  type LockedKind = "volume" | "brightness" | "exit-fullscreen" | "none";
  type DragState = {
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    area: HTMLElement;
    kind: LockedKind | null;
    volumeBase: number;
    brightnessBase: number;
  };

  let drag: DragState | null = null;
  let lastTap: TapRecord | null = null;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressClick = false;

  const clearTapTimer = () => {
    if (tapTimer !== null) {
      clearTimeout(tapTimer);
      tapTimer = null;
    }
  };

  const onPointerDown = (event: Event) => {
    if (!options.isEnabled()) return;
    if (pipPresentation.isActive()) return;
    const e = event as unknown as PointerEvent & { target?: unknown };
    const area = videoAreaFor(e.target);
    if (!area) return;
    const rect = area.getBoundingClientRect();
    drag = {
      pointerId: e.pointerId,
      pointerType: String(e.pointerType ?? "mouse"),
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      area,
      kind: null,
      volumeBase: handlers.getVolume(),
      brightnessBase: handlers.getBrightness(),
    };
    // Seed mpv brightness once so the first right-edge swipe is relative.
    void handlers.seedBrightness();
  };

  const onPointerMove = (event: Event) => {
    const e = event as unknown as PointerEvent & { target?: unknown };
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!options.isEnabled()) return;
    const rect = drag.area.getBoundingClientRect();
    const dx = e.clientX - rect.left - drag.startX;
    const dy = e.clientY - rect.top - drag.startY;
    const distance = Math.hypot(dx, dy);
    const sensitivity = options.getSensitivity();

    if (drag.kind === null) {
      if (distance < TAP_SLOP_PX) return;
      const kind = classifySwipe({
        dx,
        dy,
        startX: drag.startX,
        width: rect.width,
        fullscreen: handlers.isFullscreen(),
        threshold: SWIPE_THRESHOLD_PX,
      });
      if (distance < SWIPE_THRESHOLD_PX && kind === null) return;
      drag.kind = kind ?? "none";
      if (drag.kind !== "none") suppressClick = true;
    }

    if (drag.kind === "volume") {
      handlers.setVolume(
        clampVolume(
          drag.volumeBase + deltaFromSwipe(dy, sensitivity, VOLUME_PER_PX),
        ),
      );
      return;
    }
    if (drag.kind === "brightness") {
      handlers.applyBrightness(
        clampBrightness(
          drag.brightnessBase +
            deltaFromSwipe(dy, sensitivity, BRIGHTNESS_PER_PX),
        ),
      );
      return;
    }
    if (drag.kind === "exit-fullscreen") {
      drag.kind = "none";
      handlers.exitFullscreen();
    }
  };

  const onPointerUp = (event: Event) => {
    const e = event as unknown as PointerEvent & { target?: unknown };
    if (!drag || e.pointerId !== drag.pointerId) return;
    const state = drag;
    drag = null;
    if (!options.isEnabled()) return;

    // A recognized swipe already applied its action (and ate the click).
    if (state.kind !== null && state.kind !== "none") {
      if (state.kind === "brightness") {
        showToast(`Яркость: ${handlers.getBrightness()}`);
      }
      return;
    }

    const rect = state.area.getBoundingClientRect();
    const dx = e.clientX - rect.left - state.startX;
    const dy = e.clientY - rect.top - state.startY;
    if (Math.hypot(dx, dy) >= TAP_SLOP_PX) {
      // Unrecognized drag: swallow the trailing click on touch.
      if (state.pointerType !== "mouse") suppressClick = true;
      return;
    }

    // Tap (movement below slop).
    if (state.pointerType === "mouse") {
      // Native click does play/pause; `dblclick` handles the zones.
      return;
    }

    // Touch/pen: suppress the synthetic click and resolve single/double.
    suppressClick = true;
    const zone = tapZoneForX(state.startX, rect.width);
    const next: TapRecord = { zone, time: Date.now() };
    const kind = classifyTap(lastTap, next, DOUBLE_TAP_MS);
    if (kind === "double") {
      lastTap = null;
      clearTapTimer();
      if (zone === "left") handlers.seekBy(-DOUBLE_TAP_SEEK_SEC);
      else if (zone === "right") handlers.seekBy(DOUBLE_TAP_SEEK_SEC);
      else handlers.togglePause();
      return;
    }
    lastTap = next;
    clearTapTimer();
    tapTimer = setTimeout(() => {
      tapTimer = null;
      lastTap = null;
      handlers.togglePause();
    }, DOUBLE_TAP_MS);
  };

  const onDblClick = (event: Event) => {
    if (!options.isEnabled()) return;
    if (pipPresentation.isActive()) return;
    const e = event as unknown as MouseEvent & { target?: unknown };
    const area = videoAreaFor(e.target);
    if (!area) return;
    const rect = area.getBoundingClientRect();
    const zone = tapZoneForX(e.clientX - rect.left, rect.width);
    if (zone === "left") handlers.seekBy(-DOUBLE_TAP_SEEK_SEC);
    else if (zone === "right") handlers.seekBy(DOUBLE_TAP_SEEK_SEC);
  };

  const onClick = (event: Event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault?.();
    (event as unknown as { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
  };

  const onPointerCancel = (event: Event) => {
    const e = event as unknown as PointerEvent;
    if (drag && e.pointerId === drag.pointerId) drag = null;
    clearTapTimer();
    lastTap = null;
  };

  target.addEventListener("pointerdown", onPointerDown as EventListener, true);
  target.addEventListener("pointermove", onPointerMove as EventListener, true);
  target.addEventListener("pointerup", onPointerUp as EventListener, true);
  target.addEventListener("pointercancel", onPointerCancel as EventListener, true);
  target.addEventListener("dblclick", onDblClick as EventListener, true);
  target.addEventListener("click", onClick as EventListener, true);

  return () => {
    target.removeEventListener("pointerdown", onPointerDown as EventListener, true);
    target.removeEventListener("pointermove", onPointerMove as EventListener, true);
    target.removeEventListener("pointerup", onPointerUp as EventListener, true);
    target.removeEventListener("pointercancel", onPointerCancel as EventListener, true);
    target.removeEventListener("dblclick", onDblClick as EventListener, true);
    target.removeEventListener("click", onClick as EventListener, true);
    clearTapTimer();
    drag = null;
  };
}

/* ---------------------------------------------------------------- extension */

export const keyboardNav: PlayerExtension = {
  id: "keyboard-nav",
  name: "Клавиатура, пульт и жесты",
  setup(ctx): Unsubscribe {
    const settings = createSettings(ctx.storage);
    let brightness = 0;

    // Focus system: ring styles come from keyboardNav.css; the settings
    // menu gets a focus trap (the palette traps itself).
    document.body.classList.add("seans-nav-ready");
    const stopMenuWatch = watchSettingsMenuFocus();

    const stopRow = ctx.ui.add("settings.menu", () => (
      <NavSettingsRow settings={settings} />
    ));

    const stopBack = ctx.registerCommand({
      id: "nav.back",
      title: "Назад / закрыть",
      category: "Навигация",
      keywords: ["back", "escape", "назад", "закрыть"],
      run: () => {
        // Open modals consume Escape themselves (palette) or already have a
        // core close handler (settings menu) — only global actions remain.
        if (document.querySelector(".player-menu-panel, [data-player-modal]")) {
          return;
        }
        if (ctx.getSnapshot().fullscreen) {
          void ctx.transport.setFullscreen(false);
        }
      },
    });

    const stopGesturesCmd = ctx.registerCommand({
      id: "gestures.toggle",
      title: "Жесты вкл / выкл",
      category: "Навигация",
      keywords: ["gestures", "жесты", "тач"],
      run: () => settings.setGesturesEnabled(!settings.getGesturesEnabled()),
    });

    const stopGestures = attachGestures(
      window,
      {
        togglePause: () => {
          if (ctx.getSnapshot().file_loaded) void ctx.transport.togglePause();
        },
        seekBy: (delta) => {
          const s = ctx.getSnapshot();
          if (!s.file_loaded) return;
          const target = Math.min(
            s.duration > 0 ? s.duration : Number.POSITIVE_INFINITY,
            Math.max(0, s.position + delta),
          );
          void ctx.transport.seek(target);
        },
        setVolume: (value) => void ctx.transport.setVolume(value),
        getVolume: () => ctx.getSnapshot().volume,
        exitFullscreen: () => void ctx.transport.setFullscreen(false),
        isFullscreen: () => ctx.getSnapshot().fullscreen,
        seedBrightness: async () => {
          try {
            const raw = await ctx.mpv.getProperty("brightness");
            const n = Number(raw);
            if (Number.isFinite(n)) brightness = n;
          } catch {
            // Read failure: keep the local default; writes may still work.
          }
          return brightness;
        },
        applyBrightness: (value) => {
          brightness = value;
          void ctx.mpv.setProperty("brightness", value).catch(() => {
            // Some VOs ignore brightness — silently keep the local value.
          });
        },
        getBrightness: () => brightness,
      },
      {
        isEnabled: () => settings.getGesturesEnabled(),
        getSensitivity: () => settings.getSensitivity(),
      },
    );

    // Gestures toggle drives the touch-action CSS hook.
    const applyBodyClass = () => {
      document.body.classList.toggle(
        "seans-gestures-on",
        settings.getGesturesEnabled(),
      );
    };
    applyBodyClass();
    const stopSettingsWatch = settings.subscribe(applyBodyClass);

    return () => {
      stopRow();
      stopBack();
      stopGesturesCmd();
      stopGestures();
      stopMenuWatch();
      stopSettingsWatch();
      document.body.classList.remove("seans-nav-ready", "seans-gestures-on");
    };
  },
};

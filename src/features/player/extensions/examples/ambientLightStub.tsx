/**
 * Example extension (spec: docs/compose/spec/player-extensibility.md §S2.8) —
 * "ambient light" stub. Demonstrates the frame tap + overlay slot. When
 * enabled it paints a small badge with the average color of the latest frame
 * sample — it does NOT glow around the app (that is the out-of-scope real
 * feature; see the sketch at the bottom).
 *
 * The toggle store below is the documented pattern for extension UI with
 * shared state across slots: slot renders are independent React subtrees.
 */

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import type {
  FrameSample,
  PlayerExtension,
  PlayerExtensionContext,
  Unsubscribe,
} from "../types";

const ENABLED_KEY = "enabled";

/** Average RGB of a stride-sampled frame -> CSS color. */
export function averageFrameColor(sample: FrameSample): string {
  const pixels = sample.rgb;
  const count = sample.width * sample.height;
  if (count <= 0 || pixels.length < count * 3) return "#000";
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < count * 3; i += 3) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
  }
  return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
}

/** Tiny observable boolean (persisted) shared by both slots of the stub. */
function createToggleStore(ctx: PlayerExtensionContext) {
  let value = ctx.storage.get(ENABLED_KEY, false);
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => value,
    set(next: boolean): void {
      value = next;
      ctx.storage.set(ENABLED_KEY, next);
      for (const listener of [...listeners]) listener();
    },
  };
}

type ToggleStore = ReturnType<typeof createToggleStore>;

function AmbientBadge({
  ctx,
  toggle,
}: {
  ctx: PlayerExtensionContext;
  toggle: ToggleStore;
}): ReactElement | null {
  const enabled = useSyncExternalStore(toggle.subscribe, toggle.get);
  const [color, setColor] = useState("#000");

  useEffect(() => {
    if (!enabled) return;
    // Frame tap (§S2.6): throttled downsampled frames, ~5 fps is plenty.
    return ctx.frames.subscribe(
      (sample) => {
        setColor(averageFrameColor(sample));
      },
      { maxFps: 5 },
    );
  }, [ctx, enabled]);

  if (!enabled) return null;
  return (
    <div
      title="Пример расширения: средний цвет кадра"
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        width: 28,
        height: 28,
        borderRadius: 8,
        background: color,
        border: "1px solid rgba(255,255,255,0.35)",
        pointerEvents: "none",
      }}
    />
  );
}

function AmbientLightRow({ toggle }: { toggle: ToggleStore }): ReactElement {
  const enabled = useSyncExternalStore(toggle.subscribe, toggle.get);
  return (
    <section>
      <h4 className="player-menu-title">Ambient-освещение (пример)</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={enabled}
          className={`player-menu-item${enabled ? " player-menu-item-active" : ""}`}
          onClick={() => toggle.set(!enabled)}
        >
          {enabled ? "Включено (только бейдж)" : "Выключено"}
        </button>
      </div>
    </section>
  );
}

export const ambientLightStub: PlayerExtension = {
  id: "example-ambient-light",
  name: "Ambient-освещение (пример)",
  setup(ctx): Unsubscribe | void {
    const toggle = createToggleStore(ctx);
    ctx.ui.add("settings.menu", () => <AmbientLightRow toggle={toggle} />);
    ctx.ui.add("overlay", () => <AmbientBadge ctx={ctx} toggle={toggle} />);
    // The real ambient feature would tint the app shell from the same sample:
    //   ctx.frames.subscribe((s) => {
    //     document.documentElement.style.setProperty(
    //       "--ambient", averageFrameColor(s));
    //   }, { maxFps: 10 });
  },
};

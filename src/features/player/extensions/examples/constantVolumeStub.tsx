/**
 * Example extension (spec: docs/compose/spec/player-extensibility.md §S2.8) —
 * "constant volume" stub. INERT by design: it demonstrates the settings-slot +
 * storage + mpv-bridge wiring without changing audio. The real loudnorm
 * behavior is out of scope; the sketch below shows the calls a real
 * implementation would make.
 */

import { useState, type ReactElement } from "react";
import type {
  PlayerExtension,
  PlayerExtensionContext,
  Unsubscribe,
} from "../types";

const ENABLED_KEY = "enabled";

function ConstantVolumeRow({
  ctx,
}: {
  ctx: PlayerExtensionContext;
}): ReactElement {
  const [enabled, setEnabled] = useState(() =>
    ctx.storage.get(ENABLED_KEY, false),
  );
  const [af, setAf] = useState<string | null>(null);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    ctx.storage.set(ENABLED_KEY, next);
    if (next) {
      // Demo of the bridge READ path (§S2.5) — shows the live `af` value.
      // A real implementation would WRITE here instead, e.g.:
      //   void ctx.mpv.setProperty("af", "loudnorm");
      // and on disable: void ctx.mpv.setProperty("af", "");
      void ctx.mpv
        .getProperty("af")
        .then((value) => setAf(value === "" ? "(пусто)" : value))
        .catch(() => setAf("(недоступно)"));
    } else {
      setAf(null);
    }
  };

  return (
    <section>
      <h4 className="player-menu-title">Постоянная громкость (пример)</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={enabled}
          className={`player-menu-item${enabled ? " player-menu-item-active" : ""}`}
          onClick={toggle}
        >
          {enabled ? "Включено (без эффекта)" : "Выключено"}
        </button>
        {enabled ? (
          <p className="player-menu-empty">af: {af ?? "…"}</p>
        ) : null}
      </div>
    </section>
  );
}

export const constantVolumeStub: PlayerExtension = {
  id: "example-constant-volume",
  name: "Постоянная громкость (пример)",
  setup(ctx): Unsubscribe | void {
    ctx.ui.add("settings.menu", () => <ConstantVolumeRow ctx={ctx} />);
    // A real implementation would also react to files:
    //   ctx.onOpen(() => { if (ctx.storage.get(ENABLED_KEY, false)) ... });
  },
};

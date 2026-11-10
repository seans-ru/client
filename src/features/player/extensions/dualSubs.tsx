/**
 * Dual subtitles extension (issue #10, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Two subtitle tracks at once (original + translation) via mpv
 * `secondary-sid`, with independent visibility, position and scale.
 *
 * Property reality check (mpv manual, verified for this milestone): there
 * are no `sub2-*` properties — the independent knobs are
 * `secondary-sub-pos` / `secondary-sub-scale` / `secondary-sub-visibility`
 * next to the primary `sub-pos` / `sub-scale` / `sub-visibility`. mpv
 * renders the secondary text track as a toptitle (top of the screen) when
 * its position is left at the default, which gives the classic
 * «первая — низ, вторая — верх» layout. Known limitations (issue: «где mpv
 * не даёт независимый стиль — зафиксировать ограничения»):
 *
 *   - bitmap subtitles always render at their usual position, so a bitmap
 *     secondary overlaps the primary (mpv manual, `--secondary-sid`);
 *   - ASS styling is shared between both tracks
 *     (`secondary-sub-ass-override` defaults to `strip`); we compensate
 *     with position/size only;
 *   - `sub-scale` applies to ASS text too and can break typesetting.
 *
 * The chosen second track, its position/size and the visibility flags are
 * persisted per media in `ctx.storage` (`file.<mediaKey>`), with a separate
 * `defaults` entry. `dispose` disables the secondary track and restores the
 * documented mpv defaults so nothing leaks into the next session.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import { formatTrackLabel } from "../playerHelpers";
import {
  mediaKeyFromSnapshot,
  mediaKeyFromUrl,
  needsSnapshotKey,
} from "./mediaKey";
import type { PlayerSnapshot } from "../playerTypes";
import type {
  ExtensionStorage,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";

export type DualSubsState = {
  /** Master switch: show the secondary subtitle track. */
  enabled: boolean;
  /** mpv id of the secondary track (null → `auto`). */
  secondId: number | null;
  /** Primary sub vertical position (`sub-pos`, 0–150; 100 = bottom). */
  firstPos: number;
  /** Primary sub scale (`sub-scale`). */
  firstScale: number;
  /** Secondary sub vertical position (`secondary-sub-pos`, 0–150). */
  secondPos: number;
  /** Secondary sub scale (`secondary-sub-scale`). */
  secondScale: number;
  /** Independent visibility of the primary track (`sub-visibility`). */
  firstVisible: boolean;
  /** Independent visibility of the secondary track. */
  secondVisible: boolean;
};

/** «Первая — низ, вторая — верх» — the classic dual-sub layout. */
export const DUAL_SUBS_DEFAULT: DualSubsState = {
  enabled: false,
  secondId: null,
  firstPos: 100,
  firstScale: 1,
  secondPos: 0,
  secondScale: 1,
  firstVisible: true,
  secondVisible: true,
};

export const SUB_POS_MIN = 0;
export const SUB_POS_MAX = 150;
export const SUB_SCALE_MIN = 0.1;
export const SUB_SCALE_MAX = 10;

export type DualSubsPropertyName =
  | "secondary-sid"
  | "sub-visibility"
  | "secondary-sub-visibility"
  | "sub-pos"
  | "sub-scale"
  | "secondary-sub-pos"
  | "secondary-sub-scale";

export const DUAL_SUBS_PROPERTY_NAMES: readonly DualSubsPropertyName[] = [
  "secondary-sid",
  "sub-visibility",
  "secondary-sub-visibility",
  "sub-pos",
  "sub-scale",
  "secondary-sub-pos",
  "secondary-sub-scale",
];

export type DualSubsCommand = {
  op: "set";
  name: DualSubsPropertyName;
  value: string | number | boolean;
};

export function clampSubPos(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 100;
  return Math.min(SUB_POS_MAX, Math.max(SUB_POS_MIN, n));
}

export function clampSubScale(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.min(SUB_SCALE_MAX, Math.max(SUB_SCALE_MIN, n));
}

export function parseSecondId(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

export function parseDualSubsState(raw: unknown): DualSubsState {
  const r = (raw ?? {}) as Partial<DualSubsState>;
  return {
    enabled: r.enabled === true,
    secondId: parseSecondId(r.secondId),
    firstPos: clampSubPos(r.firstPos ?? DUAL_SUBS_DEFAULT.firstPos),
    firstScale: clampSubScale(r.firstScale ?? DUAL_SUBS_DEFAULT.firstScale),
    secondPos: clampSubPos(r.secondPos ?? DUAL_SUBS_DEFAULT.secondPos),
    secondScale: clampSubScale(r.secondScale ?? DUAL_SUBS_DEFAULT.secondScale),
    firstVisible: r.firstVisible !== false,
    secondVisible: r.secondVisible !== false,
  };
}

/**
 * mpv edits for a state snapshot. `secondary-sid=no` disables the secondary
 * track; `auto` lets mpv pick one when no id was chosen. Style properties
 * are always written so a previously moved track cannot linger.
 */
export function dualSubsCommands(state: DualSubsState): DualSubsCommand[] {
  return [
    {
      op: "set",
      name: "secondary-sid",
      value: state.enabled
        ? state.secondId != null
          ? String(state.secondId)
          : "auto"
        : "no",
    },
    { op: "set", name: "sub-visibility", value: state.firstVisible },
    { op: "set", name: "secondary-sub-visibility", value: state.secondVisible },
    { op: "set", name: "sub-pos", value: state.firstPos },
    { op: "set", name: "sub-scale", value: state.firstScale },
    { op: "set", name: "secondary-sub-pos", value: state.secondPos },
    { op: "set", name: "secondary-sub-scale", value: state.secondScale },
  ];
}

/**
 * `dispose` edits: secondary track off, documented mpv defaults written
 * back (issue #10 acceptance keeps the player clean for the next session).
 */
export function dualSubsDisposeCommands(): DualSubsCommand[] {
  return dualSubsCommands({ ...DUAL_SUBS_DEFAULT, enabled: false });
}

/**
 * Language mark for a subtitle row (issue #10: «[оригинал] / [перевод] по
 * языку»). Same language as the playing audio → original; a different known
 * language → translation; unknown language → no mark.
 */
export function subtitleTag(
  subLang: string | null | undefined,
  audioLang: string | null | undefined,
): string {
  const sub = String(subLang ?? "").trim().toLowerCase();
  const audio = String(audioLang ?? "").trim().toLowerCase();
  if (!sub) return "";
  if (audio && sub === audio) return "[оригинал]";
  return "[перевод]";
}

export type DualSubsTrackRow = {
  id: number;
  label: string;
  tag: string;
  selected: boolean;
};

/** Sub-track rows for the picker: product label + language mark. */
export function dualSubsTrackRows(
  snapshot: PlayerSnapshot,
): DualSubsTrackRow[] {
  const audioLang =
    snapshot.tracks.find((t) => t.kind === "audio" && t.selected)?.lang ?? "";
  return snapshot.tracks
    .filter((t) => t.kind === "sub")
    .map((t) => ({
      id: t.id,
      label: formatTrackLabel(t),
      tag: subtitleTag(t.lang, audioLang),
      selected: t.selected,
    }));
}

const FILE_PREFIX = "file.";
const DEFAULTS_KEY = "defaults";

/** Per-media entry → `defaults` → built-in defaults. */
export function loadDualSubsState(
  storage: ExtensionStorage,
  mediaKey: string | null,
): DualSubsState {
  const fileState =
    mediaKey != null ? storage.get<unknown>(FILE_PREFIX + mediaKey, null) : null;
  if (fileState != null) return parseDualSubsState(fileState);
  return parseDualSubsState(storage.get<unknown>(DEFAULTS_KEY, null));
}

export function saveDualSubsState(
  storage: ExtensionStorage,
  mediaKey: string | null,
  state: DualSubsState,
): void {
  if (mediaKey == null) return;
  storage.set(FILE_PREFIX + mediaKey, state);
}

/** Shared settings state for the menu rows and the mpv sync. */
export type DualSubsSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getState(): DualSubsState;
  getSubTracks(): DualSubsTrackRow[];
  /** Bind a media key and restore its per-file (or default) state. */
  loadForFile(key: string | null): DualSubsState;
  patch(next: Partial<DualSubsState>): void;
  refreshTracks(snapshot: PlayerSnapshot): void;
};

export function createDualSubsSettings(
  storage: ExtensionStorage,
): DualSubsSettings {
  let state = loadDualSubsState(storage, null);
  let mediaKey: string | null = null;
  let subTracks: DualSubsTrackRow[] = [];
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
    getState: () => state,
    getSubTracks: () => subTracks,
    loadForFile(key) {
      mediaKey = key;
      state = loadDualSubsState(storage, key);
      notify();
      return state;
    },
    patch(next) {
      state = parseDualSubsState({ ...state, ...next });
      saveDualSubsState(storage, mediaKey, state);
      notify();
    },
    refreshTracks(snapshot) {
      const rows = dualSubsTrackRows(snapshot);
      const changed =
        rows.length !== subTracks.length ||
        rows.some((row, i) => {
          const prev = subTracks[i];
          return (
            !prev ||
            prev.id !== row.id ||
            prev.label !== row.label ||
            prev.tag !== row.tag ||
            prev.selected !== row.selected
          );
        });
      if (!changed) return;
      subTracks = rows;
      notify();
    },
  };
}

export type DualSubsController = {
  settings: DualSubsSettings;
  /** Bring `secondary-sid` + the sub style properties in line with state. */
  apply(): void;
  /** Disable the secondary track and write the mpv defaults back. */
  dispose(): void;
};

/**
 * Settings + mpv wiring shared by the extension and the tests. Every call is
 * fire-and-forget: a bridge/mpv reject is swallowed (issue: «ошибка mpv
 * изолирована — расширение не роняет плеер»).
 */
export function createDualSubsController(
  mpv: MpvBridge,
  storage: ExtensionStorage,
): DualSubsController {
  const settings = createDualSubsSettings(storage);
  const run = (commands: DualSubsCommand[]): void => {
    for (const command of commands) {
      void mpv.setProperty(command.name, command.value).catch(() => {});
    }
  };
  const apply = (): void => run(dualSubsCommands(settings.getState()));
  const stopSettings = settings.subscribe(apply);
  return {
    settings,
    apply,
    dispose() {
      stopSettings();
      run(dualSubsDisposeCommands());
    },
  };
}

function DualSubsSection({
  settings,
  getSnapshot,
}: {
  settings: DualSubsSettings;
  getSnapshot: () => PlayerSnapshot;
}): ReactElement {
  const state = useSyncExternalStore(settings.subscribe, settings.getState);
  const subTracks = useSyncExternalStore(
    settings.subscribe,
    settings.getSubTracks,
  );
  return (
    <section>
      <h4 className="player-menu-title">Двойные субтитры</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={state.enabled}
          className={`player-menu-item${state.enabled ? " player-menu-item-active" : ""}`}
          onClick={() => settings.patch({ enabled: !state.enabled })}
        >
          {state.enabled
            ? "Вторая дорожка: включена"
            : "Вторая дорожка: выключена"}
        </button>
      </div>
      {state.enabled ? (
        <>
          <h4 className="player-menu-title">Дорожка вторых субтитров</h4>
          <div className="player-menu-list">
            {subTracks.length === 0 ? (
              <p className="player-menu-empty">—</p>
            ) : (
              subTracks.map((track) => (
                <button
                  key={track.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={state.secondId === track.id}
                  className={`player-menu-item${state.secondId === track.id ? " player-menu-item-active" : ""}`}
                  onClick={() => settings.patch({ secondId: track.id })}
                >
                  {track.label}
                  {track.tag ? ` ${track.tag}` : ""}
                </button>
              ))
            )}
          </div>
          <h4 className="player-menu-title">Видимость</h4>
          <div className="player-menu-list">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={state.firstVisible}
              className={`player-menu-item${state.firstVisible ? " player-menu-item-active" : ""}`}
              onClick={() =>
                settings.patch({ firstVisible: !state.firstVisible })
              }
            >
              {state.firstVisible
                ? "Первые субтитры: включены"
                : "Первые субтитры: выключены"}
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={state.secondVisible}
              className={`player-menu-item${state.secondVisible ? " player-menu-item-active" : ""}`}
              onClick={() =>
                settings.patch({ secondVisible: !state.secondVisible })
              }
            >
              {state.secondVisible
                ? "Вторые субтитры: включены"
                : "Вторые субтитры: выключены"}
            </button>
          </div>
          <h4 className="player-menu-title">Позиция и размер</h4>
          <div className="player-menu-list">
            <label className="player-menu-item">
              <span className="player-menu-item-label">
                Первые: высота {Math.round(state.firstPos)}
              </span>
              <input
                type="range"
                min={SUB_POS_MIN}
                max={SUB_POS_MAX}
                step={5}
                value={state.firstPos}
                aria-label="Позиция первых субтитров"
                onChange={(event) =>
                  settings.patch({ firstPos: clampSubPos(Number(event.target.value)) })
                }
              />
            </label>
            <label className="player-menu-item">
              <span className="player-menu-item-label">
                Первые: размер ×{state.firstScale.toFixed(2)}
              </span>
              <input
                type="range"
                min={SUB_SCALE_MIN}
                max={SUB_SCALE_MAX}
                step={0.1}
                value={state.firstScale}
                aria-label="Размер первых субтитров"
                onChange={(event) =>
                  settings.patch({
                    firstScale: clampSubScale(Number(event.target.value)),
                  })
                }
              />
            </label>
            <label className="player-menu-item">
              <span className="player-menu-item-label">
                Вторые: высота {Math.round(state.secondPos)}
              </span>
              <input
                type="range"
                min={SUB_POS_MIN}
                max={SUB_POS_MAX}
                step={5}
                value={state.secondPos}
                aria-label="Позиция вторых субтитров"
                onChange={(event) =>
                  settings.patch({
                    secondPos: clampSubPos(Number(event.target.value)),
                  })
                }
              />
            </label>
            <label className="player-menu-item">
              <span className="player-menu-item-label">
                Вторые: размер ×{state.secondScale.toFixed(2)}
              </span>
              <input
                type="range"
                min={SUB_SCALE_MIN}
                max={SUB_SCALE_MAX}
                step={0.1}
                value={state.secondScale}
                aria-label="Размер вторых субтитров"
                onChange={(event) =>
                  settings.patch({
                    secondScale: clampSubScale(Number(event.target.value)),
                  })
                }
              />
            </label>
          </div>
          <p className="player-menu-empty">
            {(() => {
              const rows = dualSubsTrackRows(getSnapshot());
              const second = rows.find((r) => r.id === state.secondId);
              return second?.tag
                ? `Вторая дорожка: ${second.tag}`
                : "Пометка дорожки — по языку звучащей аудиодорожки.";
            })()}
          </p>
        </>
      ) : null}
    </section>
  );
}

export const dualSubs: PlayerExtension = {
  id: "dual-subs",
  name: "Двойные субтитры",
  setup(ctx): Unsubscribe {
    const controller = createDualSubsController(ctx.mpv, ctx.storage);
    let pendingUrl: string | null = null;

    const resolveKey = (snapshot?: PlayerSnapshot): string | null => {
      if (pendingUrl == null) return null;
      if (needsSnapshotKey(pendingUrl)) {
        if (!snapshot || !snapshot.file_loaded) return null;
        const key = mediaKeyFromSnapshot(pendingUrl, snapshot);
        pendingUrl = null;
        return key;
      }
      const key = mediaKeyFromUrl(pendingUrl);
      pendingUrl = null;
      return key;
    };

    const stopOpen = ctx.onOpen((info) => {
      pendingUrl = info.url;
      const key = resolveKey();
      if (key != null) {
        controller.settings.loadForFile(key);
        controller.apply();
      }
    });
    const stopSnapshot = ctx.onSnapshot((snapshot) => {
      controller.settings.refreshTracks(snapshot);
      const key = resolveKey(snapshot);
      if (key != null) {
        controller.settings.loadForFile(key);
        controller.apply();
      }
    });
    const stopMenu = ctx.ui.add("settings.menu", () => (
      <DualSubsSection
        settings={controller.settings}
        getSnapshot={ctx.getSnapshot}
      />
    ));
    return () => {
      stopMenu();
      stopOpen();
      stopSnapshot();
      controller.dispose();
    };
  },
};

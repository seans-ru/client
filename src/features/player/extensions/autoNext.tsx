/**
 * Auto-next extension (issue #20, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * «Далее — S01E03» card in the bottom-right of the `overlay` slot with a
 * countdown during the last N seconds of the episode (setting: 10/15/30 s or
 * 5/10 % of the duration) or at eof:
 *
 * - The next episode comes from the same catalog the series picker uses
 *   (`PlaybackCatalog` / `GET /api/media/{id}/episodes`); films never get a
 *   card.
 * - «Смотреть дальше» navigates exactly like the picker's episode switch
 *   (resolve the library file for S/E, then `#/player/{fileId}`); «Отмена»
 *   hides the card for the rest of the file; hovering the card pauses the
 *   countdown (the switch is deferred until the pointer leaves).
 * - A user seek INTO the end zone does not trigger the card («перемотка ≠
 *   просмотр» — autoNextPolicy.trackPosition).
 * - Settings (enable, countdown, watched-next policy) persist in `ctx.storage`.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { fetchHistory, fetchMediaEpisodes, fetchPlayback } from "../../../api/endpoints";
import { isHistoryCompleted, findHistoryForFile } from "../../history/historyHelpers";
import {
  findLibraryFileForEpisode,
  resolveFileMedia,
} from "../useMediaLookup";
import {
  formatEpisodeCode,
  formatEpisodePickerLabel,
  isSeriesCatalog,
  mediaEpisodesToCatalog,
  nextPlayableEpisode,
} from "../episodeHelpers";
import { ROUTES, getCurrentHashRoute, matchPlayerRoute } from "../../../lib/routeResolver";
import type { PlayerExtension, Unsubscribe } from "./types";
import type { ExtensionStorage } from "./types";
import {
  createPositionTrack,
  parseTriggerMode,
  parseWatchedPolicy,
  shouldOffer,
  trackPosition,
  triggerWindowSec,
  watchedDecision,
  TRIGGER_MODES,
  TRIGGER_MODE_LABELS,
  EOF_GRACE_SEC,
  type PositionTrack,
  type TriggerMode,
  type WatchedPolicy,
} from "./autoNextPolicy";
import "./autoNext.css";

const ENABLED_KEY = "enabled";
const TRIGGER_KEY = "trigger";
const WATCHED_KEY = "watchedPolicy";

export type NextEpisodeInfo = {
  /** Library file id to open (resolved like `handleSelectEpisode`). */
  targetFileId: string;
  code: string;
  title: string;
  /** Full picker-style label (`S01E03 · Название`). */
  label: string;
  watched: boolean;
};

type AutoNextSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getEnabled(): boolean;
  getTrigger(): TriggerMode;
  getWatchedPolicy(): WatchedPolicy;
  setEnabled(next: boolean): void;
  setTrigger(mode: TriggerMode): void;
  setWatchedPolicy(policy: WatchedPolicy): void;
};

function createSettings(storage: ExtensionStorage): AutoNextSettings {
  let enabled = storage.get<unknown>(ENABLED_KEY, true) !== false;
  let trigger = parseTriggerMode(storage.get(TRIGGER_KEY, "15"));
  let watchedPolicy = parseWatchedPolicy(storage.get(WATCHED_KEY, "offer"));
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
    getEnabled: () => enabled,
    getTrigger: () => trigger,
    getWatchedPolicy: () => watchedPolicy,
    setEnabled(next) {
      enabled = next;
      storage.set(ENABLED_KEY, next);
      notify();
    },
    setTrigger(mode) {
      trigger = parseTriggerMode(mode);
      storage.set(TRIGGER_KEY, trigger);
      notify();
    },
    setWatchedPolicy(policy) {
      watchedPolicy = parseWatchedPolicy(policy);
      storage.set(WATCHED_KEY, watchedPolicy);
      notify();
    },
  };
}

/** Live playback numbers the card folds into the trigger policy. */
export type AutoNextTick = {
  position: number;
  duration: number;
  pause: boolean;
  eof: boolean;
  speed: number;
};

/** Shared episode/session state between setup and the overlay card. */
type AutoNextSession = {
  settings: AutoNextSettings;
  track: PositionTrack;
  nextInfo: NextEpisodeInfo | null;
  /** Bumped when `nextInfo` changes (useSyncExternalStore). */
  version: number;
  /** Injected by `setup` — the latest player snapshot. */
  getTick: () => AutoNextTick;
  subscribe(cb: () => void): Unsubscribe;
  setNext(info: NextEpisodeInfo | null): void;
  dismiss(): void;
};

function createSession(storage: ExtensionStorage): AutoNextSession {
  const listeners = new Set<() => void>();
  const session: AutoNextSession = {
    settings: createSettings(storage),
    track: createPositionTrack(),
    nextInfo: null,
    version: 0,
    getTick: () => ({ position: 0, duration: 0, pause: true, eof: false, speed: 1 }),
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setNext(info) {
      session.nextInfo = info;
      session.version += 1;
      for (const listener of [...listeners]) listener();
    },
    dismiss() {
      session.track = { ...session.track, dismissed: true };
      session.version += 1;
      for (const listener of [...listeners]) listener();
    },
  };
  return session;
}

/**
 * Resolve the next playable episode exactly like the picker switch does:
 * catalog from playback/episodes, library file id for the target S/E.
 * Returns null for films, same-file packs (out of scope) and lookup misses.
 */
export async function resolveNextEpisode(
  fileId: string,
): Promise<NextEpisodeInfo | null> {
  const media = await resolveFileMedia(fileId);
  if (!media || media.mediaId == null) return null;
  const mediaId = media.mediaId;
  const playback = await fetchPlayback(mediaId, {
    season: media.season,
    episode: media.episode,
  }).catch(() => null);
  let catalog = playback?.catalog ?? null;
  if (!catalog) {
    const episodes = await fetchMediaEpisodes(mediaId).catch(() => null);
    catalog = episodes ? mediaEpisodesToCatalog(episodes) : null;
  }
  if (!catalog || !isSeriesCatalog(catalog)) return null;
  const next = nextPlayableEpisode(catalog, fileId);
  if (!next) return null;
  const resolved =
    (await findLibraryFileForEpisode(mediaId, next.season, next.episode).catch(
      () => null,
    )) ?? (next.id != null ? String(next.id) : null);
  if (!resolved || resolved === String(fileId)) return null;
  const watched = await fetchHistory({ limit: 200 })
    .then((rows) => {
      const row = findHistoryForFile(rows, resolved);
      return row ? isHistoryCompleted(row) : false;
    })
    .catch(() => false);
  return {
    targetFileId: resolved,
    code: formatEpisodeCode(next.season, next.episode, next.episode_end),
    title: String(next.title ?? "").trim(),
    label: formatEpisodePickerLabel(next),
    watched,
  };
}

/* -------------------------------------------------------------------- card */

function AutoNextCard({
  session,
  onGo,
}: {
  session: AutoNextSession;
  onGo: (targetFileId: string) => void;
}): ReactElement | null {
  const version = useSyncExternalStore(session.subscribe, () => session.version);
  const enabled = useSyncExternalStore(
    session.settings.subscribe,
    session.settings.getEnabled,
    session.settings.getEnabled,
  );
  const trigger = useSyncExternalStore(
    session.settings.subscribe,
    session.settings.getTrigger,
    session.settings.getTrigger,
  );
  const watchedPolicy = useSyncExternalStore(
    session.settings.subscribe,
    session.settings.getWatchedPolicy,
    session.settings.getWatchedPolicy,
  );
  const [visible, setVisible] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const hoverRef = useRef(false);
  const graceEndsAtRef = useRef(0);
  const visibleRef = useRef(false);
  visibleRef.current = visible;

  // Hide the card when the resolved next episode goes away (file switch).
  useEffect(() => {
    if (!session.nextInfo) {
      visibleRef.current = false;
      setVisible(false);
    }
  }, [session.nextInfo, version]);

  // Trigger loop: folds live snapshots into the policy track at ~3 Hz and
  // drives the countdown. Rust already throttles `player://state` to 250 ms.
  useEffect(() => {
    if (!enabled) {
      visibleRef.current = false;
      setVisible(false);
      return;
    }
    const timer = setInterval(() => {
      const tick = session.getTick();
      const windowSec = triggerWindowSec(tick.duration, trigger);
      const folded = trackPosition(session.track, {
        positionSec: tick.position,
        speed: tick.speed,
        nowMs: Date.now(),
        durationSec: tick.duration,
        windowSec,
        eof: tick.eof,
      });
      session.track = folded.track;
      const remainingSec = Math.max(0, tick.duration - tick.position);
      const next = session.nextInfo;
      const decision = next
        ? watchedDecision(next.watched, watchedPolicy)
        : "skip";
      const offer = shouldOffer({
        enabled: true,
        hasPlayableNext: Boolean(next) && decision !== "skip",
        track: session.track,
        inWindow: folded.inWindow,
        remainingSec,
        eof: tick.eof,
      });

      const nowMs = Date.now();
      if (offer && !visibleRef.current) {
        visibleRef.current = true;
        graceEndsAtRef.current =
          remainingSec <= 0 ? nowMs + EOF_GRACE_SEC * 1000 : 0;
        setVisible(true);
      } else if (!offer && visibleRef.current) {
        visibleRef.current = false;
        setVisible(false);
      }
      if (!visibleRef.current) return;

      let displayed =
        graceEndsAtRef.current > 0
          ? Math.max(0, (graceEndsAtRef.current - nowMs) / 1000)
          : remainingSec;
      if (hoverRef.current && graceEndsAtRef.current > 0) {
        // Hover pauses the wall-clock grace countdown.
        graceEndsAtRef.current += 350;
        displayed = Math.max(0, (graceEndsAtRef.current - nowMs) / 1000);
      }
      setCountdown(Math.ceil(displayed));

      // Auto-advance once the countdown runs out; hover defers the switch
      // («hover ставит таймер на паузу»).
      if (displayed <= 0 && !hoverRef.current && next) {
        visibleRef.current = false;
        setVisible(false);
        onGo(next.targetFileId);
      }
    }, 350);
    return () => clearInterval(timer);
  }, [enabled, trigger, watchedPolicy, session, onGo]);

  const next = session.nextInfo;
  if (!enabled || !visible || !next) return null;
  const decision = watchedDecision(next.watched, watchedPolicy);
  if (decision === "skip") return null;

  return (
    <div
      className="player-autonext-card"
      role="status"
      onMouseEnter={() => {
        hoverRef.current = true;
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
      }}
    >
      <div className="player-autonext-head">
        <span className="player-autonext-kicker">Следующая серия</span>
        <span className="player-autonext-count" aria-live="polite">
          {Math.max(0, countdown)}
        </span>
      </div>
      <p className="player-autonext-title">{next.label}</p>
      {decision === "offer-watched" ? (
        <p className="player-autonext-watched">Уже просмотрено</p>
      ) : null}
      <div className="player-autonext-actions">
        <button
          type="button"
          className="player-autonext-primary"
          onClick={() => onGo(next.targetFileId)}
        >
          Смотреть дальше
        </button>
        <button
          type="button"
          className="player-autonext-secondary"
          onClick={() => {
            session.dismiss();
            visibleRef.current = false;
            setVisible(false);
          }}
        >
          Отмена
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- settings */

function AutoNextRow({ session }: { session: AutoNextSession }): ReactElement {
  const enabled = useSyncExternalStore(
    session.settings.subscribe,
    session.settings.getEnabled,
    session.settings.getEnabled,
  );
  const trigger = useSyncExternalStore(
    session.settings.subscribe,
    session.settings.getTrigger,
    session.settings.getTrigger,
  );
  const watchedPolicy = useSyncExternalStore(
    session.settings.subscribe,
    session.settings.getWatchedPolicy,
    session.settings.getWatchedPolicy,
  );
  return (
    <section>
      <h4 className="player-menu-title">Автопереход</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={enabled}
          className={`player-menu-item${enabled ? " player-menu-item-active" : ""}`}
          onClick={() => session.settings.setEnabled(!enabled)}
        >
          {enabled ? "Включён" : "Выключен"}
        </button>
      </div>
      <h4 className="player-menu-title">Обратный отсчёт</h4>
      <div className="player-menu-row" role="group" aria-label="Длительность отсчёта">
        {TRIGGER_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="menuitemradio"
            aria-checked={mode === trigger}
            className={`player-chip${mode === trigger ? " player-chip-active" : ""}`}
            onClick={() => session.settings.setTrigger(mode)}
          >
            {TRIGGER_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
      <h4 className="player-menu-title">Просмотренные серии</h4>
      <div className="player-menu-row" role="group" aria-label="Поведение с просмотренными">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={watchedPolicy === "offer"}
          className={`player-chip${watchedPolicy === "offer" ? " player-chip-active" : ""}`}
          onClick={() => session.settings.setWatchedPolicy("offer")}
        >
          Предлагать
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={watchedPolicy === "skip"}
          className={`player-chip${watchedPolicy === "skip" ? " player-chip-active" : ""}`}
          onClick={() => session.settings.setWatchedPolicy("skip")}
        >
          Пропускать
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- extension */

export const autoNext: PlayerExtension = {
  id: "auto-next",
  name: "Автопереход",
  setup(ctx): Unsubscribe {
    const session = createSession(ctx.storage);
    session.getTick = () => {
      const s = ctx.getSnapshot();
      return {
        position: s.position,
        duration: s.duration,
        pause: s.pause,
        eof: s.eof,
        speed: s.speed,
      };
    };

    const go = (targetFileId: string): void => {
      window.location.hash = ROUTES.player(targetFileId);
    };

    let resolveToken = 0;
    const resolve = async (): Promise<void> => {
      const token = ++resolveToken;
      session.track = createPositionTrack();
      session.setNext(null);
      const routeId = matchPlayerRoute(getCurrentHashRoute());
      // Rooms (`#/room/...`) are host-driven — no auto-next there.
      if (!routeId) return;
      try {
        const info = await resolveNextEpisode(routeId);
        if (token !== resolveToken) return;
        session.setNext(info);
      } catch {
        if (token === resolveToken) session.setNext(null);
      }
    };

    const stopOpen = ctx.onOpen(() => {
      void resolve();
    });
    const stopClose = ctx.onClose(() => {
      resolveToken += 1;
      session.track = createPositionTrack();
      session.setNext(null);
    });
    const stopCard = ctx.ui.add("overlay", () => (
      <AutoNextCard session={session} onGo={go} />
    ));
    const stopRow = ctx.ui.add("settings.menu", () => (
      <AutoNextRow session={session} />
    ));

    // A file may already be playing when the extension mounts.
    void resolve();

    return () => {
      resolveToken += 1;
      stopRow();
      stopCard();
      stopClose();
      stopOpen();
    };
  },
};

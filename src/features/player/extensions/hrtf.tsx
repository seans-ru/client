/**
 * Virtual surround (HRTF) extension (issue #6, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * Multichannel (5.1/7.1) tracks in headphones sound flat; HRTF binaural
 * rendering opens up the sound stage. Implemented as the NAMED mpv audio
 * filter `@seans-hrtf` (`lavfi=[sofalizer=…]`, `af add` / `af remove` by
 * label, never `setProperty("af")`), so other extensions' filters are never
 * overwritten. Profiles «Наушники» / «Комната» map to sofalizer params.
 *
 * Autodetect: the filter is applied only to multichannel audio tracks
 * (>2 channels); on stereo the filter is kept off and the menu shows
 * «эффект только для 5.1/7.1». The channel count is re-checked on file open
 * and whenever the selected audio track changes (`ctx.onSnapshot`).
 *
 * sofalizer renders with an HRTF dataset from a SOFA file (sofacoustics.org
 * database) — the path is an optional setting; without it the filter is not
 * added and the menu shows a hint. `dispose` removes the filter (original
 * sound). mpv errors are isolated: a rejected `af add` is logged with
 * `console.warn` and the effect is marked failed, never thrown at the host.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import type {
  ExtensionStorage,
  MpvBridge,
  PlayerExtension,
  Unsubscribe,
} from "./types";

/** Filter label — the remove/toggle reference is `@<label>`. */
export const HRTF_LABEL = "seans-hrtf";

/** Multichannel tracks only: 5.1 (6), 7.1 (8), … — stereo/mono are skipped. */
export const HRTF_MIN_CHANNELS = 3;

export const HRTF_PROFILES = ["headphones", "room"] as const;
export type HrtfProfile = (typeof HRTF_PROFILES)[number];

export const HRTF_PROFILE_LABELS: Record<HrtfProfile, string> = {
  headphones: "Наушники",
  room: "Комната",
};

/**
 * sofalizer params per profile (issue: «наушники/комнатные, если фильтр
 * поддерживает»). `type=freq` is the fast frequency-domain mode; `radius`
 * scales the virtual loudspeaker distance.
 */
const HRTF_PROFILE_PARAMS: Record<HrtfProfile, string> = {
  headphones: "type=freq:radius=1",
  room: "type=freq:radius=2:gain=3",
};

const ENABLED_KEY = "enabled";
const PROFILE_KEY = "profile";
const SOFA_KEY = "sofa";

/** Label-only reference used by `af remove`. */
export function labelRef(label: string): string {
  return `@${label}`;
}

export function parseHrtfProfile(raw: unknown): HrtfProfile {
  return raw === "room" ? "room" : "headphones";
}

export function parseSofaPath(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Escape a filesystem path for the `sofa=` filtergraph argument: backslashes
 * become forward slashes (ffmpeg accepts `/` on Windows), then the value is
 * single-quoted so `:` in `C:/…` is not parsed as an option separator.
 */
export function escapeSofaPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return `'${normalized.replace(/'/g, `'\\''`)}'`;
}

/** Labeled sofalizer filter string; `add` with a used label replaces in place. */
export function hrtfFilter(profile: HrtfProfile, sofaPath: string): string {
  const params = HRTF_PROFILE_PARAMS[parseHrtfProfile(profile)];
  const sofa = parseSofaPath(sofaPath);
  const args = sofa ? `sofa=${escapeSofaPath(sofa)}:${params}` : params;
  return `@${HRTF_LABEL}:lavfi=[sofalizer=${args}]`;
}

export type HrtfFilterCommand = {
  /** Operation of the mpv `af` command (filter-list verbs `add`/`remove`). */
  op: "add" | "remove";
  /** Filter entry: full labeled spec for `add`, `@label` ref for `remove`. */
  entry: string;
};

/**
 * Parse an mpv channel description to a channel count. Accepts raw counts
 * ("6"), layouts ("5.1", "7.1(side)") and names ("stereo", "mono").
 */
export function parseChannelCount(raw: string): number {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return 0;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  if (value === "mono") return 1;
  if (value === "stereo") return 2;
  if (value === "quad") return 4;
  const layout = /^(\d+)\.(\d+)/.exec(value);
  if (layout) {
    return Number.parseInt(layout[1], 10) + Number.parseInt(layout[2], 10);
  }
  return 0;
}

export function isMultichannel(channels: number): boolean {
  return Number.isFinite(channels) && channels >= HRTF_MIN_CHANNELS;
}

/** Desired af-chain edits for a settings snapshot (removal is always safe). */
export function hrtfFilterCommands(args: {
  enabled: boolean;
  profile: HrtfProfile;
  sofaPath: string;
  channels: number;
}): HrtfFilterCommand[] {
  const active =
    args.enabled && isMultichannel(args.channels) && parseSofaPath(args.sofaPath).length > 0;
  return active
    ? [{ op: "add", entry: hrtfFilter(args.profile, args.sofaPath) }]
    : [{ op: "remove", entry: labelRef(HRTF_LABEL) }];
}

/** Shared settings state for the menu rows and the af-chain sync. */
export type HrtfSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getEnabled(): boolean;
  getProfile(): HrtfProfile;
  getSofaPath(): string;
  setEnabled(next: boolean): void;
  setProfile(profile: HrtfProfile): void;
  setSofaPath(path: string): void;
};

export function createHrtfSettings(storage: ExtensionStorage): HrtfSettings {
  let enabled = Boolean(storage.get(ENABLED_KEY, false));
  let profile = parseHrtfProfile(storage.get(PROFILE_KEY, "headphones"));
  let sofaPath = parseSofaPath(storage.get(SOFA_KEY, ""));
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
    getProfile: () => profile,
    getSofaPath: () => sofaPath,
    setEnabled(next) {
      enabled = Boolean(next);
      storage.set(ENABLED_KEY, enabled);
      notify();
    },
    setProfile(next) {
      profile = parseHrtfProfile(next);
      storage.set(PROFILE_KEY, profile);
      notify();
    },
    setSofaPath(path) {
      sofaPath = parseSofaPath(path);
      storage.set(SOFA_KEY, sofaPath);
      notify();
    },
  };
}

/**
 * Why the filter is (not) running — mirrored into the settings row.
 * - `stereo`: current track is stereo/mono, effect is skipped by design.
 * - `needs-sofa`: enabled multichannel track, but no SOFA dataset configured.
 * - `error`: mpv rejected the filter (isolated, see console.warn).
 * - `active` / `idle`: filter on / intentionally off.
 */
export type HrtfStatus = "idle" | "active" | "stereo" | "needs-sofa" | "error";

export type HrtfController = {
  settings: HrtfSettings;
  subscribe(cb: () => void): Unsubscribe;
  getChannels(): number;
  getStatus(): HrtfStatus;
  /** Re-query the current audio track's channel count, then re-apply. */
  refreshChannels(): Promise<void>;
  /** Bring the af chain in line with the settings + detected channels. */
  apply(): void;
  /** Drop our filter (original sound) and stop reacting to settings. */
  dispose(): void;
};

/** Try several mpv properties; the first usable channel count wins. */
export async function readChannelCount(mpv: MpvBridge): Promise<number> {
  const names = [
    "current-tracks/audio/demux-channel-count",
    "audio-params/channel-count",
    "audio-params/channels",
    "audio-channels",
  ];
  for (const name of names) {
    try {
      const parsed = parseChannelCount(await mpv.getProperty(name));
      if (parsed > 0) return parsed;
    } catch {
      // Property unavailable — try the next candidate.
    }
  }
  return 0;
}

/**
 * Settings + mpv wiring shared by the extension and the tests. Every command
 * is fire-and-forget: a bridge/mpv reject is swallowed and logged
 * (issue: «при ошибке тихо отключать и писать в console.warn»).
 */
export function createHrtfController(
  mpv: MpvBridge,
  storage: ExtensionStorage,
): HrtfController {
  const settings = createHrtfSettings(storage);
  let channels = 0;
  let status: HrtfStatus = "idle";
  let disposed = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const warn = (error: unknown): void => {
    console.warn("[player.ext]", "hrtf", error);
  };
  const run = (commands: HrtfFilterCommand[]): void => {
    for (const { op, entry } of commands) {
      void mpv
        .command(["af", op, entry])
        .then(() => {
          if (op === "add" && !disposed) {
            status = "active";
            notify();
          }
        })
        .catch((error: unknown) => {
          // Quietly drop the effect; the player keeps working (issue).
          warn(error);
          if (!disposed) {
            status = "error";
            notify();
            if (op === "add") {
              void mpv.command(["af", "remove", labelRef(HRTF_LABEL)]).catch(() => {});
            }
          }
        });
    }
  };
  const apply = (): void => {
    if (disposed) return;
    const enabled = settings.getEnabled();
    const sofaPath = settings.getSofaPath();
    const multichannel = isMultichannel(channels);
    if (!enabled) {
      status = "idle";
    } else if (!multichannel) {
      status = "stereo";
    } else if (parseSofaPath(sofaPath).length === 0) {
      status = "needs-sofa";
    }
    run(
      hrtfFilterCommands({
        enabled,
        profile: settings.getProfile(),
        sofaPath,
        channels,
      }),
    );
    notify();
  };
  const stopSettings = settings.subscribe(apply);
  return {
    settings,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getChannels: () => channels,
    getStatus: () => status,
    async refreshChannels() {
      channels = await readChannelCount(mpv);
      apply();
    },
    apply,
    dispose() {
      disposed = true;
      stopSettings();
      void mpv
        .command(["af", "remove", labelRef(HRTF_LABEL)])
        .catch((error: unknown) => warn(error));
    },
  };
}

const HRTF_STATUS_LINES: Record<HrtfStatus, string> = {
  idle: "Эффект выключен.",
  active: "Эффект активен (виртуальные колонки в наушниках).",
  stereo: "Эффект только для 5.1/7.1 — текущая дорожка стерео/моно.",
  "needs-sofa":
    "Укажите путь к SOFA-файлу (база HRTF с sofacoustics.org), чтобы включить эффект.",
  error: "mpv не смог применить фильтр — эффект отключён (см. консоль).",
};

function HrtfSection({
  controller,
}: {
  controller: HrtfController;
}): ReactElement {
  const { settings } = controller;
  const enabled = useSyncExternalStore(settings.subscribe, settings.getEnabled);
  const profile = useSyncExternalStore(settings.subscribe, settings.getProfile);
  const sofaPath = useSyncExternalStore(settings.subscribe, settings.getSofaPath);
  const status = useSyncExternalStore(controller.subscribe, controller.getStatus);
  return (
    <section>
      <h4 className="player-menu-title">Виртуальный объёмный звук</h4>
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={enabled}
          className={`player-menu-item${enabled ? " player-menu-item-active" : ""}`}
          onClick={() => settings.setEnabled(!enabled)}
        >
          {enabled ? "HRTF: включено" : "HRTF: выключено"}
        </button>
      </div>
      {enabled ? (
        <>
          <div className="player-menu-row" role="group" aria-label="Профиль HRTF">
            {HRTF_PROFILES.map((id) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={profile === id}
                className={`player-chip${profile === id ? " player-chip-active" : ""}`}
                onClick={() => settings.setProfile(id)}
              >
                {HRTF_PROFILE_LABELS[id]}
              </button>
            ))}
          </div>
          <div className="player-menu-list">
            <label className="player-menu-item">
              <span>SOFA-файл</span>
              <input
                type="text"
                value={sofaPath}
                placeholder="путь к HRTF-набору (.sofa)"
                aria-label="Путь к SOFA-файлу"
                onChange={(event) => settings.setSofaPath(event.target.value)}
              />
            </label>
          </div>
        </>
      ) : null}
      <p className="player-menu-empty">{HRTF_STATUS_LINES[status]}</p>
    </section>
  );
}

/** Selected audio track id from the snapshot (0 when none). */
export function selectedAudioTrackId(
  tracks: ReadonlyArray<{ id: number; kind: string; selected: boolean }>,
): number {
  for (const track of tracks) {
    if (track.kind === "audio" && track.selected) return track.id;
  }
  return 0;
}

export const hrtf: PlayerExtension = {
  id: "hrtf",
  name: "Виртуальный объёмный звук",
  setup(ctx): Unsubscribe {
    const controller = createHrtfController(ctx.mpv, ctx.storage);
    let lastTrackId = selectedAudioTrackId(ctx.getSnapshot().tracks);
    const stopOpen = ctx.onOpen(() => {
      lastTrackId = selectedAudioTrackId(ctx.getSnapshot().tracks);
      void controller.refreshChannels();
    });
    // Re-check on audio track switches (issue: «при смене дорожки — перепроверка»).
    const stopSnapshot = ctx.onSnapshot((snapshot) => {
      const trackId = selectedAudioTrackId(snapshot.tracks);
      if (trackId !== lastTrackId) {
        lastTrackId = trackId;
        void controller.refreshChannels();
      }
    });
    const stopRow = ctx.ui.add("settings.menu", () => (
      <HrtfSection controller={controller} />
    ));
    // A file may already be playing when the extension mounts.
    void controller.refreshChannels();
    return () => {
      stopRow();
      stopSnapshot();
      stopOpen();
      controller.dispose();
    };
  },
};

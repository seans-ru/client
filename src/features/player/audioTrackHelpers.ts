/**
 * Playback audio-track labels and per-item selection preference.
 * Pure — no React/DOM/Tauri. Labels follow the product voiceover vocabulary:
 *   ["dub"]            → «Русский дубляж»
 *   ["voice"]          → «Многоголосый»
 *   ["studio_dub"]     → studio title / «Студийный дубляж»
 *   ["one_voice"]      → «Одноголосый»
 *   ["original"]       → «Оригинал»
 *   ["dual_audio"]     → «Dual/Multi»
 */

import type { PlaybackAudioTrack } from "../../api/playback";

/** localStorage keys use this prefix (non-sensitive UI preference). */
export const AUDIO_PREF_PREFIX = "seans.audio";

export type AudioPrefScope =
  | { kind: "movie"; mediaId: string }
  /** Default product choice for series: per-episode. */
  | { kind: "episode"; mediaId: string; fileId: string; season?: number | null; episode?: number | null }
  /** Opt-in whole-season preference. */
  | { kind: "season"; mediaId: string; season: number };

/** Storage key for an audio preference scope. */
export function audioPrefKey(scope: AudioPrefScope): string {
  switch (scope.kind) {
    case "movie":
      return `${AUDIO_PREF_PREFIX}.media.${scope.mediaId}`;
    case "season":
      return `${AUDIO_PREF_PREFIX}.season.${scope.mediaId}:${scope.season}`;
    case "episode": {
      // Prefer file id (stable, unique); season/episode are display-only fallback.
      return `${AUDIO_PREF_PREFIX}.episode.${scope.mediaId}.${scope.fileId}`;
    }
  }
}

/** Russian display label for a language tag. */
export function formatAudioLanguage(language: string | null | undefined): string {
  const lang = String(language ?? "").trim().toLowerCase();
  switch (lang) {
    case "ru":
    case "rus":
      return "рус";
    case "en":
    case "eng":
      return "англ";
    case "uk":
    case "ukr":
      return "укр";
    case "be":
      return "бел";
    case "de":
      return "нем";
    case "fr":
      return "фр";
    case "es":
      return "исп";
    case "it":
      return "ит";
    case "ja":
      return "яп";
    case "ko":
      return "кор";
    case "zh":
      return "кит";
    case "":
      return "";
    default:
      return lang;
  }
}

/**
 * Product label for a playback audio track (flags first, then title/lang).
 * Flag priority: original > dub > studio_dub > voice > one_voice > dual_audio.
 */
export function formatPlaybackAudioLabel(track: PlaybackAudioTrack): string {
  // Backend-composed label wins when present (seans `audio_tracks[].label`).
  const backendLabel = String(track.label ?? "").trim();
  if (backendLabel) return backendLabel;

  const flags = (track.flags ?? []).map((f) => String(f).toLowerCase());
  const title = String(track.title ?? "").trim();
  const lang = formatAudioLanguage(track.language);
  const has = (f: string) => flags.includes(f);

  if (has("original")) {
    return lang ? `Оригинал · ${lang}` : "Оригинал";
  }
  if (has("dub")) {
    // Product copy names the Russian dub explicitly; other languages keep the tag.
    if (!lang || lang === "рус") return "Русский дубляж";
    return `Дубляж · ${lang}`;
  }
  if (has("studio_dub")) {
    return title || "Студийный дубляж";
  }
  if (has("voice")) {
    return title ? `Многоголосый · ${title}` : "Многоголосый";
  }
  if (has("one_voice")) {
    return title ? `Одноголосый · ${title}` : "Одноголосый";
  }
  if (has("dual_audio")) {
    return title ? `Dual/Multi · ${title}` : "Dual/Multi";
  }
  if (title) return title;
  if (lang) return lang;
  return `Аудио ${String(track.id)}`;
}

/** True when the track is an external file (ac3/m4a) rather than in-container. */
export function isExternalAudioTrack(track: PlaybackAudioTrack): boolean {
  return track.embedded === false;
}

/**
 * Resolve the track to select on open.
 * Order: explicit id (if still present) → saved preference → original → first.
 */
export function resolvePreferredAudioTrack(
  tracks: readonly PlaybackAudioTrack[],
  options: {
    preferredId?: string | number | null;
    savedId?: string | number | null;
  } = {},
): PlaybackAudioTrack | null {
  if (tracks.length === 0) return null;
  const find = (id: string | number | null | undefined) =>
    id == null ? null : tracks.find((t) => String(t.id) === String(id)) ?? null;

  return (
    find(options.preferredId) ??
    find(options.savedId) ??
    tracks.find((t) => (t.flags ?? []).map(String).includes("original")) ??
    tracks[0]
  );
}

/** Map playback flag kinds into a compact badge tone for UI chips. */
export type AudioBadgeTone = "accent" | "neutral" | "warning" | "info";

export function audioBadgeTone(track: PlaybackAudioTrack): AudioBadgeTone {
  const flags = (track.flags ?? []).map((f) => String(f).toLowerCase());
  if (flags.includes("original")) return "accent";
  if (flags.includes("dub")) return "info";
  if (flags.includes("dual_audio")) return "warning";
  return "neutral";
}

/**
 * Persisted selection helpers — localStorage with safe no-ops outside DOM.
 * Values are track ids (stringified API ids).
 */
export function loadAudioPreference(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveAudioPreference(key: string, trackId: string | number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, String(trackId));
  } catch {
    // quota / private mode — preference is best-effort
  }
}

export function clearAudioPreference(key: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

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
 * Order (issue #9): explicit id (if still present) → user rule kind →
 * saved preference → original → first.
 */
export function resolvePreferredAudioTrack(
  tracks: readonly PlaybackAudioTrack[],
  options: {
    preferredId?: string | number | null;
    savedId?: string | number | null;
    rule?: AudioRuleKind | null;
  } = {},
): PlaybackAudioTrack | null {
  if (tracks.length === 0) return null;
  const find = (id: string | number | null | undefined) =>
    id == null ? null : tracks.find((t) => String(t.id) === String(id)) ?? null;

  const ruleKind = parseAudioRuleKind(options.rule);
  const ruleTrack =
    ruleKind == null
      ? null
      : (tracks.find((t) => classifyAudioKind(t) === ruleKind) ?? null);

  return (
    find(options.preferredId) ??
    ruleTrack ??
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

/* ------------------------------------------------------------------ issue #9
 * Audio track rules with smart memory (issue #9).
 *
 * Priority at open (issue ТЗ): explicit in-session pick → user rule →
 * remembered per-media/episode pick → default (original / first).
 * The rule and the pick history live in localStorage under the
 * `seans.audio.*` convention so the player logic (usePlayback) and the
 * `extensions/audioRules` UI share one store.
 */

/** Rule kinds offered in the settings menu (issue #9 vocabulary). */
export type AudioRuleKind = "original" | "dub" | "voice" | "one_voice";

/** Classification of a track: the four rule kinds plus "other". */
export type AudioKind = AudioRuleKind | "other";

export const AUDIO_RULE_KINDS: readonly AudioRuleKind[] = [
  "original",
  "dub",
  "voice",
  "one_voice",
];

export const AUDIO_RULE_KEY = `${AUDIO_PREF_PREFIX}.rule`;
export const AUDIO_RULE_ASK_KEY = `${AUDIO_PREF_PREFIX}.rule.ask`;
export const AUDIO_PICKS_KEY = `${AUDIO_PREF_PREFIX}.picks`;
export const AUDIO_PROPOSAL_KEY = `${AUDIO_PREF_PREFIX}.proposal`;
export const AUDIO_PROPOSAL_DISMISS_KEY = `${AUDIO_PREF_PREFIX}.proposal.dismissed`;
export const AUDIO_ASKED_PREFIX = `${AUDIO_PREF_PREFIX}.asked.`;

/** Cap on the remembered pick history (oldest entries are dropped). */
export const AUDIO_PICKS_MAX = 50;
/** How many same-kind picks in one media trigger the "make permanent" offer. */
export const AUDIO_RULE_MIN_REPEATS = 2;

export function parseAudioRuleKind(raw: unknown): AudioRuleKind | null {
  return (AUDIO_RULE_KINDS as readonly unknown[]).includes(raw)
    ? (raw as AudioRuleKind)
    : null;
}

/**
 * Classify a track by its voiceover flags (the issue's classification
 * source). Accepts both `PlaybackAudioTrack` (flags present) and an mpv
 * track (no flags — title/label keyword fallback).
 */
export function classifyAudioKind(track: {
  flags?: readonly (string | number)[] | null;
  title?: string | null;
  label?: string | null;
}): AudioKind {
  const flags = (track.flags ?? []).map((f) => String(f).toLowerCase());
  const has = (flag: string) => flags.includes(flag);
  if (has("original")) return "original";
  if (has("dub") || has("studio_dub")) return "dub";
  if (has("voice")) return "voice";
  if (has("one_voice")) return "one_voice";

  // Fallback for flagless (mpv) tracks: match the product labels.
  // `one_voice` is checked before `voice` (the token is a substring).
  const text = `${String(track.label ?? "")} ${String(track.title ?? "")}`.toLowerCase();
  if (text.includes("original") || text.includes("оригинал")) return "original";
  if (text.includes("one_voice") || text.includes("одноголос")) return "one_voice";
  if (text.includes("dub") || text.includes("дубляж")) return "dub";
  if (text.includes("voice") || text.includes("многоголос")) return "voice";
  return "other";
}

export function loadAudioRuleKind(): AudioRuleKind | null {
  return parseAudioRuleKind(loadAudioPreference(AUDIO_RULE_KEY));
}

export function saveAudioRuleKind(kind: AudioRuleKind | null): void {
  if (kind == null) clearAudioPreference(AUDIO_RULE_KEY);
  else saveAudioPreference(AUDIO_RULE_KEY, kind);
}

export function loadAudioAskFirstOpen(): boolean {
  return loadAudioPreference(AUDIO_RULE_ASK_KEY) === "1";
}

export function saveAudioAskFirstOpen(value: boolean): void {
  if (value) saveAudioPreference(AUDIO_RULE_ASK_KEY, "1");
  else clearAudioPreference(AUDIO_RULE_ASK_KEY);
}

/** One remembered explicit pick (issue #9 smart memory). */
export type AudioPickRecord = {
  /** Series/movie media id — picks are grouped per media («в сериале»). */
  mediaKey: string;
  kind: AudioKind;
  at: number;
};

/** Pending «сделать постоянным» offer. */
export type AudioRuleProposal = {
  kind: AudioRuleKind;
  mediaKey: string;
};

export function proposalKey(proposal: AudioRuleProposal): string {
  return `${proposal.mediaKey}:${proposal.kind}`;
}

export function parseAudioPicks(raw: unknown): AudioPickRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: AudioPickRecord[] = [];
  for (const entry of raw) {
    const record = (entry ?? {}) as Partial<AudioPickRecord>;
    const kind = record.kind;
    const valid =
      kind === "other" || (AUDIO_RULE_KINDS as readonly unknown[]).includes(kind);
    if (!valid) continue;
    if (typeof record.mediaKey !== "string" || !record.mediaKey) continue;
    out.push({
      mediaKey: record.mediaKey,
      kind: kind as AudioKind,
      at: typeof record.at === "number" ? record.at : 0,
    });
  }
  return out;
}

export function parseAudioRuleProposal(raw: unknown): AudioRuleProposal | null {
  const record = (raw ?? {}) as Partial<AudioRuleProposal>;
  const kind = parseAudioRuleKind(record.kind);
  if (!kind) return null;
  if (typeof record.mediaKey !== "string" || !record.mediaKey) return null;
  return { kind, mediaKey: record.mediaKey };
}

function loadJsonPreference(key: string): unknown {
  const raw = loadAudioPreference(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveJsonPreference(key: string, value: unknown): void {
  if (value == null) clearAudioPreference(key);
  else saveAudioPreference(key, JSON.stringify(value));
}

export function loadAudioPicks(): AudioPickRecord[] {
  return parseAudioPicks(loadJsonPreference(AUDIO_PICKS_KEY));
}

export function saveAudioPicks(picks: readonly AudioPickRecord[]): void {
  saveJsonPreference(AUDIO_PICKS_KEY, [...picks]);
}

export function loadAudioRuleProposal(): AudioRuleProposal | null {
  return parseAudioRuleProposal(loadJsonPreference(AUDIO_PROPOSAL_KEY));
}

export function saveAudioRuleProposal(
  proposal: AudioRuleProposal | null,
): void {
  saveJsonPreference(AUDIO_PROPOSAL_KEY, proposal);
}

export function loadAudioProposalDismissed(): AudioRuleProposal | null {
  return parseAudioRuleProposal(loadJsonPreference(AUDIO_PROPOSAL_DISMISS_KEY));
}

export function saveAudioProposalDismissed(
  proposal: AudioRuleProposal | null,
): void {
  saveJsonPreference(AUDIO_PROPOSAL_DISMISS_KEY, proposal);
}

export function isProposalDismissed(
  proposal: AudioRuleProposal | null,
  dismissed: AudioRuleProposal | null,
): boolean {
  if (!proposal || !dismissed) return false;
  return proposalKey(proposal) === proposalKey(dismissed);
}

/** Append a pick, keeping the newest `AUDIO_PICKS_MAX` records. */
export function recordAudioPick(
  picks: readonly AudioPickRecord[],
  pick: AudioPickRecord,
): AudioPickRecord[] {
  return [...picks, pick].slice(-AUDIO_PICKS_MAX);
}

/**
 * Kind that repeats `minRepeats`+ times for `mediaKey` (issue #9:
 * «если пользователь 2+ раза выбрал один тип дорожки в сериале»).
 * Returns the most recently picked qualifying kind, or null.
 */
export function repeatedPickKind(
  picks: readonly AudioPickRecord[],
  mediaKey: string,
  minRepeats: number = AUDIO_RULE_MIN_REPEATS,
): AudioRuleKind | null {
  const counts = new Map<AudioKind, number>();
  for (const pick of picks) {
    if (pick.mediaKey !== mediaKey) continue;
    counts.set(pick.kind, (counts.get(pick.kind) ?? 0) + 1);
  }
  let best: AudioRuleKind | null = null;
  let bestAt = -1;
  for (const pick of picks) {
    if (pick.mediaKey !== mediaKey) continue;
    if (pick.kind === "other") continue;
    const count = counts.get(pick.kind) ?? 0;
    if (count < minRepeats) continue;
    if (pick.at >= bestAt) {
      bestAt = pick.at;
      best = pick.kind as AudioRuleKind;
    }
  }
  return best;
}

/**
 * Rule to propose after a pick: null when nothing repeats, the kind is
 * already the active rule, or the same offer was already dismissed.
 */
export function proposedRuleFromPicks(
  picks: readonly AudioPickRecord[],
  options: {
    mediaKey: string;
    existingRule?: AudioRuleKind | null;
    dismissed?: AudioRuleProposal | null;
    minRepeats?: number;
  },
): AudioRuleProposal | null {
  const kind = repeatedPickKind(picks, options.mediaKey, options.minRepeats);
  if (!kind) return null;
  if (options.existingRule === kind) return null;
  const proposal: AudioRuleProposal = { kind, mediaKey: options.mediaKey };
  if (isProposalDismissed(proposal, options.dismissed ?? null)) return null;
  return proposal;
}

/**
 * Record an explicit pick (called from `usePlayback.selectAudio`) and raise
 * the one-shot «сделать постоянным» proposal when the threshold is met.
 */
export function noteAudioPick(mediaKey: string, kind: AudioKind): void {
  if (!mediaKey) return;
  const next = recordAudioPick(loadAudioPicks(), {
    mediaKey,
    kind,
    at: Date.now(),
  });
  saveAudioPicks(next);
  const proposal = proposedRuleFromPicks(next, {
    mediaKey,
    existingRule: loadAudioRuleKind(),
    dismissed: loadAudioProposalDismissed(),
  });
  if (proposal) saveAudioRuleProposal(proposal);
}

/** Per-media «спрашивать при первом открытии» markers (issue #9). */
export function loadAudioAsked(mediaKey: string): boolean {
  return loadAudioPreference(`${AUDIO_ASKED_PREFIX}${mediaKey}`) === "1";
}

export function saveAudioAsked(mediaKey: string): void {
  saveAudioPreference(`${AUDIO_ASKED_PREFIX}${mediaKey}`, "1");
}

/**
 * Audio track rules extension (issue #9, recipe §S2.10 in
 * docs/compose/spec/player-extensibility.md).
 *
 * UI for the issue #9 rules: the «Предпочитать» kind (Оригинал / Дубляж /
 * Многоголосый / Одноголосый) and the «спрашивать при первом открытии»
 * option, plus the one-shot prompts:
 *
 *   - «сделать постоянным» after 2+ same-kind picks in one series — the
 *     proposal is raised by `usePlayback` → `noteAudioPick` and read here;
 *   - the first-open voiceover question when the option is on (once per
 *     media, answered with the same kind chips or «Не сейчас»).
 *
 * State lives in localStorage under the `seans.audio.*` convention (shared
 * with `audioTrackHelpers` / `usePlayback`), not in `ctx.storage`: the rule
 * must be readable by the product track-resolve path at open.
 *
 * The rule itself is applied at open by `usePlayback` →
 * `resolvePreferredAudioTrack` (product preference logic — issue #9 allows
 * minimal edits there). This extension never writes mpv `aid`, so it cannot
 * fight `PlayerScreen.applyAudioTrack`.
 */

import { useSyncExternalStore, type ReactElement } from "react";
import {
  AUDIO_RULE_KINDS,
  isProposalDismissed,
  loadAudioAskFirstOpen,
  loadAudioAsked,
  loadAudioProposalDismissed,
  loadAudioRuleKind,
  loadAudioRuleProposal,
  saveAudioAskFirstOpen,
  saveAudioAsked,
  saveAudioProposalDismissed,
  saveAudioRuleKind,
  saveAudioRuleProposal,
  type AudioRuleKind,
  type AudioRuleProposal,
} from "../audioTrackHelpers";
import {
  mediaKeyFromSnapshot,
  mediaKeyFromUrl,
  needsSnapshotKey,
} from "./mediaKey";
import type { PlayerSnapshot } from "../playerTypes";
import type {
  PlayerExtension,
  Unsubscribe,
} from "./types";

/** Product labels for the rule kinds (issue #9 vocabulary). */
export const AUDIO_RULE_LABELS: Record<AudioRuleKind, string> = {
  original: "Оригинал",
  dub: "Дубляж",
  voice: "Многоголосый",
  one_voice: "Одноголосый",
};

export type AudioRulesState = {
  rule: AudioRuleKind | null;
  askFirstOpen: boolean;
  /** Pending «сделать постоянным» offer (null = nothing to show). */
  proposal: AudioRuleProposal | null;
  /** First-open question is due for the current media. */
  askPending: boolean;
};

/** Pending proposal = raised, not dismissed, and not already the rule. */
export function pendingProposal(
  proposal: AudioRuleProposal | null,
  dismissed: AudioRuleProposal | null,
  rule: AudioRuleKind | null,
): AudioRuleProposal | null {
  if (!proposal) return null;
  if (isProposalDismissed(proposal, dismissed)) return null;
  if (proposal.kind === rule) return null;
  return proposal;
}

/** Shared settings state for the menu rows and the overlay prompts. */
export type AudioRulesSettings = {
  subscribe(cb: () => void): Unsubscribe;
  getRule(): AudioRuleKind | null;
  getAskFirstOpen(): boolean;
  getProposal(): AudioRuleProposal | null;
  getAskPending(): boolean;
  setRule(kind: AudioRuleKind | null): void;
  setAskFirstOpen(value: boolean): void;
  acceptProposal(): void;
  dismissProposal(): void;
  answerAsk(kind: AudioRuleKind | null): void;
  /** Bind the current media (URL-derived key) for the first-open question. */
  setMediaKey(key: string | null): void;
  /** Re-read `seans.audio.*` (usePlayback writes picks/proposals there). */
  refresh(): void;
};

export function createAudioRulesSettings(): AudioRulesSettings {
  let rule = loadAudioRuleKind();
  let askFirstOpen = loadAudioAskFirstOpen();
  let proposal = pendingProposal(
    loadAudioRuleProposal(),
    loadAudioProposalDismissed(),
    rule,
  );
  let mediaKey: string | null = null;

  const askPendingFor = (key: string | null): boolean =>
    askFirstOpen && key != null && !loadAudioAsked(key);

  let askPending = askPendingFor(mediaKey);

  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const commit = (next: Partial<AudioRulesState>): void => {
    rule = next.rule !== undefined ? next.rule : rule;
    askFirstOpen =
      next.askFirstOpen !== undefined ? next.askFirstOpen : askFirstOpen;
    proposal = next.proposal !== undefined ? next.proposal : proposal;
    askPending =
      next.askPending !== undefined ? next.askPending : askPending;
    notify();
  };
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getRule: () => rule,
    getAskFirstOpen: () => askFirstOpen,
    getProposal: () => proposal,
    getAskPending: () => askPending,
    setRule(kind) {
      saveAudioRuleKind(kind);
      commit({ rule: kind });
    },
    setAskFirstOpen(value) {
      const next = Boolean(value);
      saveAudioAskFirstOpen(next);
      commit({ askFirstOpen: next, askPending: askPendingFor(mediaKey) });
    },
    acceptProposal() {
      const current = proposal;
      if (!current) return;
      saveAudioRuleKind(current.kind);
      saveAudioRuleProposal(null);
      saveAudioProposalDismissed(current);
      commit({ rule: current.kind, proposal: null });
    },
    dismissProposal() {
      const current = proposal;
      if (!current) return;
      saveAudioRuleProposal(null);
      saveAudioProposalDismissed(current);
      commit({ proposal: null });
    },
    answerAsk(kind) {
      if (kind != null) {
        saveAudioRuleKind(kind);
      }
      if (mediaKey != null) saveAudioAsked(mediaKey);
      commit({
        rule: kind != null ? kind : rule,
        proposal: pendingProposal(proposal, loadAudioProposalDismissed(), kind != null ? kind : rule),
        askPending: false,
      });
    },
    setMediaKey(key) {
      mediaKey = key;
      commit({ askPending: askPendingFor(key) });
    },
    refresh() {
      const nextRule = loadAudioRuleKind();
      const nextAsk = loadAudioAskFirstOpen();
      const nextProposal = pendingProposal(
        loadAudioRuleProposal(),
        loadAudioProposalDismissed(),
        nextRule,
      );
      const nextAskPending = askPendingFor(mediaKey);
      // Content comparison: a fresh object from JSON must not re-notify.
      const sameProposal =
        (nextProposal == null && proposal == null) ||
        (nextProposal != null &&
          proposal != null &&
          nextProposal.kind === proposal.kind &&
          nextProposal.mediaKey === proposal.mediaKey);
      if (
        nextRule === rule &&
        nextAsk === askFirstOpen &&
        sameProposal &&
        nextAskPending === askPending
      ) {
        return;
      }
      commit({
        rule: nextRule,
        askFirstOpen: nextAsk,
        proposal: nextProposal,
        askPending: nextAskPending,
      });
    },
  };
}

function RuleChips({
  settings,
}: {
  settings: AudioRulesSettings;
}): ReactElement {
  const rule = useSyncExternalStore(settings.subscribe, settings.getRule);
  return (
    <div className="player-menu-row" role="group" aria-label="Предпочитаемая озвучка">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={rule == null}
        className={`player-chip${rule == null ? " player-chip-active" : ""}`}
        onClick={() => settings.setRule(null)}
      >
        Авто
      </button>
      {AUDIO_RULE_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="menuitemradio"
          aria-checked={rule === kind}
          className={`player-chip${rule === kind ? " player-chip-active" : ""}`}
          onClick={() => settings.setRule(kind)}
        >
          {AUDIO_RULE_LABELS[kind]}
        </button>
      ))}
    </div>
  );
}

function ProposalRow({
  settings,
}: {
  settings: AudioRulesSettings;
}): ReactElement | null {
  const proposal = useSyncExternalStore(settings.subscribe, settings.getProposal);
  if (!proposal) return null;
  return (
    <div className="player-menu-list">
      <p className="player-menu-empty">
        Вы часто выбираете «{AUDIO_RULE_LABELS[proposal.kind]}». Сделать постоянным?
      </p>
      <button
        type="button"
        role="menuitem"
        className="player-menu-item player-menu-item-active"
        onClick={() => settings.acceptProposal()}
      >
        Да, всегда {AUDIO_RULE_LABELS[proposal.kind]}
      </button>
      <button
        type="button"
        role="menuitem"
        className="player-menu-item"
        onClick={() => settings.dismissProposal()}
      >
        Нет
      </button>
    </div>
  );
}

function AskRow({
  settings,
}: {
  settings: AudioRulesSettings;
}): ReactElement | null {
  const askPending = useSyncExternalStore(settings.subscribe, settings.getAskPending);
  if (!askPending) return null;
  return (
    <div className="player-menu-list">
      <p className="player-menu-empty">
        Какую озвучку предпочитаете? Выбор станет правилом.
      </p>
      {AUDIO_RULE_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="menuitem"
          className="player-menu-item"
          onClick={() => settings.answerAsk(kind)}
        >
          {AUDIO_RULE_LABELS[kind]}
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        className="player-menu-item"
        onClick={() => settings.answerAsk(null)}
      >
        Не сейчас
      </button>
    </div>
  );
}

function AudioRulesSection({
  settings,
}: {
  settings: AudioRulesSettings;
}): ReactElement {
  const askFirstOpen = useSyncExternalStore(
    settings.subscribe,
    settings.getAskFirstOpen,
  );
  return (
    <section>
      <h4 className="player-menu-title">Правила аудиодорожек</h4>
      <RuleChips settings={settings} />
      <div className="player-menu-list">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={askFirstOpen}
          className={`player-menu-item${askFirstOpen ? " player-menu-item-active" : ""}`}
          onClick={() => settings.setAskFirstOpen(!askFirstOpen)}
        >
          {askFirstOpen
            ? "Спрашивать при первом открытии: включено"
            : "Спрашивать при первом открытии: выключено"}
        </button>
      </div>
      <ProposalRow settings={settings} />
      <AskRow settings={settings} />
      <p className="player-menu-empty">
        Правило применяется при открытии файла; ручной выбор дорожки всегда его
        перебивает.
      </p>
    </section>
  );
}

const PROMPT_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  maxWidth: 420,
  padding: "10px 14px",
  borderRadius: 10,
  background: "rgba(12, 14, 18, 0.88)",
  color: "#f2f4f8",
  fontSize: 13,
  lineHeight: 1.4,
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "auto",
};

/** Compact overlay prompts — visible without opening the settings menu. */
function AudioRulesPrompt({
  settings,
}: {
  settings: AudioRulesSettings;
}): ReactElement | null {
  const proposal = useSyncExternalStore(settings.subscribe, settings.getProposal);
  const askPending = useSyncExternalStore(settings.subscribe, settings.getAskPending);
  if (!proposal && !askPending) return null;
  return (
    <div style={PROMPT_STYLE} role="status">
      {proposal ? (
        <>
          <span>
            Вы часто выбираете «{AUDIO_RULE_LABELS[proposal.kind]}». Сделать
            постоянным?
          </span>
          <button
            type="button"
            className="player-chip player-chip-active"
            onClick={() => settings.acceptProposal()}
          >
            Да
          </button>
          <button
            type="button"
            className="player-chip"
            onClick={() => settings.dismissProposal()}
          >
            Нет
          </button>
        </>
      ) : null}
      {askPending ? (
        <>
          <span>Какую озвучку предпочитаете?</span>
          {AUDIO_RULE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="player-chip"
              onClick={() => settings.answerAsk(kind)}
            >
              {AUDIO_RULE_LABELS[kind]}
            </button>
          ))}
          <button
            type="button"
            className="player-chip"
            onClick={() => settings.answerAsk(null)}
          >
            Не сейчас
          </button>
        </>
      ) : null}
    </div>
  );
}

export const audioRules: PlayerExtension = {
  id: "audio-rules",
  name: "Правила аудиодорожек",
  setup(ctx): Unsubscribe {
    const settings = createAudioRulesSettings();
    let pendingUrl: string | null = null;
    let resolvedKey: string | null = null;

    const resolveKey = (snapshot?: PlayerSnapshot): void => {
      if (pendingUrl == null) return;
      if (needsSnapshotKey(pendingUrl)) {
        if (!snapshot || !snapshot.file_loaded) return;
        resolvedKey = mediaKeyFromSnapshot(pendingUrl, snapshot);
      } else {
        resolvedKey = mediaKeyFromUrl(pendingUrl);
      }
      pendingUrl = null;
      settings.setMediaKey(resolvedKey);
    };

    const stopOpen = ctx.onOpen((info) => {
      pendingUrl = info.url;
      resolvedKey = null;
      settings.setMediaKey(null);
      resolveKey();
    });
    const stopSnapshot = ctx.onSnapshot((snapshot) => {
      resolveKey(snapshot);
      settings.refresh();
    });
    const stopMenu = ctx.ui.add("settings.menu", () => (
      <AudioRulesSection settings={settings} />
    ));
    const stopOverlay = ctx.ui.add("overlay", () => (
      <AudioRulesPrompt settings={settings} />
    ));
    return () => {
      stopMenu();
      stopOverlay();
      stopOpen();
      stopSnapshot();
    };
  },
};

/**
 * Hotkey model + dispatch engine (issue #23).
 *
 * Combos are layout-independent: letter keys come from `KeyboardEvent.code`
 * (`KeyF` → `F`), so a Russian layout still triggers `F`. Canonical combo
 * text is `Ctrl+Alt+Shift+Meta+<Key>` (modifier order fixed, keys like
 * `Space` / `ArrowLeft` / `F5` keep their names).
 *
 * The engine listens on the capture phase of its target (`window` in the
 * app) and, for keys it owns, calls `stopImmediatePropagation` before the
 * core `PlayerSurface` bubble listener can see them — the keymap fully owns
 * Space / arrows / F / M / … including rebinding and unbinding. `Escape` is
 * never suppressed (core modal menus close on it).
 */

export type Unsubscribe = () => void;

export type ComboParts = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
};

/** Canonical spellings for named keys (matched case-insensitively). */
const NAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ["space", "Space"],
  ["spacebar", "Space"],
  ["enter", "Enter"],
  ["escape", "Escape"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["arrowleft", "ArrowLeft"],
  ["arrowright", "ArrowRight"],
  ["arrowup", "ArrowUp"],
  ["arrowdown", "ArrowDown"],
]);

/** `commandId -> combos` (each command may have several bindings). */
export type Keymap = Record<string, readonly string[]>;

/**
 * Default player keymap (issue #23): the keys that work out of the box.
 * `N` = bookmark, `S` = screenshot (new defaults), `I` = stats overlay
 * (mpv `i` convention). `Escape` closes modals / exits fullscreen.
 */
export const DEFAULT_KEYMAP: Keymap = {
  "playback.togglePause": ["Space", "Enter"],
  "playback.seekBack": ["ArrowLeft"],
  "playback.seekForward": ["ArrowRight"],
  "playback.seekBackLarge": ["Shift+ArrowLeft"],
  "playback.seekForwardLarge": ["Shift+ArrowRight"],
  "volume.up": ["ArrowUp"],
  "volume.down": ["ArrowDown"],
  "playback.fullscreen": ["F"],
  "playback.mute": ["M"],
  "bookmark.add": ["N"],
  screenshot: ["S"],
  "stats.toggle": ["I"],
  "palette.toggle": ["Ctrl+K", "Ctrl+P"],
  "nav.back": ["Escape"],
};

/** Activation keys that must fall through to focused buttons. */
const ACTIVATION_KEYS = new Set(["Space", "Enter"]);

/**
 * Key tokens the core player also handles (Space / arrows / F / M …).
 * The engine suppresses these even when the user unbound the action, so an
 * unbound key does exactly nothing instead of resurrecting the core binding.
 * Only bare keys (no ctrl/alt/meta) are owned — Ctrl+K style chords stay
 * free for typing shortcuts; `Escape` is never owned (core modal close).
 */
export const DEFAULT_OWNED_KEY_TOKENS: ReadonlySet<string> = (() => {
  const owned = new Set<string>();
  for (const combos of Object.values(DEFAULT_KEYMAP)) {
    for (const combo of combos) {
      const parts = parseCombo(combo);
      if (
        parts &&
        !parts.ctrl &&
        !parts.alt &&
        !parts.meta &&
        parts.key !== "Escape"
      ) {
        owned.add(parts.key);
      }
    }
  }
  return owned;
})();

/** Normalize a single key name to its canonical combo token. */
export function normalizeKeyToken(raw: string): string {
  const key = String(raw ?? "");
  if (key === " " || key === "Spacebar") return "Space";
  if (key.length === 1) return key.toUpperCase();
  const named = NAMED_KEYS.get(key.toLowerCase());
  if (named) return named;
  // Function keys: f5 → F5.
  const fn = /^f([1-9]|1[0-2])$/i.exec(key);
  if (fn) return `F${fn[1]}`;
  return key;
}

/** Map a `KeyboardEvent.code` to a combo key token; `""` when unmapped. */
export function keyTokenFromCode(code: string): string {
  const c = String(code ?? "");
  const letter = /^Key([A-Z])$/.exec(c);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(c);
  if (digit) return digit[1];
  if (/^(Space|Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Arrow(Left|Right|Up|Down)|F([1-9]|1[0-2]))$/.test(c)) {
    return c;
  }
  return "";
}

export function parseCombo(combo: string): ComboParts | null {
  const raw = String(combo ?? "").trim();
  if (!raw) return null;
  const parts: ComboParts = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: "",
  };
  for (const piece of raw.split("+")) {
    const token = piece.trim();
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower === "ctrl" || lower === "control") parts.ctrl = true;
    else if (lower === "alt" || lower === "option") parts.alt = true;
    else if (lower === "shift") parts.shift = true;
    else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super" || lower === "win") {
      parts.meta = true;
    } else {
      parts.key = normalizeKeyToken(token);
    }
  }
  return parts.key ? parts : null;
}

export function formatCombo(parts: ComboParts): string {
  const out: string[] = [];
  if (parts.ctrl) out.push("Ctrl");
  if (parts.alt) out.push("Alt");
  if (parts.shift) out.push("Shift");
  if (parts.meta) out.push("Meta");
  out.push(parts.key);
  return out.join("+");
}

export function comboFromEvent(event: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string {
  const fromCode = keyTokenFromCode(event.code ?? "");
  const key = fromCode || normalizeKeyToken(event.key);
  return formatCombo({
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    key,
  });
}

export function combosEqual(a: string, b: string): boolean {
  const pa = parseCombo(a);
  const pb = parseCombo(b);
  if (!pa || !pb) return false;
  return (
    pa.ctrl === pb.ctrl &&
    pa.alt === pb.alt &&
    pa.shift === pb.shift &&
    pa.meta === pb.meta &&
    pa.key === pb.key
  );
}

/**
 * Merge user overrides over the defaults. An explicit `[]` unbinds the
 * action; a missing key keeps the default binding.
 */
export function mergeKeymap(
  defaults: Keymap,
  overrides: Record<string, readonly string[] | undefined> | null | undefined,
): Keymap {
  const out: Record<string, string[]> = {};
  const keys = new Set([
    ...Object.keys(defaults),
    ...Object.keys(overrides ?? {}),
  ]);
  for (const id of keys) {
    const override = overrides?.[id];
    out[id] = override !== undefined ? [...override] : [...(defaults[id] ?? [])];
  }
  return out;
}

/** `combo -> command ids` for combos used by more than one command. */
export function findKeymapConflicts(
  keymap: Keymap,
): Map<string, string[]> {
  const byCombo = new Map<string, string[]>();
  for (const [commandId, combos] of Object.entries(keymap)) {
    for (const combo of combos) {
      const parsed = parseCombo(combo);
      if (!parsed) continue;
      const canonical = formatCombo(parsed);
      const list = byCombo.get(canonical);
      if (list) list.push(commandId);
      else byCombo.set(canonical, [commandId]);
    }
  }
  const conflicts = new Map<string, string[]>();
  for (const [combo, ids] of byCombo) {
    if (ids.length > 1) conflicts.set(combo, ids);
  }
  return conflicts;
}

/** Comma-joined display text for the hotkey table (`Ctrl+K / Ctrl+P`). */
export function formatCombosForDisplay(
  combos: readonly string[] | undefined,
): string {
  if (!combos || combos.length === 0) return "—";
  return combos
    .map((combo) => {
      const parsed = parseCombo(combo);
      return parsed ? formatCombo(parsed) : combo;
    })
    .join(" / ");
}

/* ------------------------------------------------------------------ engine */

type EditableLike = {
  tagName?: string;
  nodeName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
};

function tagNameOf(target: unknown): string {
  const el = target as EditableLike | null;
  return String(el?.tagName ?? el?.nodeName ?? "").toLowerCase();
}

export function isEditableTarget(target: unknown): boolean {
  const tag = tagNameOf(target);
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  const el = target as EditableLike | null;
  if (el?.isContentEditable) return true;
  const attr = el?.getAttribute?.("contenteditable");
  return attr !== undefined && attr !== null && attr !== "false";
}

/** Buttons / links / menu rows: Space and Enter must activate them natively. */
export function isActivatableTarget(target: unknown): boolean {
  const tag = tagNameOf(target);
  if (tag === "button" || tag === "a" || tag === "summary") return true;
  const el = target as EditableLike | null;
  const role = String(el?.getAttribute?.("role") ?? "").toLowerCase();
  return (
    role === "button" ||
    role === "menuitem" ||
    role === "menuitemradio" ||
    role === "menuitemcheckbox" ||
    role === "option" ||
    role === "tab" ||
    role === "switch"
  );
}

export type HotkeyEngineOptions = {
  /** Live `commandId -> combos` map (user overrides included). */
  getKeymap: () => Keymap;
  /** Execute a command by id (bus `runCommand`). */
  runCommand: (commandId: string) => void;
  /** True while a modal owns the keyboard (palette open, key capture). */
  isSuspended: () => boolean;
};

type KeydownEvent = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
  preventDefault?: () => void;
  stopImmediatePropagation?: () => void;
};

/**
 * Attach the dispatch engine. `target` is `window` in the app and a plain
 * `EventTarget` in tests (events are duck-typed, no DOM types required).
 */
export function attachHotkeyEngine(
  target: EventTarget,
  options: HotkeyEngineOptions,
): Unsubscribe {
  const onKey = (event: Event) => {
    const e = event as unknown as KeydownEvent;
    if (e.defaultPrevented) return;
    if (e.isComposing) return;
    // Held activation keys must not machine-gun toggle commands.
    const tokenProbe = keyTokenFromCode(e.code ?? "") || normalizeKeyToken(e.key);
    if (e.repeat && ACTIVATION_KEYS.has(tokenProbe)) return;
    if (options.isSuspended()) return;

    const editable = isEditableTarget(e.target);
    const combo = comboFromEvent(e);
    const parsed = parseCombo(combo);
    if (!parsed) return;
    const hasModifier = parsed.ctrl || parsed.alt || parsed.meta;

    // Typing must never trigger bare-key shortcuts; modifier combos
    // (Ctrl+K palette) still work inside inputs.
    if (editable && !hasModifier) return;

    const keymap = options.getKeymap();
    let matchedId: string | null = null;
    for (const [commandId, combos] of Object.entries(keymap)) {
      if (combos.some((c) => combosEqual(c, combo))) {
        matchedId = commandId;
        break;
      }
    }

    // Inside inputs an unmatched combo belongs to the editor (Ctrl+← word
    // jumps, IME) — never suppress it.
    if (editable && !matchedId) return;

    const suppress = () => {
      e.stopImmediatePropagation?.();
    };

    // Space/Enter on a focused button: block the global action but let the
    // browser synthesize the native click (no preventDefault).
    if (ACTIVATION_KEYS.has(parsed.key) && isActivatableTarget(e.target)) {
      if (matchedId || DEFAULT_OWNED_KEY_TOKENS.has(parsed.key)) {
        if (parsed.key !== "Escape") suppress();
      }
      return;
    }

    if (matchedId) {
      // Escape always reaches core modal listeners (settings menu closes).
      if (parsed.key !== "Escape") {
        e.preventDefault?.();
        suppress();
      }
      options.runCommand(matchedId);
      return;
    }

    // Unbound but owned key: keep the core handler quiet.
    if (DEFAULT_OWNED_KEY_TOKENS.has(parsed.key)) {
      e.preventDefault?.();
      suppress();
    }
  };

  target.addEventListener("keydown", onKey as EventListener, true);
  return () => {
    target.removeEventListener("keydown", onKey as EventListener, true);
  };
}

import { describe, expect, it, vi } from "vitest";
import {
  attachHotkeyEngine,
  comboFromEvent,
  combosEqual,
  DEFAULT_KEYMAP,
  DEFAULT_OWNED_KEY_TOKENS,
  findKeymapConflicts,
  formatCombo,
  formatCombosForDisplay,
  isActivatableTarget,
  isEditableTarget,
  keyTokenFromCode,
  mergeKeymap,
  normalizeKeyToken,
  parseCombo,
} from "../src/features/player/extensions/hotkeys";

function keyEvent(partial: {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target?: unknown;
}) {
  const prevented = { defaultPrevented: false, stopped: 0 };
  const event = {
    key: partial.key,
    code: partial.code ?? "",
    ctrlKey: partial.ctrlKey ?? false,
    altKey: partial.altKey ?? false,
    shiftKey: partial.shiftKey ?? false,
    metaKey: partial.metaKey ?? false,
    repeat: partial.repeat ?? false,
    isComposing: partial.isComposing ?? false,
    target: partial.target ?? { tagName: "DIV" },
    defaultPrevented: false,
    preventDefault() {
      prevented.defaultPrevented = true;
      event.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      prevented.stopped += 1;
    },
  };
  return { event, prevented };
}

describe("combo parsing", () => {
  it("normalizes keys and modifiers", () => {
    expect(parseCombo("ctrl+k")).toEqual({
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
      key: "K",
    });
    expect(parseCombo("Shift+ArrowLeft")).toEqual({
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
      key: "ArrowLeft",
    });
    expect(parseCombo("space")?.key).toBe("Space");
    expect(parseCombo("")).toBeNull();
  });

  it("formats canonically with a fixed modifier order", () => {
    expect(formatCombo(parseCombo("shift+ctrl+a")!)).toBe("Ctrl+Shift+A");
    expect(formatCombo(parseCombo("meta+ctrl+k")!)).toBe("Ctrl+Meta+K");
  });

  it("reads letters from `code` (layout independence)", () => {
    // Russian layout: `key` is «а», `code` is KeyF → F.
    const combo = comboFromEvent({
      key: "а",
      code: "KeyF",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    });
    expect(combo).toBe("F");
  });

  it("keeps named keys and digits", () => {
    expect(keyTokenFromCode("Digit5")).toBe("5");
    expect(keyTokenFromCode("F11")).toBe("F11");
    expect(keyTokenFromCode("Numpad3")).toBe("");
    expect(normalizeKeyToken(" ")).toBe("Space");
    expect(normalizeKeyToken("f")).toBe("F");
  });

  it("compares combos ignoring formatting", () => {
    expect(combosEqual("ctrl+k", "Ctrl+K")).toBe(true);
    expect(combosEqual("Ctrl+K", "K")).toBe(false);
  });

  it("displays binding lists", () => {
    expect(formatCombosForDisplay(undefined)).toBe("—");
    expect(formatCombosForDisplay([])).toBe("—");
    expect(formatCombosForDisplay(["ctrl+k", "ctrl+p"])).toBe("Ctrl+K / Ctrl+P");
  });
});

describe("keymap merge and conflicts", () => {
  it("applies overrides including explicit unbind", () => {
    const merged = mergeKeymap(
      { a: ["A"], b: ["B"] },
      { a: ["X"], b: [] },
    );
    expect(merged.a).toEqual(["X"]);
    expect(merged.b).toEqual([]);
  });

  it("missing override keys keep their defaults", () => {
    const merged = mergeKeymap({ a: ["A"], b: ["B"] }, { a: ["X"] });
    expect(merged.b).toEqual(["B"]);
  });

  it("finds combo conflicts across commands", () => {
    const conflicts = findKeymapConflicts({
      a: ["Ctrl+K"],
      b: ["ctrl+k"],
      c: ["K"],
    });
    expect(conflicts.get("Ctrl+K")).toEqual(["a", "b"]);
    expect(conflicts.has("K")).toBe(false);
  });

  it("default map has no conflicts and owns the core keys", () => {
    expect(findKeymapConflicts(DEFAULT_KEYMAP).size).toBe(0);
    for (const token of ["Space", "ArrowLeft", "F", "M", "N", "S"]) {
      expect(DEFAULT_OWNED_KEY_TOKENS.has(token)).toBe(true);
    }
    expect(DEFAULT_OWNED_KEY_TOKENS.has("K")).toBe(false);
    expect(DEFAULT_OWNED_KEY_TOKENS.has("Escape")).toBe(false);
  });
});

describe("editable / activatable detection", () => {
  it("flags inputs, textareas, selects and contenteditable", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
  });

  it("flags buttons and menu rows", () => {
    expect(isActivatableTarget({ tagName: "BUTTON" })).toBe(true);
    expect(isActivatableTarget({ tagName: "A" })).toBe(true);
    expect(
      isActivatableTarget({
        tagName: "DIV",
        getAttribute: (n: string) => (n === "role" ? "menuitem" : null),
      }),
    ).toBe(true);
    expect(isActivatableTarget({ tagName: "DIV" })).toBe(false);
  });
});

describe("hotkey engine", () => {
  /** Minimal EventTarget stand-in — the engine duck-types its events. */
  function makeTarget() {
    const listeners = new Set<(e: Event) => void>();
    return {
      target: {
        addEventListener(_type: string, fn: EventListener) {
          listeners.add(fn as (e: Event) => void);
        },
        removeEventListener(_type: string, fn: EventListener) {
          listeners.delete(fn as (e: Event) => void);
        },
      } as unknown as EventTarget,
      fire(partial: Parameters<typeof keyEvent>[0]) {
        const { event, prevented } = keyEvent(partial);
        for (const fn of [...listeners]) fn(event as unknown as Event);
        return { event, prevented };
      },
    };
  }

  it("runs the bound command and suppresses the core handler", () => {
    const target = makeTarget();
    const run = vi.fn();
    attachHotkeyEngine(target.target, {
      getKeymap: () => ({ "playback.togglePause": ["Space"] }),
      runCommand: run,
      isSuspended: () => false,
    });
    const { prevented } = target.fire({ key: " ", code: "Space" });
    expect(run).toHaveBeenCalledWith("playback.togglePause");
    expect(prevented.stopped).toBe(1);
    expect(prevented.defaultPrevented).toBe(true);
  });

  it("does nothing inside editable targets for bare keys", () => {
    const target = makeTarget();
    const run = vi.fn();
    attachHotkeyEngine(target.target, {
      getKeymap: () => ({ "playback.togglePause": ["Space"] }),
      runCommand: run,
      isSuspended: () => false,
    });
    target.fire({
      key: " ",
      code: "Space",
      target: { tagName: "INPUT" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("still opens the palette from inputs via Ctrl+K", () => {
    const target = makeTarget();
    const run = vi.fn();
    attachHotkeyEngine(target.target, {
      getKeymap: () => ({ "palette.toggle": ["Ctrl+K"] }),
      runCommand: run,
      isSuspended: () => false,
    });
    target.fire({
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      target: { tagName: "INPUT" },
    });
    expect(run).toHaveBeenCalledWith("palette.toggle");
  });

  it("Space on a button suppresses the global action but keeps the click", () => {
    const target = makeTarget();
    const run = vi.fn();
    attachHotkeyEngine(target.target, {
      getKeymap: () => ({ "playback.togglePause": ["Space"] }),
      runCommand: run,
      isSuspended: () => false,
    });
    const { prevented } = target.fire({
      key: " ",
      code: "Space",
      target: { tagName: "BUTTON" },
    });
    expect(run).not.toHaveBeenCalled();
    expect(prevented.stopped).toBe(1);
    expect(prevented.defaultPrevented).toBe(false);
  });

  it("unbound owned keys are suppressed so the core never sees them", () => {
    const target = makeTarget();
    const run = vi.fn();
    attachHotkeyEngine(target.target, {
      getKeymap: () => ({ other: ["Z"] }),
      runCommand: run,
      isSuspended: () => false,
    });
    const { prevented } = target.fire({ key: "f", code: "KeyF" });
    expect(run).not.toHaveBeenCalled();
    expect(prevented.stopped).toBe(1);
  });

  it("Escape runs its command but is never suppressed", () => {
    const target = makeTarget();
    const run = vi.fn();
    attachHotkeyEngine(target.target, {
      getKeymap: () => ({ "nav.back": ["Escape"] }),
      runCommand: run,
      isSuspended: () => false,
    });
    const { prevented } = target.fire({ key: "Escape", code: "Escape" });
    expect(run).toHaveBeenCalledWith("nav.back");
    expect(prevented.stopped).toBe(0);
    expect(prevented.defaultPrevented).toBe(false);
  });

  it("idles while suspended and ignores composing", () => {
    const target = makeTarget();
    const run = vi.fn();
    attachHotkeyEngine(target.target, {
      getKeymap: () => ({ "playback.togglePause": ["Space"] }),
      runCommand: run,
      isSuspended: () => true,
    });
    target.fire({ key: " ", code: "Space" });
    target.fire({ key: " ", code: "Space", isComposing: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps Shift+arrow chords exactly", () => {
    const target = makeTarget();
    const run = vi.fn();
    attachHotkeyEngine(target.target, {
      getKeymap: () => ({
        "playback.seekBack": ["ArrowLeft"],
        "playback.seekBackLarge": ["Shift+ArrowLeft"],
      }),
      runCommand: run,
      isSuspended: () => false,
    });
    target.fire({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true });
    expect(run).toHaveBeenCalledWith("playback.seekBackLarge");
    target.fire({ key: "ArrowLeft", code: "ArrowLeft" });
    expect(run).toHaveBeenCalledWith("playback.seekBack");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("detaches cleanly", () => {
    const target = makeTarget();
    const run = vi.fn();
    const stop = attachHotkeyEngine(target.target, {
      getKeymap: () => ({ "playback.togglePause": ["Space"] }),
      runCommand: run,
      isSuspended: () => false,
    });
    stop();
    target.fire({ key: " ", code: "Space" });
    expect(run).not.toHaveBeenCalled();
  });
});

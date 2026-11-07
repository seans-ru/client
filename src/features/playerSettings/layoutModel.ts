/**
 * Chrome entry catalog and layout helpers (issue #25, «Кнопки»).
 *
 * Every rearrangeable unit of the player chrome is an *entry*: built-in
 * transport buttons and player functions (extensions). Entries are placed in
 * the three layoutable slots (`controls.primary`, `controls.secondary`,
 * `settings.menu`) or sit in `hidden` («глазик» выключен). The schema stores
 * only entry ids; this module knows the catalog and how to resolve a schema
 * into a complete, non-overlapping placement.
 */

import type { ChromeSchema, LayoutSlotId } from "./chromeSchema";
import { LAYOUT_SLOTS } from "./chromeSchema";

export type ChromeEntryKind = "button" | "function";

export type ChromeEntry = {
  id: string;
  label: string;
  kind: ChromeEntryKind;
  defaultSlot: LayoutSlotId;
  /** Slots this entry may be dragged into (constructor rules). */
  allowedSlots: readonly LayoutSlotId[];
  /** Extension id in `PLAYER_EXTENSIONS` (function entries). */
  extId?: string;
  /** Feature id gating the entry's enabled state. */
  featureId?: string;
};

const BUTTON_SLOTS: readonly LayoutSlotId[] = [
  "controls.primary",
  "controls.secondary",
  "settings.menu",
];
const FUNCTION_SLOTS: readonly LayoutSlotId[] = ["settings.menu"];

export const CHROME_ENTRIES: readonly ChromeEntry[] = [
  {
    id: "btn.playPause",
    label: "Воспроизведение / Пауза",
    kind: "button",
    defaultSlot: "controls.primary",
    allowedSlots: BUTTON_SLOTS,
  },
  {
    id: "btn.time",
    label: "Время",
    kind: "button",
    defaultSlot: "controls.primary",
    allowedSlots: BUTTON_SLOTS,
  },
  {
    id: "btn.volume",
    label: "Громкость",
    kind: "button",
    defaultSlot: "controls.secondary",
    allowedSlots: BUTTON_SLOTS,
  },
  {
    id: "btn.settings",
    label: "Меню настроек",
    kind: "button",
    defaultSlot: "controls.secondary",
    allowedSlots: BUTTON_SLOTS,
  },
  {
    id: "btn.sidecar",
    label: "Боковая панель",
    kind: "button",
    defaultSlot: "controls.secondary",
    allowedSlots: BUTTON_SLOTS,
  },
  {
    id: "btn.fullscreen",
    label: "Полный экран",
    kind: "button",
    defaultSlot: "controls.secondary",
    allowedSlots: BUTTON_SLOTS,
  },
  {
    id: "fn.autohide",
    label: "Автоскрытие контролов",
    kind: "function",
    defaultSlot: "settings.menu",
    allowedSlots: FUNCTION_SLOTS,
    extId: "autohide",
    featureId: "autohide",
  },
  {
    id: "fn.volume-processor",
    label: "Обработка звука",
    kind: "function",
    defaultSlot: "settings.menu",
    allowedSlots: FUNCTION_SLOTS,
    extId: "volume-processor",
    featureId: "volume-processor",
  },
  {
    id: "fn.eq",
    label: "Эквалайзер",
    kind: "function",
    defaultSlot: "settings.menu",
    allowedSlots: FUNCTION_SLOTS,
    extId: "eq",
    featureId: "eq",
  },
  {
    id: "fn.subtitle-style",
    label: "Стиль субтитров",
    kind: "function",
    defaultSlot: "settings.menu",
    allowedSlots: FUNCTION_SLOTS,
    extId: "subtitle-style",
    featureId: "subtitle-style",
  },
];

const ENTRIES_BY_ID = new Map(CHROME_ENTRIES.map((entry) => [entry.id, entry]));

const LAYOUT_SLOT_ORDER = LAYOUT_SLOTS;

export function getChromeEntry(id: string): ChromeEntry | undefined {
  return ENTRIES_BY_ID.get(id);
}

/** Entry id for an extension contribution (function entries). */
export function functionEntryId(extId: string): string | null {
  for (const entry of CHROME_ENTRIES) {
    if (entry.extId === extId) return entry.id;
  }
  return null;
}

/* ------------------------------------------------------------- resolution */

export type ResolvedLayout = {
  slots: Record<LayoutSlotId, ChromeEntry[]>;
  hidden: ChromeEntry[];
};

/**
 * Complete the stored placement with catalog defaults: entries missing from
 * the schema (new functions) land in their default slot, ids that no longer
 * exist are dropped, and every entry appears exactly once.
 */
export function resolveLayout(schema: ChromeSchema): ResolvedLayout {
  const slots: Record<LayoutSlotId, ChromeEntry[]> = {
    "controls.primary": [],
    "controls.secondary": [],
    "settings.menu": [],
  };
  const hidden: ChromeEntry[] = [];
  const placed = new Set<string>();

  const take = (id: string): ChromeEntry | null => {
    if (placed.has(id)) return null;
    const entry = ENTRIES_BY_ID.get(id);
    if (!entry) return null;
    placed.add(id);
    return entry;
  };

  for (const id of schema.hidden) {
    const entry = take(id);
    if (entry) hidden.push(entry);
  }
  for (const slot of LAYOUT_SLOT_ORDER) {
    for (const id of schema.layout[slot]) {
      const entry = take(id);
      if (entry) slots[slot].push(entry);
    }
  }
  for (const entry of CHROME_ENTRIES) {
    const fresh = take(entry.id);
    if (fresh) slots[entry.defaultSlot].push(fresh);
  }

  return { slots, hidden };
}

/** Flattened placement used to write back to the schema. */
export function layoutToSchemaParts(resolved: ResolvedLayout): {
  layout: Record<LayoutSlotId, string[]>;
  hidden: string[];
} {
  const layout: Record<LayoutSlotId, string[]> = {
    "controls.primary": resolved.slots["controls.primary"].map((e) => e.id),
    "controls.secondary": resolved.slots["controls.secondary"].map((e) => e.id),
    "settings.menu": resolved.slots["settings.menu"].map((e) => e.id),
  };
  return { layout, hidden: resolved.hidden.map((e) => e.id) };
}

/* --------------------------------------------------------------- mutations */

/** Catalog-default placement: every entry in its default slot, none hidden. */
export function defaultPlacement(): Pick<ChromeSchema, "layout" | "hidden"> {
  const layout: Record<LayoutSlotId, string[]> = {
    "controls.primary": [],
    "controls.secondary": [],
    "settings.menu": [],
  };
  for (const entry of CHROME_ENTRIES) {
    layout[entry.defaultSlot].push(entry.id);
  }
  return { layout, hidden: [] };
}

/** Move an entry to `toSlot` at `toIndex` (clamped). Hidden entries reappear. */
export function moveEntry(
  schema: ChromeSchema,
  entryId: string,
  toSlot: LayoutSlotId,
  toIndex: number,
): ChromeSchema {
  const entry = ENTRIES_BY_ID.get(entryId);
  if (!entry || !entry.allowedSlots.includes(toSlot)) return schema;
  const resolved = resolveLayout(schema);
  const without = removeEverywhere(resolved, entryId);
  const target = without.slots[toSlot];
  const index = Math.min(Math.max(0, toIndex), target.length);
  target.splice(index, 0, entry);
  return { ...schema, ...layoutToSchemaParts(without) };
}

/** Hide an entry from the player chrome («глазик» выключен). */
export function hideEntry(schema: ChromeSchema, entryId: string): ChromeSchema {
  const resolved = resolveLayout(schema);
  const entry = ENTRIES_BY_ID.get(entryId);
  if (!entry) return schema;
  const without = removeEverywhere(resolved, entryId);
  without.hidden.push(entry);
  return { ...schema, ...layoutToSchemaParts(without) };
}

/** Show a hidden entry again — back to its current slot position. */
export function showEntry(schema: ChromeSchema, entryId: string): ChromeSchema {
  const resolved = resolveLayout(schema);
  const entry = ENTRIES_BY_ID.get(entryId);
  if (!entry) return schema;
  const without = removeEverywhere(resolved, entryId);
  without.slots[entry.defaultSlot].push(entry);
  return { ...schema, ...layoutToSchemaParts(without) };
}

export function toggleEntryHidden(schema: ChromeSchema, entryId: string): ChromeSchema {
  return isEntryHidden(schema, entryId)
    ? showEntry(schema, entryId)
    : hideEntry(schema, entryId);
}

export function isEntryHidden(schema: ChromeSchema, entryId: string): boolean {
  return resolveLayout(schema).hidden.some((entry) => entry.id === entryId);
}

/** Restore the default placement (keeps feature flags and subtitle styles). */
export function resetLayout(schema: ChromeSchema): ChromeSchema {
  return { ...schema, ...defaultPlacement() };
}

function removeEverywhere(resolved: ResolvedLayout, entryId: string): ResolvedLayout {
  const slots: Record<LayoutSlotId, ChromeEntry[]> = {
    "controls.primary": resolved.slots["controls.primary"].filter((e) => e.id !== entryId),
    "controls.secondary": resolved.slots["controls.secondary"].filter((e) => e.id !== entryId),
    "settings.menu": resolved.slots["settings.menu"].filter((e) => e.id !== entryId),
  };
  return { slots, hidden: resolved.hidden.filter((e) => e.id !== entryId) };
}

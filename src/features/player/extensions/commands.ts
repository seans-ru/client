/**
 * Player command bus (issue #23) — shared registry of palette commands.
 *
 * Registration contract (fixed choice for the issue): extensions call
 * `ctx.registerCommand({ id, title, category?, keywords?, run })` inside
 * `setup` and receive an `Unsubscribe`. The registry auto-unregisters every
 * command at dispose, so a forgotten unsubscribe cannot leak into the next
 * player session. The command palette lists and runs commands; the hotkey
 * engine maps key combos to command ids.
 *
 * Duplicate ids: first registration wins (same rule as the extension
 * registry) — a later duplicate is ignored with a warning.
 */

export type Unsubscribe = () => void;

export type PlayerCommand = {
  /** Stable id — hotkey map keys, recent-command list. */
  id: string;
  /** Russian title shown in the palette and the hotkey table. */
  title: string;
  /** Group label in the palette («Воспроизведение», «Звук», …). */
  category?: string;
  /** Extra search terms (Russian + English aliases). */
  keywords?: string[];
  run: () => void | Promise<void>;
};

export type RegisteredCommand = PlayerCommand & {
  /** Extension that registered the command (error logs). */
  extId: string;
};

function warn(extId: string, error: unknown): void {
  console.warn("[player.ext]", extId, error);
}

const commands = new Map<string, RegisteredCommand>();
const listeners = new Set<() => void>();
/** Cached list snapshot — `useSyncExternalStore` needs stable identity. */
let listSnapshot: readonly RegisteredCommand[] = [];

function notify(): void {
  listSnapshot = [...commands.values()];
  for (const listener of [...listeners]) listener();
}

/** Register a command. Returns an idempotent unsubscribe. */
export function registerCommand(
  extId: string,
  command: PlayerCommand,
): Unsubscribe {
  if (!command || typeof command.id !== "string" || command.id.length === 0) {
    warn(extId, "command id is empty, ignored");
    return () => {};
  }
  if (commands.has(command.id)) {
    warn(extId, `duplicate command id "${command.id}", ignored`);
    return () => {};
  }
  const entry: RegisteredCommand = { ...command, extId };
  commands.set(command.id, entry);
  notify();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (commands.get(command.id) === entry) {
      commands.delete(command.id);
      notify();
    }
  };
}

/** Snapshot of all registered commands (registration order preserved). */
export function listCommands(): readonly RegisteredCommand[] {
  return listSnapshot;
}

export function getCommand(id: string): RegisteredCommand | undefined {
  return commands.get(id);
}

/**
 * Run by id. Unknown ids and throws/rejections are logged once and never
 * propagate to the hotkey engine or the palette UI.
 */
export function runCommand(id: string): void {
  const entry = commands.get(id);
  if (!entry) {
    warn("commands", `unknown command "${id}"`);
    return;
  }
  try {
    const result = entry.run();
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch((error) => warn(entry.extId, error));
    }
  } catch (error) {
    warn(entry.extId, error);
  }
}

/** Subscribe to registry changes (palette list refresh). */
export function subscribeCommands(cb: () => void): Unsubscribe {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test helper — drop every registration and listener. */
export function resetCommandBus(): void {
  commands.clear();
  listeners.clear();
  listSnapshot = [];
}

/** Word-AND search over title / category / keywords (case-insensitive). */
export function filterCommands(
  list: readonly RegisteredCommand[],
  query: string,
): RegisteredCommand[] {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [...list];
  const words = q.split(/\s+/).filter(Boolean);
  return list.filter((cmd) => {
    const haystack = `${cmd.title} ${cmd.category ?? ""} ${(cmd.keywords ?? []).join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * Recent commands first (recency order), then the rest in registration
 * order — the palette's default list (issue #23).
 */
export function orderForPalette(
  list: readonly RegisteredCommand[],
  recentIds: readonly string[],
): RegisteredCommand[] {
  const rank = new Map<string, number>();
  recentIds.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  return [...list].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : Number.POSITIVE_INFINITY;
    const rb = rank.has(b.id) ? rank.get(b.id)! : Number.POSITIVE_INFINITY;
    return ra - rb;
  });
}

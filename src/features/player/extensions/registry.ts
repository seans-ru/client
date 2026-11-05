/**
 * Extension runtime (spec: docs/compose/spec/player-extensibility.md §S2.3).
 *
 * Registers extensions in declaration order, fans host events out to their
 * subscriptions, collects UI slot contributions, and disposes in reverse
 * order. Error isolation: every extension call (setup, dispose, event
 * callbacks, slot renders) is wrapped — a throw logs
 * `console.warn("[player.ext]", id, error)` and never reaches the host or
 * other extensions.
 */

import type { ReactNode } from "react";
import type { PlayerSnapshot } from "../playerTypes";
import type {
  ExtensionStorage,
  ExtensionTransport,
  MpvBridge,
  OpenInfo,
  PlayerExtension,
  PlayerExtensionContext,
  PlayerUiSlot,
  Unsubscribe,
} from "./types";

export type ExtensionRuntimeDeps = {
  /** Same guarded transport the UI uses. */
  transport: ExtensionTransport;
  getSnapshot: () => PlayerSnapshot;
  mpv: MpvBridge;
  frames: PlayerExtensionContext["frames"];
  /** Namespaced storage per extension (see `storage.ts`). */
  storageFor: (extId: string) => ExtensionStorage;
  /** Chrome visibility actuator (`ctx.ui.setChromeHidden`). */
  setChromeHidden: (hidden: boolean) => void;
};

export type SlotEntry = {
  extId: string;
  render: () => ReactNode;
};

export type ExtensionRuntime = {
  /** Registered extensions in declaration order (duplicates dropped). */
  readonly extensions: readonly PlayerExtension[];
  notifyOpen(info: OpenInfo): void;
  notifyClose(): void;
  notifySnapshot(snapshot: PlayerSnapshot): void;
  /** Snapshot of slot contributions for the UI layer (used by slots.tsx later). */
  getSlotEntries(slot: PlayerUiSlot): ReadonlyArray<SlotEntry>;
  subscribeSlots(cb: () => void): Unsubscribe;
  dispose(): void;
};

function warn(extId: string, error: unknown): void {
  console.warn("[player.ext]", extId, error);
}

type Listener<T extends unknown[]> = {
  extId: string;
  cb: (...args: T) => void;
};

/** Ordered callback list with per-listener error isolation. */
function createSignal<T extends unknown[]>() {
  const listeners: Listener<T>[] = [];
  return {
    add(extId: string, cb: (...args: T) => void): Unsubscribe {
      const entry: Listener<T> = { extId, cb };
      listeners.push(entry);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = listeners.indexOf(entry);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit(...args: T): void {
      // Copy: listeners may unsubscribe during dispatch.
      for (const entry of [...listeners]) {
        try {
          entry.cb(...args);
        } catch (error) {
          warn(entry.extId, error);
        }
      }
    },
    clear(): void {
      listeners.length = 0;
    },
  };
}

type ExtensionEntry = {
  ext: PlayerExtension;
  dispose: Unsubscribe | null;
};

/** Stable empty snapshot for `getSlotEntries` (referential identity). */
const EMPTY_SLOT_ENTRIES: ReadonlyArray<SlotEntry> = [];

export function createExtensionRuntime(
  extensions: readonly PlayerExtension[],
  deps: ExtensionRuntimeDeps,
): ExtensionRuntime {
  const entries: ExtensionEntry[] = [];
  const seenIds = new Set<string>();
  const openSignal = createSignal<[OpenInfo]>();
  const closeSignal = createSignal<[]>();
  const snapshotSignal = createSignal<[PlayerSnapshot]>();
  const slotsSignal = createSignal<[]>();
  const slotEntries = new Map<PlayerUiSlot, SlotEntry[]>();

  for (const ext of extensions) {
    // First registration wins; the duplicate is ignored (no host-visible
    // error) so it cannot shadow the original's storage or double its events.
    if (seenIds.has(ext.id)) {
      warn(ext.id, "duplicate extension id, ignored");
      continue;
    }
    seenIds.add(ext.id);

    const entry: ExtensionEntry = { ext, dispose: null };
    entries.push(entry);

    const ctx: PlayerExtensionContext = {
      id: ext.id,
      transport: deps.transport,
      getSnapshot: deps.getSnapshot,
      onSnapshot: (cb) => snapshotSignal.add(ext.id, cb),
      onOpen: (cb) => openSignal.add(ext.id, cb),
      onClose: (cb) => closeSignal.add(ext.id, cb),
      mpv: deps.mpv,
      frames: deps.frames,
      ui: {
        add: (slot, render) => {
          const item: SlotEntry = {
            extId: ext.id,
            render: () => {
              try {
                return render();
              } catch (error) {
                warn(ext.id, error);
                return null;
              }
            },
          };
          // Replace (never mutate) so getSlotEntries snapshots stay
          // referentially stable for useSyncExternalStore.
          const list = slotEntries.get(slot);
          slotEntries.set(slot, list ? [...list, item] : [item]);
          slotsSignal.emit();
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            const current = slotEntries.get(slot);
            const index = current ? current.indexOf(item) : -1;
            if (current && index >= 0) {
              slotEntries.set(slot, current.filter((e) => e !== item));
              slotsSignal.emit();
            }
          };
        },
        setChromeHidden: (hidden) => deps.setChromeHidden(hidden),
      },
      storage: deps.storageFor(ext.id),
    };

    try {
      const dispose = ext.setup(ctx);
      if (typeof dispose === "function") entry.dispose = dispose;
    } catch (error) {
      // Half-registered: subscriptions made before the throw stay live until
      // teardown; the entry keeps its slot so dispose still covers it.
      warn(ext.id, error);
    }
  }

  return {
    extensions: entries.map((entry) => entry.ext),
    notifyOpen: (info) => openSignal.emit(info),
    notifyClose: () => closeSignal.emit(),
    notifySnapshot: (snapshot) => snapshotSignal.emit(snapshot),
    getSlotEntries: (slot) => slotEntries.get(slot) ?? EMPTY_SLOT_ENTRIES,
    subscribeSlots: (cb) => slotsSignal.add("slots", cb),
    dispose: () => {
      // Reverse registration order so dependents tear down before their deps.
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.dispose) {
          try {
            entry.dispose();
          } catch (error) {
            warn(entry.ext.id, error);
          }
        }
      }
      entries.length = 0;
      openSignal.clear();
      closeSignal.clear();
      snapshotSignal.clear();
      slotsSignal.clear();
      slotEntries.clear();
    },
  };
}

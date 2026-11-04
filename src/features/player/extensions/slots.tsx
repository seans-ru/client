/**
 * UI slots (spec: docs/compose/spec/player-extensibility.md §S2.4).
 *
 * Chrome regions where extensions contribute React subtrees. `<PlayerSlot>`
 * renders a slot's entries; empty slots render nothing and never affect
 * layout. The runtime instance is provided via `PlayerSlotsProvider` from the
 * player screen (context crosses portals used by the settings overlay).
 */

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ExtensionRuntime, SlotEntry } from "./registry";
import type { PlayerUiSlot } from "./types";

const EMPTY_ENTRIES: ReadonlyArray<SlotEntry> = [];

const SlotsContext = createContext<ExtensionRuntime | null>(null);

export function PlayerSlotsProvider({
  runtime,
  children,
}: {
  runtime: ExtensionRuntime | null;
  children: ReactNode;
}) {
  return (
    <SlotsContext.Provider value={runtime}>{children}</SlotsContext.Provider>
  );
}

/** Live entries of one slot (re-renders when extensions add/remove UI). */
export function useSlotEntries(
  slot: PlayerUiSlot,
): ReadonlyArray<SlotEntry> {
  const runtime = useContext(SlotsContext);
  const subscribe = useCallback(
    (onChange: () => void) =>
      runtime ? runtime.subscribeSlots(onChange) : () => {},
    [runtime],
  );
  return useSyncExternalStore(
    subscribe,
    () => (runtime ? runtime.getSlotEntries(slot) : EMPTY_ENTRIES),
  );
}

/** Renders every entry of a slot; nothing when the slot is empty. */
export function PlayerSlot({ name }: { name: PlayerUiSlot }) {
  const entries = useSlotEntries(name);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((entry, index) => (
        <Fragment key={`${entry.extId}:${index}`}>{entry.render()}</Fragment>
      ))}
    </>
  );
}

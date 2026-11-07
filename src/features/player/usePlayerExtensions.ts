/**
 * Extension runtime hook (spec: docs/compose/spec/player-extensibility.md
 * §S2.1, §S2.3). Creates one `ExtensionRuntime` per player session, fans
 * snapshot updates out to extensions, and disposes on unmount.
 *
 * The screen drives `notifyOpen` / `notifyClose` when a source is opened or
 * torn down; slot rendering happens through `PlayerSlotsProvider` +
 * `<PlayerSlot>` (see `slots.tsx`).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerSnapshot } from "./playerTypes";
import { createMpvBridge } from "./bridge/mpvBridge";
import { chromeControl } from "./extensions/chromeControl";
import { frameHub } from "./extensions/frameHub";
import {
  createExtensionRuntime,
  type ExtensionRuntime,
} from "./extensions/registry";
import { createExtensionStorage } from "./extensions/storage";
import type { ExtensionTransport, OpenInfo } from "./extensions/types";
import { PLAYER_EXTENSIONS } from "./extensions/examples";
import { chromeStore } from "../playerSettings/chromeStore";
import { enabledExtensionIds } from "../playerSettings/featureCatalog";

export function usePlayerExtensions(args: {
  /** Same guarded transport the UI uses (identity may change per render). */
  transport: ExtensionTransport;
  /** Latest player snapshot — fanned out to `ctx.onSnapshot`. */
  snapshot: PlayerSnapshot;
}): ExtensionRuntime | null {
  const { transport, snapshot } = args;

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  // Extensions capture `ctx.transport` once at setup — route every call
  // through the latest transport instance.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const transportFacade = useMemo<ExtensionTransport>(
    () => ({
      play: () => transportRef.current.play(),
      pause: () => transportRef.current.pause(),
      togglePause: () => transportRef.current.togglePause(),
      seek: (seconds, opts) => transportRef.current.seek(seconds, opts),
      setSpeed: (speed) => transportRef.current.setSpeed(speed),
      setVolume: (volume) => transportRef.current.setVolume(volume),
      setMute: (mute) => transportRef.current.setMute(mute),
      setFullscreen: (enabled) => transportRef.current.setFullscreen(enabled),
    }),
    [],
  );

  // One runtime per mounted player session. Created inside the effect (not a
  // state initializer): React StrictMode runs setup→cleanup→setup and would
  // otherwise keep a disposed runtime while its initializer never re-runs.
  // The effect cleanup pairs every setup with a dispose, same as useRoomSocket.
  // Disabled features (issue #25) are filtered out — a disabled extension
  // registers no UI and no filters; toggling a feature rebuilds the runtime.
  const [runtime, setRuntime] = useState<ExtensionRuntime | null>(null);

  useEffect(() => {
    let enabledIds = enabledExtensionIds(chromeStore.get());
    const build = (): ExtensionRuntime =>
      createExtensionRuntime(
        PLAYER_EXTENSIONS.filter((ext) => enabledIds.has(ext.id)),
        {
          transport: transportFacade,
          getSnapshot: () => snapshotRef.current,
          mpv: createMpvBridge(),
          frames: {
            subscribe: (cb, opts) => frameHub.subscribe(cb, opts),
          },
          storageFor: createExtensionStorage,
          setChromeHidden: (hidden) => chromeControl.setHidden(hidden),
        },
      );
    let created = build();
    setRuntime(created);

    const stopSchema = chromeStore.subscribe(() => {
      const nextIds = enabledExtensionIds(chromeStore.get());
      if (sameIdSet(nextIds, enabledIds)) return;
      enabledIds = nextIds;
      created.notifyClose();
      created.dispose();
      chromeControl.reset();
      created = build();
      setRuntime(created);
    });

    return () => {
      stopSchema();
      // Session end closes the current file before tearing extensions down.
      created.notifyClose();
      created.dispose();
      // Belt and braces: a half-registered extension may leave chrome hidden.
      chromeControl.reset();
    };
  }, [transportFacade]);

  useEffect(() => {
    runtime?.notifySnapshot(snapshot);
  }, [runtime, snapshot]);

  return runtime;
}

function sameIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export type { OpenInfo };

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
import type {
  ExtensionTransport,
  OpenInfo,
  RoomSocialPort,
} from "./extensions/types";
import { PLAYER_EXTENSIONS } from "./extensions/examples";

export function usePlayerExtensions(args: {
  /** Same guarded transport the UI uses (identity may change per render). */
  transport: ExtensionTransport;
  /** Latest player snapshot — fanned out to `ctx.onSnapshot`. */
  snapshot: PlayerSnapshot;
  /** Room social channel (issues #28/#29); null outside room mode. */
  room?: RoomSocialPort | null;
}): ExtensionRuntime | null {
  const { transport, snapshot, room = null } = args;

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
  const [runtime, setRuntime] = useState<ExtensionRuntime | null>(null);

  useEffect(() => {
    const created = createExtensionRuntime(PLAYER_EXTENSIONS, {
      transport: transportFacade,
      getSnapshot: () => snapshotRef.current,
      mpv: createMpvBridge(),
      frames: {
        subscribe: (cb, opts) => frameHub.subscribe(cb, opts),
      },
      storageFor: createExtensionStorage,
      setChromeHidden: (hidden) => chromeControl.setHidden(hidden),
      room,
    });
    setRuntime(created);
    return () => {
      // Session end closes the current file before tearing extensions down.
      created.notifyClose();
      created.dispose();
      // Belt and braces: a half-registered extension may leave chrome hidden.
      chromeControl.reset();
    };
  }, [transportFacade, room]);

  useEffect(() => {
    runtime?.notifySnapshot(snapshot);
  }, [runtime, snapshot]);

  return runtime;
}

export type { OpenInfo };

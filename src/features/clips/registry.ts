/**
 * Local registry of created clips / screenshots (contract: the player UI
 * lists cloud uploads even when the server is unreachable).
 *
 * Storage keys follow the extension namespace `seans.player.ext.capture.cloud.*`
 * so the data sits next to the capture settings. Every access is best-effort:
 * plain vite / quota errors degrade to the in-memory map, never throw.
 */

import type { CloudAssetKind, LocalCloudAsset } from "./types";
import { parseVisibility } from "./types";

const CLIPS_KEY = "seans.player.ext.capture.cloud.clips";
const SHOTS_KEY = "seans.player.ext.capture.cloud.screenshots";

export type CloudRegistry = {
  list(): LocalCloudAsset[];
  listByKind(kind: CloudAssetKind): LocalCloudAsset[];
  get(localId: string): LocalCloudAsset | null;
  upsert(asset: LocalCloudAsset): void;
  patch(
    localId: string,
    patch: Partial<
      Pick<
        LocalCloudAsset,
        | "status"
        | "error"
        | "visibility"
        | "spoiler"
        | "mediaId"
        | "id"
        | "code"
        | "url"
        | "fileUrl"
      >
    >,
  ): LocalCloudAsset | null;
  remove(localId: string): void;
  subscribe(cb: () => void): () => void;
};

function readList(key: string): LocalCloudAsset[] {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAssetLike);
  } catch {
    return [];
  }
}

function isAssetLike(value: unknown): value is LocalCloudAsset {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as LocalCloudAsset).localId === "string" &&
    ((value as LocalCloudAsset).kind === "clip" ||
      (value as LocalCloudAsset).kind === "screenshot")
  );
}

function writeList(key: string, list: LocalCloudAsset[]): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(list));
  } catch {
    // Quota / private mode — the in-memory map keeps working.
  }
}

function keyForKind(kind: CloudAssetKind): string {
  return kind === "clip" ? CLIPS_KEY : SHOTS_KEY;
}

/** New registry entry skeleton (upload facts filled in later). */
export function makeLocalAsset(args: {
  kind: CloudAssetKind;
  mediaId: string;
  localPath: string | null;
  startSec?: number | null;
  endSec?: number | null;
  atSec?: number | null;
  title?: string | null;
  spoiler?: boolean;
  visibility?: LocalCloudAsset["visibility"];
  localId: string;
  now?: Date;
}): LocalCloudAsset {
  const now = (args.now ?? new Date()).toISOString();
  return {
    localId: args.localId,
    kind: args.kind,
    mediaId: args.mediaId,
    title: args.title ?? null,
    spoiler: args.spoiler === true,
    visibility: parseVisibility(args.visibility ?? "closed"),
    status: "pending",
    error: null,
    localPath: args.localPath,
    startSec: args.startSec ?? null,
    endSec: args.endSec ?? null,
    atSec: args.atSec ?? null,
    id: null,
    code: null,
    url: null,
    fileUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function createCloudRegistry(): CloudRegistry {
  const listeners = new Set<() => void>();
  const memory = new Map<string, LocalCloudAsset[]>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const load = (kind: CloudAssetKind): LocalCloudAsset[] => {
    const fromDisk = readList(keyForKind(kind));
    if (fromDisk.length > 0) return fromDisk;
    return memory.get(kind) ?? [];
  };
  const save = (kind: CloudAssetKind, list: LocalCloudAsset[]): void => {
    memory.set(kind, list);
    writeList(keyForKind(kind), list);
  };
  return {
    list() {
      return [...load("clip"), ...load("screenshot")];
    },
    listByKind(kind) {
      return [...load(kind)];
    },
    get(localId) {
      for (const asset of this.list()) {
        if (asset.localId === localId) return asset;
      }
      return null;
    },
    upsert(asset) {
      const list = load(asset.kind);
      const index = list.findIndex((item) => item.localId === asset.localId);
      if (index >= 0) list[index] = asset;
      else list.unshift(asset);
      save(asset.kind, list);
      notify();
    },
    patch(localId, patch) {
      for (const kind of ["clip", "screenshot"] as const) {
        const list = load(kind);
        const index = list.findIndex((item) => item.localId === localId);
        if (index < 0) continue;
        const next: LocalCloudAsset = {
          ...list[index],
          ...patch,
          visibility: parseVisibility(
            patch.visibility ?? list[index].visibility,
          ),
          updatedAt: new Date().toISOString(),
        };
        list[index] = next;
        save(kind, list);
        notify();
        return next;
      }
      return null;
    },
    remove(localId) {
      for (const kind of ["clip", "screenshot"] as const) {
        const list = load(kind);
        const next = list.filter((item) => item.localId !== localId);
        if (next.length !== list.length) {
          save(kind, next);
          notify();
        }
      }
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

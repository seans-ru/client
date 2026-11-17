/**
 * Cloud sync for capture (docs/compose/spec/clips-cloud.md).
 *
 * Orchestrates the local registry + the typed API: every exported clip or
 * saved screenshot is registered locally first (status «Ожидает загрузки»)
 * and then uploaded in the background. A missing server / network error
 * never blocks the export — the entry stays pending with a retry button.
 * Visibility and spoiler flags live on the server AND locally.
 */

import {
  clipUploadMeta,
  createCloudRegistry,
  createClipsApi,
  generateShortCode,
  makeLocalAsset,
  screenshotUploadMeta,
  shareUrlForCode,
  toClipsApiError,
  type ClipsApi,
  type ClipsNative,
  type CloudRegistry,
  type ClipVisibility,
  type LocalCloudAsset,
} from "../../clips";
import { getActiveMediaId } from "../../clips/activeMedia";

export const DEFAULT_CLOUD_VISIBILITY: ClipVisibility = "by_link";

export type CloudSync = {
  registry: CloudRegistry;
  /** Register a freshly exported clip and kick off the upload. */
  registerClip(args: {
    localPath: string;
    startSec: number;
    endSec: number;
    title?: string | null;
  }): LocalCloudAsset;
  /** Register a freshly saved screenshot and kick off the upload. */
  registerScreenshot(args: {
    localPath: string;
    atSec: number;
    title?: string | null;
  }): LocalCloudAsset;
  /** Retry one entry («Загрузить»). */
  upload(localId: string): Promise<void>;
  setVisibility(localId: string, visibility: ClipVisibility): Promise<void>;
  setSpoiler(localId: string, spoiler: boolean): Promise<void>;
  /** Copy the share link and open it in the browser. */
  share(localId: string): Promise<void>;
  list(): LocalCloudAsset[];
  subscribe(cb: () => void): () => void;
};

let localSeq = 0;

function nextLocalId(): string {
  localSeq += 1;
  return `local-${Date.now().toString(36)}-${localSeq}`;
}

export function createCloudSync(args: {
  native: ClipsNative;
  api?: ClipsApi;
  registry?: CloudRegistry;
  /** Clipboard + URL helpers are injectable for tests. */
  copyText?: (text: string) => Promise<void>;
  now?: () => Date;
}): CloudSync {
  const registry = args.registry ?? createCloudRegistry();
  const api = args.api ?? createClipsApi({ native: args.native });
  const now = args.now ?? (() => new Date());
  const copyText =
    args.copyText ??
    (async (text: string) => {
      await navigator.clipboard?.writeText(text);
    });

  const upload = async (localId: string): Promise<void> => {
    const asset = registry.get(localId);
    if (!asset) return;
    const mediaId = asset.mediaId || getActiveMediaId() || "";
    if (!mediaId) {
      registry.patch(localId, {
        status: "failed",
        error: "неизвестен фильм (media_id)",
      });
      return;
    }
    if (!asset.localPath) {
      registry.patch(localId, {
        status: "failed",
        error: "нет локального файла",
      });
      return;
    }
    registry.patch(localId, { status: "uploading", error: null });
    try {
      const result =
        asset.kind === "clip"
          ? await api.uploadClip(
              asset.localPath,
              clipUploadMeta({
                mediaId,
                startSec: asset.startSec ?? 0,
                endSec: asset.endSec ?? 0,
                title: asset.title,
                spoiler: asset.spoiler,
                visibility: asset.visibility,
              }),
            )
          : await api.uploadScreenshot(
              asset.localPath,
              screenshotUploadMeta({
                mediaId,
                atSec: asset.atSec ?? 0,
                spoiler: asset.spoiler,
                visibility: asset.visibility,
              }),
            );
      registry.patch(localId, {
        status: "uploaded",
        error: null,
        mediaId,
        id: result.record.id,
        code: result.record.code,
        url: result.record.url,
        fileUrl: result.record.fileUrl,
        visibility: result.record.visibility,
        spoiler: result.record.spoiler,
      });
    } catch (error) {
      const err = toClipsApiError(error, "network");
      registry.patch(localId, {
        status: "failed",
        error: err.message || err.code,
      });
    }
  };

  const register = (
    kind: "clip" | "screenshot",
    parts: {
      localPath: string;
      startSec?: number | null;
      endSec?: number | null;
      atSec?: number | null;
      title?: string | null;
    },
  ): LocalCloudAsset => {
    const asset = makeLocalAsset({
      kind,
      mediaId: getActiveMediaId() ?? "",
      localPath: parts.localPath,
      startSec: parts.startSec ?? null,
      endSec: parts.endSec ?? null,
      atSec: parts.atSec ?? null,
      title: parts.title ?? null,
      spoiler: false,
      visibility: DEFAULT_CLOUD_VISIBILITY,
      localId: nextLocalId(),
      now: now(),
    });
    // Local code for pending rows — the server replaces it on upload.
    registry.upsert({ ...asset, code: generateShortCode() });
    void upload(asset.localId);
    return asset;
  };

  return {
    registry,
    registerClip: (args) =>
      register("clip", {
        localPath: args.localPath,
        startSec: args.startSec,
        endSec: args.endSec,
        title: args.title ?? null,
      }),
    registerScreenshot: (args) =>
      register("screenshot", {
        localPath: args.localPath,
        atSec: args.atSec,
        title: args.title ?? null,
      }),
    upload,
    async setVisibility(localId, visibility) {
      const asset = registry.patch(localId, { visibility });
      if (!asset?.id) return;
      try {
        if (asset.kind === "clip") await api.patchClip(asset.id, { visibility });
        else await api.patchScreenshot(asset.id, { visibility });
      } catch {
        // Local state already updated; the next upload/patch retries.
      }
    },
    async setSpoiler(localId, spoiler) {
      const asset = registry.patch(localId, { spoiler });
      if (!asset?.id) return;
      try {
        if (asset.kind === "clip") await api.patchClip(asset.id, { spoiler });
        else await api.patchScreenshot(asset.id, { spoiler });
      } catch {
        // See above — server converges on the next successful call.
      }
    },
    async share(localId) {
      const asset = registry.get(localId);
      const code = asset?.code;
      if (!code) return;
      const url = shareUrlForCode(code);
      try {
        await copyText(url);
      } catch {
        // Clipboard unavailable — still try to open the page below.
      }
      await args.native.openUrl(url).catch(() => {});
    },
    list: () => registry.list(),
    subscribe: (cb) => registry.subscribe(cb),
  };
}

/**
 * Cloud clips / screenshots contract types (docs/compose/spec/clips-cloud.md).
 *
 * Pure data + parsing only — no fetch/DOM, so every normalize step is
 * unit-testable. The server speaks camelCase JSON (`created_at` arrives as
 * `createdAt` only if the backend says so — we accept BOTH shapes to keep the
 * client tolerant to the issue contract's snake_case).
 */

export type ClipVisibility = "closed" | "by_link" | "open";

export const CLIP_VISIBILITIES: readonly ClipVisibility[] = [
  "closed",
  "by_link",
  "open",
];

export const CLIP_VISIBILITY_LABELS: Record<ClipVisibility, string> = {
  closed: "Закрытый",
  by_link: "По ссылке",
  open: "Открытый",
};

export type CloudAssetKind = "clip" | "screenshot";

/** Upload meta (POST /api/clips|screenshots multipart `meta` JSON part). */
export type CloudUploadMeta = {
  media_id: string;
  spoiler: boolean;
  visibility: ClipVisibility;
  title?: string;
  /** Clip range in seconds. */
  start_sec?: number;
  end_sec?: number;
  /** Screenshot moment in seconds. */
  at_sec?: number;
};

/** Server record (create response + list + GET /api/c/{code}). */
export type CloudAssetRecord = {
  id: string;
  code: string;
  /** Share page: https://seans.tedeshi.ru/c/<code>. */
  url: string;
  visibility: ClipVisibility;
  spoiler: boolean;
  createdAt: string;
  mediaId: string;
  startSec: number | null;
  endSec: number | null;
  atSec: number | null;
  title: string | null;
  /** Direct media URL for playback (see the contract doc). */
  fileUrl: string | null;
};

/** Local registry entry — exists before the server knows about the file. */
export type LocalCloudAsset = {
  /** Local id (uuid-ish) — stable while the entry is pending. */
  localId: string;
  kind: CloudAssetKind;
  mediaId: string;
  title: string | null;
  spoiler: boolean;
  visibility: ClipVisibility;
  status: "pending" | "uploading" | "uploaded" | "failed";
  error: string | null;
  /** Source facts (local file + range). */
  localPath: string | null;
  startSec: number | null;
  endSec: number | null;
  atSec: number | null;
  /** Server facts (filled after a successful upload). */
  id: string | null;
  code: string | null;
  url: string | null;
  fileUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseVisibility(raw: unknown): ClipVisibility {
  return raw === "by_link" || raw === "open" ? raw : "closed";
}

export function isCloudAssetKind(raw: unknown): raw is CloudAssetKind {
  return raw === "clip" || raw === "screenshot";
}

/** Accept both camelCase and the snake_case of the issue contract. */
function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

/**
 * Normalize a create/list/public payload. Missing fields degrade to safe
 * defaults — a malformed row never throws in the UI layer.
 */
export function parseCloudAssetRecord(raw: unknown): CloudAssetRecord | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const code = asString(pick(r, "code"));
  const id = asString(pick(r, "id", "_id"));
  if (!code && !id) return null;
  const safeCode = code ?? "local";
  return {
    id: id ?? safeCode,
    code: safeCode,
    url:
      asString(pick(r, "url")) ??
      `https://seans.tedeshi.ru/c/${safeCode}`,
    visibility: parseVisibility(pick(r, "visibility")),
    spoiler: asBool(pick(r, "spoiler")),
    createdAt:
      asString(pick(r, "createdAt", "created_at")) ??
      new Date(0).toISOString(),
    mediaId: asString(pick(r, "mediaId", "media_id")) ?? "",
    startSec: asNumber(pick(r, "startSec", "start_sec")),
    endSec: asNumber(pick(r, "endSec", "end_sec")),
    atSec: asNumber(pick(r, "atSec", "at_sec")),
    title: asString(pick(r, "title")),
    fileUrl: asString(pick(r, "fileUrl", "file_url")),
  };
}

/** `{items: [...]}` or a bare array. */
export function parseCloudAssetList(raw: unknown): CloudAssetRecord[] {
  const bag = Array.isArray(raw)
    ? raw
    : raw != null && typeof raw === "object"
      ? ((raw as Record<string, unknown>).items ??
        (raw as Record<string, unknown>).clips ??
        (raw as Record<string, unknown>).screenshots ??
        [])
      : [];
  if (!Array.isArray(bag)) return [];
  const out: CloudAssetRecord[] = [];
  for (const item of bag) {
    const parsed = parseCloudAssetRecord(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Build the multipart `meta` JSON part for a clip export. */
export function clipUploadMeta(args: {
  mediaId: string;
  startSec: number;
  endSec: number;
  title?: string | null;
  spoiler: boolean;
  visibility: ClipVisibility;
}): CloudUploadMeta {
  const meta: CloudUploadMeta = {
    media_id: args.mediaId,
    start_sec: args.startSec,
    end_sec: args.endSec,
    spoiler: args.spoiler,
    visibility: parseVisibility(args.visibility),
  };
  const title = args.title?.trim();
  if (title) meta.title = title;
  return meta;
}

/** Build the multipart `meta` JSON part for a screenshot. */
export function screenshotUploadMeta(args: {
  mediaId: string;
  atSec: number;
  spoiler: boolean;
  visibility: ClipVisibility;
}): CloudUploadMeta {
  return {
    media_id: args.mediaId,
    at_sec: args.atSec,
    spoiler: args.spoiler,
    visibility: parseVisibility(args.visibility),
  };
}

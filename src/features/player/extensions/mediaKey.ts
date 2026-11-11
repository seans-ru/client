/**
 * Per-file identity for extension settings (issues #9 / #10 / #15).
 *
 * `OpenInfo` carries only the opened URL, so the key is derived from it:
 * the query string is stripped (presigned signatures rotate per fetch) and
 * the object path stays stable for VOD sources. The progressive loopback
 * range server (`http://127.0.0.1:<port>/`) carries no identity at all —
 * there the key falls back to a content signature (resolution + duration +
 * track list) computed from the player snapshot once the file is loaded.
 *
 * Known limitation (documented in the PR): two progressive files with the
 * same resolution, rounded duration and track list share a key. Extending
 * `OpenInfo` with the media/file id (needs the porting-branch contract) would
 * make the key exact — out of scope for this milestone.
 */

export const PROGRESSIVE_MEDIA_KEY = "progressive";

/** FNV-1a 32-bit — small stable hash for track signatures. */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

/**
 * URL-derived media key. Query/hash are dropped (presigned signatures);
 * VOD object paths stay stable across fetches.
 */
export function mediaKeyFromUrl(url: string): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "unknown";
  const noHash = raw.split("#")[0] ?? "";
  const noQuery = noHash.split("?")[0] ?? "";
  try {
    const parsed = new URL(noQuery);
    const host = parsed.host.toLowerCase();
    // `hostname` excludes the port — loopback detection must not see it.
    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "");
    if (isLoopbackHost(hostname) && (path === "" || path === "/")) {
      return PROGRESSIVE_MEDIA_KEY;
    }
    return `${host}${path}` || "unknown";
  } catch {
    return noQuery || "unknown";
  }
}

export type SnapshotSignature = {
  duration?: number | null;
  video_w?: number | null;
  video_h?: number | null;
  tracks?: readonly { kind?: string | null; lang?: string | null; title?: string | null }[];
};

/**
 * Media key for per-file settings. VOD keys come from the URL path; the
 * progressive loopback URL has no identity, so the key is upgraded to a
 * content signature once the snapshot knows the file's shape.
 */
export function mediaKeyFromSnapshot(
  url: string,
  snapshot: SnapshotSignature,
): string {
  const base = mediaKeyFromUrl(url);
  if (base !== PROGRESSIVE_MEDIA_KEY) return base;
  const duration = Math.round(snapshot.duration ?? 0);
  const width = Math.trunc(snapshot.video_w ?? 0);
  const height = Math.trunc(snapshot.video_h ?? 0);
  const trackSig = (snapshot.tracks ?? [])
    .map((t) => `${String(t.kind ?? "")}:${String(t.lang ?? "")}:${String(t.title ?? "")}`)
    .join("|");
  return `${PROGRESSIVE_MEDIA_KEY}:${width}x${height}:${duration}:${hashString(trackSig)}`;
}

/**
 * True when the URL-derived key is the progressive placeholder and a
 * snapshot signature is required before settings can be restored.
 */
export function needsSnapshotKey(url: string): boolean {
  return mediaKeyFromUrl(url) === PROGRESSIVE_MEDIA_KEY;
}

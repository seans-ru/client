/**
 * Active media bridge: the capture / best-moments extensions live inside the
 * player runtime and do not receive `mediaId` through the frozen extension
 * contract. PlayerScreen publishes the resolved id here; the cloud layer
 * reads it at export/upload time. Tiny store — no React.
 */

let activeMediaId: string | null = null;

const listeners = new Set<() => void>();

export function setActiveMediaId(mediaId: string | number | null): void {
  const next = mediaId == null ? null : String(mediaId);
  if (next === activeMediaId) return;
  activeMediaId = next;
  for (const listener of [...listeners]) listener();
}

export function getActiveMediaId(): string | null {
  return activeMediaId;
}

export function subscribeActiveMedia(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

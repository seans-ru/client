/**
 * Lightweight HTTP tracing for debugging.
 *
 * Tauri runs real HTTP through `tauri-plugin-http` (Rust side), so browser
 * Network tab only shows `ipc.localhost/*` invoke bridges. This logger prints
 * outbound requests with timing to the console instead.
 *
 * Enable: `localStorage.setItem("seans.debug.http", "1")` in DevTools Console,
 * then reload. Disable: `localStorage.removeItem("seans.debug.http")`.
 */

const STORAGE_KEY = "seans.debug.http";

let cached: boolean | null = null;

function enabled(): boolean {
  if (cached != null) return cached;
  try {
    cached = window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    cached = false;
  }
  return cached;
}

/** Allow live toggle from the console without a reload. */
export function setHttpDebug(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  cached = on;
}

export function logHttpStart(
  method: string,
  url: string,
): (status?: number, error?: unknown) => void {
  if (!enabled()) return () => {};
  const t0 = performance.now();
  const label = `${method} ${url}`;
  return (status?: number, error?: unknown) => {
    const ms = Math.round(performance.now() - t0);
    if (error != null) {
      console.warn(`[http] ${label} → ERROR (${ms}ms)`, error);
    } else {
      console.log(`[http] ${label} → ${status ?? "?"} (${ms}ms)`);
    }
  };
}

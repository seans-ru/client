/**
 * Lightweight HTTP tracing for debugging.
 *
 * Tauri runs real HTTP through `tauri-plugin-http` (Rust side), so browser
 * Network tab only shows `ipc.localhost/*` invoke bridges. This logger prints
 * outbound requests with timing to the console instead, and feeds the in-app
 * request log (`lib/httpLog`) behind the diagnostics panel.
 *
 * Console output: `localStorage.setItem("seans.debug.http", "1")` in DevTools
 * Console, then reload. Disable: `localStorage.removeItem("seans.debug.http")`.
 */

import { httpLog, type HttpLogKind } from "./httpLog";

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

export type HttpTraceMeta = {
  kind?: HttpLogKind;
  reqHeaders?: Record<string, string>;
  reqBody?: string | null;
};

export type HttpTraceResult = {
  headers?: Record<string, string> | null;
  body?: string | null;
};

export function logHttpStart(
  method: string,
  url: string,
  meta: HttpTraceMeta = {},
): (
  status?: number,
  error?: unknown,
  res?: HttpTraceResult,
) => void {
  const consoleOn = enabled();
  const t0 = performance.now();
  const label = `${method} ${url}`;
  const finishRecord = httpLog.begin({
    method,
    url,
    kind: meta.kind,
    reqHeaders: meta.reqHeaders,
    reqBody: meta.reqBody,
  });
  return (status?: number, error?: unknown, res?: HttpTraceResult) => {
    finishRecord({
      status,
      error,
      resHeaders: res?.headers ?? null,
      resBody: res?.body ?? null,
    });
    if (!consoleOn) return;
    const ms = Math.round(performance.now() - t0);
    if (error != null) {
      console.warn(`[http] ${label} -> ERROR (${ms}ms)`, error);
    } else {
      console.log(`[http] ${label} -> ${status ?? "?"} (${ms}ms)`);
    }
  };
}

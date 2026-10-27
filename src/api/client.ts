/**
 * Typed Seans API client (M2).
 *
 * Base URL: https://api.seans.tedeshi.ru (override: import.meta.env.VITE_API_BASE_URL)
 * Auth: Authorization: Bearer <JWT> — token comes from Credential Manager via
 * src/api/session.ts and is never persisted from JS.
 *
 * On HTTP 401 the session is cleared from memory and `seans:auth-required` is
 * emitted on window so the auth layer can drop to the login screen.
 *
 * Do not add worker/torrent-worker endpoints here: this client never calls them.
 */

import { getSessionToken, setSessionToken } from "./session";
import { logHttpStart } from "../lib/httpTrace";

const DEFAULT_API_BASE_URL = "https://api.seans.tedeshi.ru";

const envBase = import.meta.env.VITE_API_BASE_URL;

export const API_BASE_URL: string = (
  typeof envBase === "string" && envBase.length > 0
    ? envBase
    : DEFAULT_API_BASE_URL
).replace(/\/+$/, "");

/**
 * Fetch that goes through `tauri-plugin-http` inside the desktop shell (no CORS)
 * and falls back to window.fetch in plain browser / vitest.
 */
async function apiFetch(
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (isTauri()) {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      return (await tauriFetch(input, init)) as unknown as Response;
    }
  } catch {
    // Plugin unavailable (vitest / plain vite) — fall through.
  }
  return fetch(input, init);
}

export type ApiErrorShape = {
  status: number;
  message: string;
};

export class ApiError extends Error implements ApiErrorShape {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** True when the response status means the JWT is missing/expired/invalid. */
export function isUnauthorizedStatus(status: number): boolean {
  return status === 401;
}

/** Absolute URL for an API path (with optional query params). */
export function apiUrl(
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  const base = `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `${base}?${qs}` : base;
}

/** Event name emitted on window when the API rejects the current JWT. */
export const AUTH_REQUIRED_EVENT = "seans:auth-required";

/** Clear the in-memory session and notify the app (pure side-effect helper). */
export function handleUnauthorized(): void {
  setSessionToken(null);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
  }
}

export type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON request body; omitted for GET/DELETE without payload. */
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
};

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (text.length === 0) return res.statusText || "Ошибка API";
    try {
      const data = JSON.parse(text) as {
        message?: unknown;
        error?: unknown;
        detail?: unknown;
      };
      // FastAPI envelope: {"detail": "..."} or 422 {"detail": [{msg, ...}]}
      if (typeof data.detail === "string" && data.detail.length > 0) {
        return data.detail;
      }
      if (Array.isArray(data.detail) && data.detail.length > 0) {
        const first = data.detail[0] as { msg?: unknown; detail?: unknown };
        if (typeof first.msg === "string" && first.msg.length > 0) {
          return first.msg;
        }
        if (typeof first.detail === "string" && first.detail.length > 0) {
          return first.detail;
        }
      }
      if (typeof data.message === "string" && data.message.length > 0) {
        return data.message;
      }
      if (typeof data.error === "string" && data.error.length > 0) {
        return data.error;
      }
    } catch {
      // Non-JSON error body — fall through to raw text.
    }
    return text;
  } catch {
    return res.statusText || "Ошибка API";
  }
}

/**
 * JSON request helper. Adds `Authorization: Bearer <JWT>` when a session token
 * is present. Throws `ApiError` on non-2xx (401 also clears the session).
 */
export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const token = getSessionToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  const method = options.method ?? "GET";
  const fullUrl = apiUrl(path, options.query);
  const traceDone = logHttpStart(method, fullUrl);
  try {
    res = await apiFetch(fullUrl, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    traceDone(res.status);
  } catch (cause) {
    traceDone(undefined, cause);
    const message = cause instanceof Error ? cause.message : "Сеть недоступна";
    throw new ApiError(0, message);
  }

  if (isUnauthorizedStatus(res.status)) {
    handleUnauthorized();
    throw new ApiError(res.status, await readErrorMessage(res));
  }

  if (!res.ok) {
    throw new ApiError(res.status, await readErrorMessage(res));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (text.length === 0) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

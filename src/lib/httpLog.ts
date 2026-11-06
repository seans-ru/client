/**
 * In-app HTTP request log (issue #58).
 *
 * The desktop shell runs API traffic through `tauri-plugin-http`, so the
 * browser Network tab only shows ipc bridges. This module records every
 * request/response pair in memory (ring buffer) for the diagnostics panel.
 * Secrets are masked at record time; nothing is persisted.
 */

export type HttpLogKind = "api" | "external" | "stream";

export type HttpLogEntry = {
  id: number;
  /** Epoch ms. */
  startedAt: number;
  method: string;
  url: string;
  kind: HttpLogKind;
  /** `null` while in flight or when the request never reached a response. */
  status: number | null;
  ok: boolean;
  /** `null` while in flight. */
  durationMs: number | null;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  resHeaders: Record<string, string> | null;
  resBody: string | null;
  resBodyTruncated: boolean;
  /** Network error / abort message. */
  error: string | null;
};

export type HttpRecordInput = {
  method: string;
  url: string;
  kind?: HttpLogKind;
  reqHeaders?: Record<string, string>;
  reqBody?: string | null;
};

export type HttpRecordOutcome = {
  status?: number;
  error?: unknown;
  resHeaders?: Record<string, string> | null;
  resBody?: string | null;
};

export type HttpLog = {
  /** Start recording one request; call the returned finisher exactly once. */
  begin(input: HttpRecordInput): (outcome?: HttpRecordOutcome) => void;
  /** Newest first. The array identity is stable between notifications. */
  getEntries(): readonly HttpLogEntry[];
  subscribe(cb: () => void): () => void;
  clear(): void;
};

/** Entries kept in memory; the oldest are dropped past this. */
export const MAX_ENTRIES = 200;
/** Per-body capture limit (characters); the rest is truncated. */
export const MAX_BODY_CHARS = 65_536;

const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api[-_]?key|token)$/i;
const SENSITIVE_JSON_KEY =
  /(password|token|secret|invite[-_]?key|api[-_]?key|authorization)/i;

/** `Bearer eyJ...` -> `Bearer •••`; opaque secrets -> `•••`. */
export function maskHeaderValue(key: string, value: string): string {
  if (!SENSITIVE_HEADER.test(key)) return value;
  const match = /^(\S+)\s+\S/.exec(value);
  return match ? `${match[1]} •••` : "•••";
}

export function maskHeaders(
  headers: Record<string, string> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = maskHeaderValue(key, String(value));
  }
  return out;
}

/**
 * Flatten a response header bag (`Headers`, plain object, or the plugin's
 * approximation) into a string map for the record.
 */
export function headerBagToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const bag = headers as
    | { forEach?: (cb: (value: string, key: string) => void) => void }
    | Record<string, unknown>
    | null
    | undefined;
  if (!bag) return out;
  if (typeof (bag as { forEach?: unknown }).forEach === "function") {
    (bag as { forEach: (cb: (value: string, key: string) => void) => void }).forEach(
      (value, key) => {
        out[key] = value;
      },
    );
    return out;
  }
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.join(", ");
  }
  return out;
}

/** Replace sensitive string values in parsed JSON (recursion-capped). */
function scrubJson(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        SENSITIVE_JSON_KEY.test(key) && typeof item === "string"
          ? "•••"
          : scrubJson(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Scrub secret-looking JSON fields. Non-JSON bodies pass through unchanged
 * (callers already truncate to `MAX_BODY_CHARS`).
 */
export function scrubBody(body: string | null | undefined): string | null {
  if (body == null || body.length === 0) return null;
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    return JSON.stringify(scrubJson(JSON.parse(body)));
  } catch {
    return body;
  }
}

function truncateBody(body: string | null): {
  body: string | null;
  truncated: boolean;
} {
  if (body == null) return { body: null, truncated: false };
  if (body.length <= MAX_BODY_CHARS) return { body, truncated: false };
  return { body: body.slice(0, MAX_BODY_CHARS), truncated: true };
}

function headersToRecord(
  headers: Record<string, string> | undefined | null,
): Record<string, string> {
  return maskHeaders(headers);
}

export function createHttpLog(): HttpLog {
  let entries: HttpLogEntry[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    begin(input) {
      const id = nextId++;
      const startedAt = Date.now();
      const scrubbedReq = truncateBody(scrubBody(input.reqBody));
      const entry: HttpLogEntry = {
        id,
        startedAt,
        method: input.method,
        url: input.url,
        kind: input.kind ?? "api",
        status: null,
        ok: false,
        durationMs: null,
        reqHeaders: headersToRecord(input.reqHeaders),
        reqBody: scrubbedReq.body,
        resHeaders: null,
        resBody: null,
        resBodyTruncated: false,
        error: null,
      };
      // Newest first so the panel needs no scroll management.
      entries = [entry, ...entries].slice(0, MAX_ENTRIES);
      notify();

      let finished = false;
      return (outcome = {}) => {
        if (finished) return;
        finished = true;
        const scrubbedRes = truncateBody(scrubBody(outcome.resBody));
        const next: HttpLogEntry = {
          ...entry,
          status: outcome.status ?? null,
          ok:
            outcome.error == null &&
            typeof outcome.status === "number" &&
            outcome.status > 0 &&
            outcome.status < 400,
          durationMs: Date.now() - startedAt,
          resHeaders:
            outcome.resHeaders == null ? null : headersToRecord(outcome.resHeaders),
          resBody: scrubbedRes.body,
          resBodyTruncated: scrubbedRes.truncated,
          error:
            outcome.error == null
              ? null
              : outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error),
        };
        entries = entries.map((item) => (item.id === id ? next : item));
        notify();
      };
    },
    getEntries: () => entries,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    clear() {
      entries = [];
      notify();
    },
  };
}

/** App-wide recorder feeding the diagnostics panel. */
export const httpLog: HttpLog = createHttpLog();

/**
 * Typed cloud API client (docs/compose/spec/clips-cloud.md).
 *
 * JSON endpoints go through `tauri-plugin-http` inside the desktop shell
 * (same pattern as src/api/client.ts) and fall back to `fetch` in tests.
 * File uploads run through the `capture_upload_file` Rust command — the file
 * bytes never cross the webview IPC boundary, the multipart body is built
 * next to the disk file (see src-tauri/src/capture.rs).
 *
 * Graceful degradation is the caller's job: every rejection is a structured
 * `ClipsApiError` (`status` + `code` + `message`), never a crash.
 */

import { getSessionToken } from "../../api/session";
import {
  parseCloudAssetList,
  parseCloudAssetRecord,
  parseVisibility,
  type CloudAssetRecord,
  type CloudUploadMeta,
  type ClipVisibility,
} from "./types";

export type ClipsApiError = {
  code:
    | "network"
    | "unauthorized"
    | "forbidden"
    | "not-found"
    | "too-large"
    | "http"
    | "no-tauri"
    | "bad-response";
  status: number;
  message: string;
};

export function toClipsApiError(
  error: unknown,
  fallback: ClipsApiError["code"] = "network",
): ClipsApiError {
  if (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    "status" in error &&
    "message" in error
  ) {
    return error as ClipsApiError;
  }
  return {
    code: fallback,
    status: 0,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function errorFromStatus(status: number, message: string): ClipsApiError {
  const code: ClipsApiError["code"] =
    status === 401
      ? "unauthorized"
      : status === 403
        ? "forbidden"
        : status === 404
          ? "not-found"
          : status === 413
            ? "too-large"
            : "http";
  return { code, status, message };
}

const DEFAULT_BASE = "https://api.seans.tedeshi.ru";

/** Response of POST /api/clips|screenshots and GET /api/c/{code}. */
export type UploadResult = {
  record: CloudAssetRecord;
};

export type UploadFileArgs = {
  url: string;
  filePath: string;
  /** Multipart field name for the file part (`file`). */
  fieldName: string;
  /** JSON string of `CloudUploadMeta` (multipart text part `meta`). */
  metaJson: string;
  authHeader: string | null;
};

export type UploadFileResult = {
  status: number;
  body: string;
};

/** Native side of the cloud layer (Rust `capture_*` commands). */
export type ClipsNative = {
  uploadFile(args: UploadFileArgs): Promise<UploadFileResult>;
  openUrl(url: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
};

export type ClipsApiDeps = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  native?: ClipsNative;
  getToken?: () => string | null;
};

export type ClipsApi = {
  /** POST /api/clips — multipart `file` + `meta`. */
  uploadClip(filePath: string, meta: CloudUploadMeta): Promise<UploadResult>;
  /** POST /api/screenshots — multipart `file` + `meta`. */
  uploadScreenshot(
    filePath: string,
    meta: CloudUploadMeta,
  ): Promise<UploadResult>;
  /** PATCH /api/clips/{id} — visibility / spoiler. */
  patchClip(
    id: string,
    patch: { visibility?: ClipVisibility; spoiler?: boolean },
  ): Promise<void>;
  patchScreenshot(
    id: string,
    patch: { visibility?: ClipVisibility; spoiler?: boolean },
  ): Promise<void>;
  /** GET /api/clips?media_id=… */
  listClips(mediaId: string): Promise<CloudAssetRecord[]>;
  /** GET /api/c/{code} — public access honouring visibility. */
  getByCode(code: string): Promise<CloudAssetRecord | null>;
  deleteClip(id: string): Promise<void>;
  deleteScreenshot(id: string): Promise<void>;
};

function authHeader(getToken: () => string | null): string | null {
  const token = getToken();
  return token ? `Bearer ${token}` : null;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed != null && typeof parsed === "object") {
        const bag = parsed as Record<string, unknown>;
        const message = bag.message ?? bag.error ?? bag.detail;
        if (typeof message === "string" && message) return message;
      }
    } catch {
      // Not JSON — the body text is the best message we have.
    }
    return text.slice(0, 200);
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function createClipsApi(deps: ClipsApiDeps = {}): ClipsApi {
  const base = (deps.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const getToken = deps.getToken ?? getSessionToken;

  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const doFetch = deps.fetchImpl ?? globalThis.fetch;
    const headers = new Headers(init.headers ?? {});
    const auth = authHeader(getToken);
    if (auth) headers.set("Authorization", auth);
    if (init.body && !(init.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    try {
      return await doFetch(`${base}${path}`, { ...init, headers });
    } catch (error) {
      throw toClipsApiError(error, "network");
    }
  };

  const expectOk = async (response: Response): Promise<void> => {
    if (response.ok) return;
    throw errorFromStatus(response.status, await readErrorMessage(response));
  };

  const upload = async (
    path: "clips" | "screenshots",
    filePath: string,
    meta: CloudUploadMeta,
  ): Promise<UploadResult> => {
    const native = deps.native;
    if (!native) throw { code: "no-tauri", status: 0, message: "нет нативного моста" } satisfies ClipsApiError;
    const auth = authHeader(getToken);
    const result = await native
      .uploadFile({
        url: `${base}/api/${path}`,
        filePath,
        fieldName: "file",
        metaJson: JSON.stringify(meta),
        authHeader: auth,
      })
      .catch((error: unknown) => {
        throw toClipsApiError(error, "network");
      });
    const record = parseCloudAssetRecord(
      (() => {
        try {
          return JSON.parse(result.body) as unknown;
        } catch {
          return null;
        }
      })(),
    );
    if (result.status >= 200 && result.status < 300 && record) {
      return { record };
    }
    throw errorFromStatus(
      result.status,
      record ? `HTTP ${result.status}` : (result.body.slice(0, 200) || `HTTP ${result.status}`),
    );
  };

  const patch = async (
    path: string,
    body: { visibility?: ClipVisibility; spoiler?: boolean },
  ): Promise<void> => {
    const payload: Record<string, unknown> = {};
    if (body.visibility !== undefined) {
      payload.visibility = parseVisibility(body.visibility);
    }
    if (body.spoiler !== undefined) payload.spoiler = body.spoiler === true;
    const response = await request(path, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    await expectOk(response);
  };

  return {
    uploadClip: (filePath, meta) => upload("clips", filePath, meta),
    uploadScreenshot: (filePath, meta) => upload("screenshots", filePath, meta),
    patchClip: (id, body) => patch(`/api/clips/${encodeURIComponent(id)}`, body),
    patchScreenshot: (id, body) =>
      patch(`/api/screenshots/${encodeURIComponent(id)}`, body),

    async listClips(mediaId) {
      const response = await request(
        `/api/clips?media_id=${encodeURIComponent(mediaId)}`,
      );
      if (!response.ok) {
        throw errorFromStatus(response.status, await readErrorMessage(response));
      }
      const text = await response.text().catch(() => "");
      return parseCloudAssetList(
        (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return null;
          }
        })(),
      );
    },

    async getByCode(code) {
      const response = await request(`/api/c/${encodeURIComponent(code)}`);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw errorFromStatus(response.status, await readErrorMessage(response));
      }
      const text = await response.text().catch(() => "");
      return parseCloudAssetRecord(
        (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return null;
          }
        })(),
      );
    },

    async deleteClip(id) {
      await expectOk(
        await request(`/api/clips/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
      );
    },
    async deleteScreenshot(id) {
      await expectOk(
        await request(`/api/screenshots/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
      );
    },
  };
}

/** Default desktop instance (Rust bridge is injected by the capture layer). */
export type { CloudAssetRecord, CloudUploadMeta };

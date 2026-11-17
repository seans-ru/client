import { describe, expect, it, vi } from "vitest";
import {
  createClipsApi,
  errorFromStatus,
  toClipsApiError,
  type ClipsNative,
  type UploadFileArgs,
  type UploadFileResult,
} from "../src/features/clips/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeNative(overrides: Partial<ClipsNative> = {}) {
  const uploads: UploadFileArgs[] = [];
  const opened: string[] = [];
  const native: ClipsNative = {
    async uploadFile(args): Promise<UploadFileResult> {
      uploads.push(args);
      return {
        status: 201,
        body: JSON.stringify({
          id: "cl_1",
          code: "abcd1234",
          url: "https://seans.tedeshi.ru/c/abcd1234",
          visibility: "by_link",
          spoiler: false,
          created_at: "2026-01-01T00:00:00Z",
          media_id: "m1",
          start_sec: 1,
          end_sec: 2,
          file_url: "https://cdn/1.mp4",
        }),
      };
    },
    async openUrl(url) {
      opened.push(url);
    },
    async fileExists() {
      return true;
    },
    ...overrides,
  };
  return { native, uploads, opened };
}

describe("error helpers", () => {
  it("maps status codes to stable client codes", () => {
    expect(errorFromStatus(401, "x").code).toBe("unauthorized");
    expect(errorFromStatus(403, "x").code).toBe("forbidden");
    expect(errorFromStatus(404, "x").code).toBe("not-found");
    expect(errorFromStatus(413, "x").code).toBe("too-large");
    expect(errorFromStatus(500, "x").code).toBe("http");
  });

  it("passes structured errors through and wraps the rest", () => {
    const structured = { code: "http", status: 502, message: "bad" };
    expect(toClipsApiError(structured)).toBe(structured);
    const wrapped = toClipsApiError(new Error("boom"), "network");
    expect(wrapped).toEqual({ code: "network", status: 0, message: "boom" });
    expect(toClipsApiError("plain", "no-tauri").code).toBe("no-tauri");
  });
});

describe("createClipsApi uploads", () => {
  it("uploads a clip through the native bridge and parses the record", async () => {
    const { native, uploads } = makeNative();
    const api = createClipsApi({
      native,
      getToken: () => "token-1",
    });
    const result = await api.uploadClip("C:/clip.mp4", {
      media_id: "m1",
      start_sec: 1,
      end_sec: 2,
      spoiler: false,
      visibility: "by_link",
    });
    expect(result.record.code).toBe("abcd1234");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toBe("https://api.seans.tedeshi.ru/api/clips");
    expect(uploads[0].filePath).toBe("C:/clip.mp4");
    expect(uploads[0].authHeader).toBe("Bearer token-1");
    expect(uploads[0].metaJson).toContain('"media_id":"m1"');
  });

  it("uploads screenshots to the screenshots endpoint", async () => {
    const { native, uploads } = makeNative();
    const api = createClipsApi({ native, getToken: () => null });
    await api.uploadScreenshot("C:/s.png", {
      media_id: "m1",
      at_sec: 3,
      spoiler: true,
      visibility: "closed",
    });
    expect(uploads[0].url).toBe(
      "https://api.seans.tedeshi.ru/api/screenshots",
    );
    expect(uploads[0].authHeader).toBeNull();
    expect(uploads[0].metaJson).toContain('"spoiler":true');
  });

  it("surfaces non-2xx upload statuses as typed errors", async () => {
    const { native } = makeNative({
      uploadFile: async () => ({ status: 413, body: "too large" }),
    });
    const api = createClipsApi({ native, getToken: () => null });
    await expect(
      api.uploadClip("C:/big.mp4", {
        media_id: "m",
        start_sec: 0,
        end_sec: 1,
        spoiler: false,
        visibility: "closed",
      }),
    ).rejects.toMatchObject({ code: "too-large", status: 413 });
  });

  it("rejects uploads without a native bridge", async () => {
    const api = createClipsApi({ getToken: () => null });
    await expect(
      api.uploadClip("C:/x.mp4", {
        media_id: "m",
        start_sec: 0,
        end_sec: 1,
        spoiler: false,
        visibility: "closed",
      }),
    ).rejects.toMatchObject({ code: "no-tauri" });
  });
});

describe("createClipsApi json endpoints", () => {
  function apiWithFetch(handler: (url: string, init?: RequestInit) => Response) {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init),
    );
    const { native } = makeNative();
    return {
      api: createClipsApi({
        native,
        fetchImpl: mockFetch as unknown as typeof fetch,
        getToken: () => "tok",
      }),
      mockFetch,
    };
  }

  it("lists clips with the media filter and sends the bearer token", async () => {
    const { api, mockFetch } = apiWithFetch((url) => {
      expect(url).toContain("/api/clips?media_id=m%2F1");
      return jsonResponse(200, {
        items: [
          { id: "1", code: "abcd1234", media_id: "m/1", visibility: "open" },
        ],
      });
    });
    const list = await api.listClips("m/1");
    expect(list).toHaveLength(1);
    const [, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("maps 404 on GET /api/c/{code} to null", async () => {
    const { api } = apiWithFetch(() => jsonResponse(404, { message: "no" }));
    expect(await api.getByCode("abcd1234")).toBeNull();
  });

  it("parses GET /api/c/{code} records", async () => {
    const { api } = apiWithFetch(() =>
      jsonResponse(200, {
        id: "cl_2",
        code: "abcd1234",
        visibility: "by_link",
        file_url: "https://cdn/2.mp4",
      }),
    );
    const record = await api.getByCode("abcd1234");
    expect(record?.fileUrl).toBe("https://cdn/2.mp4");
  });

  it("patches visibility and spoiler", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const { api } = apiWithFetch((url, init) => {
      calls.push([url, init]);
      return jsonResponse(200, {});
    });
    await api.patchClip("cl_1", { visibility: "open", spoiler: true });
    expect(calls[0][0]).toContain("/api/clips/cl_1");
    expect(calls[0][1]?.method).toBe("PATCH");
    expect(String(calls[0][1]?.body)).toBe(
      JSON.stringify({ visibility: "open", spoiler: true }),
    );
    await api.patchScreenshot("sh_1", { spoiler: false });
    expect(calls[1][0]).toContain("/api/screenshots/sh_1");
  });

  it("deletes clips and screenshots", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const { api } = apiWithFetch((url, init) => {
      calls.push([url, init]);
      return new Response(null, { status: 204 });
    });
    await api.deleteClip("cl_1");
    await api.deleteScreenshot("sh_1");
    expect(calls.map(([u]) => u)).toEqual([
      "https://api.seans.tedeshi.ru/api/clips/cl_1",
      "https://api.seans.tedeshi.ru/api/screenshots/sh_1",
    ]);
    expect(calls[0][1]?.method).toBe("DELETE");
  });

  it("wraps network failures as code=network", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const { native } = makeNative();
    const api = createClipsApi({ native, fetchImpl, getToken: () => null });
    await expect(api.listClips("m")).rejects.toMatchObject({
      code: "network",
    });
  });

  it("reads the error message from JSON bodies", async () => {
    const { api } = apiWithFetch(() =>
      jsonResponse(403, { message: "чужой ресурс" }),
    );
    await expect(api.deleteClip("x")).rejects.toMatchObject({
      code: "forbidden",
      message: "чужой ресурс",
    });
  });
});

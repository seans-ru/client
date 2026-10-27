import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiUrl,
  handleUnauthorized,
  isApiError,
  isUnauthorizedStatus,
  request,
} from "../src/api/client";
import {
  normalizeHistory,
  normalizeHistoryList,
  normalizeLibraryItem,
  normalizeLibraryList,
  normalizeMediaDetail,
  normalizeMediaSearchResult,
  normalizeRoomCreate,
  normalizeRoomDetail,
  normalizeRoomMember,
  normalizeTask,
  normalizeToken,
  normalizeTorrentRelease,
  normalizeUser,
  toNumber,
} from "../src/api/parsing";
import {
  getSessionToken,
  setSessionToken,
} from "../src/api/session";

describe("toNumber", () => {
  it("passes through finite numbers", () => {
    expect(toNumber(0)).toBe(0);
    expect(toNumber(42)).toBe(42);
    expect(toNumber(3.14)).toBe(3.14);
    expect(toNumber(-7)).toBe(-7);
  });

  it("coerces numeric strings (rating_kp, position_sec, size_bytes, …)", () => {
    expect(toNumber("42")).toBe(42);
    expect(toNumber("3.5")).toBe(3.5);
    expect(toNumber(" 128 ")).toBe(128);
    expect(toNumber("-1")).toBe(-1);
  });

  it("returns null for empty / non-numeric / non-finite input", () => {
    expect(toNumber("")).toBeNull();
    expect(toNumber("   ")).toBeNull();
    expect(toNumber("abc")).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber(true)).toBeNull();
    expect(toNumber({})).toBeNull();
  });
});

describe("response shape normalization", () => {
  it("normalizes TokenResponse with nested user", () => {
    const token = normalizeToken({
      access_token: "jwt",
      token_type: "bearer",
      user: {
        id: 7,
        email: "a@b.c",
        display_name: "Анна",
        can_invite: true,
        quota_bytes: "1024",
        created_at: "2026-01-01T00:00:00Z",
      },
    });
    expect(token.access_token).toBe("jwt");
    expect(token.token_type).toBe("bearer");
    expect(token.user.display_name).toBe("Анна");
    expect(token.user.quota_bytes).toBe(1024);
  });

  it("coerces rating_kp numeric strings in MediaSearchResult", () => {
    const media = normalizeMediaSearchResult({
      id: "m1",
      kp_id: 301,
      title: "Фильм",
      year: "2024",
      poster_url: null,
      kp_type: "film",
      rating_kp: "7.4",
    });
    expect(media.year).toBe(2024);
    expect(media.rating_kp).toBe(7.4);
    expect(media.poster_url).toBeNull();
  });

  it("keeps rating_kp null when absent and supports it as a number", () => {
    expect(
      normalizeMediaSearchResult({
        id: 1,
        kp_id: 1,
        title: "t",
        year: 2000,
        poster_url: "p",
        kp_type: "film",
      }).rating_kp,
    ).toBeNull();
    expect(
      normalizeMediaSearchResult({
        id: 1,
        kp_id: 1,
        title: "t",
        year: 2000,
        poster_url: "p",
        kp_type: "film",
        rating_kp: 8,
      }).rating_kp,
    ).toBe(8);
  });

  it("normalizes MediaDetail with tmdb_id and optional user_review", () => {
    const detail = normalizeMediaDetail({
      id: 2,
      kp_id: 302,
      title: "Фильм",
      year: 2020,
      poster_url: null,
      kp_type: "film",
      rating_kp: 6,
      original_title: "Film",
      overview: "Описание",
      genres: ["драма"],
      updated_at: "2026-02-01T00:00:00Z",
      tmdb_id: "550",
      user_review: {
        id: 9,
        user_id: 7,
        media_item_id: 2,
        score: 8,
        review: "Хорошо",
        created_at: "c",
        updated_at: "u",
      },
    });
    expect(detail.tmdb_id).toBe(550);
    expect(detail.genres).toEqual(["драма"]);
    expect(detail.user_review?.score).toBe(8);
  });

  it("omits tmdb_id and user_review when absent", () => {
    const detail = normalizeMediaDetail({
      id: 2,
      kp_id: 302,
      title: "Фильм",
      year: 2020,
      poster_url: null,
      kp_type: "film",
      rating_kp: 6,
      original_title: "",
      overview: "",
      genres: [],
      updated_at: "",
    });
    expect(detail.tmdb_id).toBeUndefined();
    expect(detail.user_review).toBeUndefined();
  });

  it("coerces size_bytes strings in TorrentReleaseResponse and keeps file_paths", () => {
    const release = normalizeTorrentRelease({
      id: 3,
      tracker: "nnm",
      title: "Release",
      size_bytes: "2147483648",
      seeders: "12",
      leechers: 2,
      quality: "1080p",
      voiceover: "дубляж",
      magnet: "magnet:?xt=…",
      file_paths: ["a.mkv", "b.mkv"],
    });
    expect(release.size_bytes).toBe(2147483648);
    expect(release.seeders).toBe(12);
    expect(release.file_paths).toEqual(["a.mkv", "b.mkv"]);
  });

  it("accepts alternate file-list field names (files / file_list) and {path} entries", () => {
    const fromFiles = normalizeTorrentRelease({
      id: 3,
      files: [{ path: "a.mkv" }, { path: "b.mkv" }],
    });
    expect(fromFiles.file_paths).toEqual(["a.mkv", "b.mkv"]);

    const fromFileList = normalizeTorrentRelease({
      id: 3,
      file_list: ["c.mkv"],
    });
    expect(fromFileList.file_paths).toEqual(["c.mkv"]);
  });

  it("omits file_paths when the release lists no files", () => {
    const release = normalizeTorrentRelease({ id: 3, title: "x" });
    expect(release.file_paths).toBeUndefined();
  });

  it("coerces reserved_bytes / progress_pct / speed_bps in TaskResponse", () => {
    const task = normalizeTask({
      id: 4,
      status: "running",
      reserved_bytes: "500",
      progress_pct: "12.5",
      speed_bps: "1024",
      stage: "download",
      created_at: "c",
      updated_at: "u",
    });
    expect(task.reserved_bytes).toBe(500);
    expect(task.progress_pct).toBe(12.5);
    expect(task.speed_bps).toBe(1024);
    expect(task.error).toBeUndefined();
  });

  it("keeps optional task error when present", () => {
    const task = normalizeTask({
      id: 4,
      status: "failed",
      reserved_bytes: 0,
      progress_pct: 0,
      speed_bps: 0,
      stage: "download",
      error: "Сеть недоступна",
      created_at: "c",
      updated_at: "u",
    });
    expect(task.error).toBe("Сеть недоступна");
  });

  it("coerces position_sec / duration_sec in HistoryResponse", () => {
    const history = normalizeHistory({
      id: 5,
      task_file_id: 6,
      position_sec: "120",
      duration_sec: 3600,
      completed: "true",
      updated_at: "u",
    });
    expect(history.position_sec).toBe(120);
    expect(history.duration_sec).toBe(3600);
    expect(history.completed).toBe(true);
  });

  it("normalizes HistoryResponse lists and tolerates bad payloads", () => {
    const list = normalizeHistoryList([
      {
        id: 1,
        task_file_id: "f1",
        position_sec: "12.5",
        duration_sec: "60",
        completed: 0,
        updated_at: "u1",
      },
      {
        id: 2,
        task_file_id: 2,
        position_sec: null,
        duration_sec: "abc",
        completed: 1,
        updated_at: "u2",
      },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0].position_sec).toBe(12.5);
    expect(list[0].duration_sec).toBe(60);
    expect(list[0].completed).toBe(false);
    expect(list[1].position_sec).toBe(0);
    expect(list[1].duration_sec).toBe(0);
    expect(list[1].completed).toBe(true);
    expect(normalizeHistoryList(null)).toEqual([]);
    expect(normalizeHistoryList({})).toEqual([]);
    expect(normalizeHistoryList("nope")).toEqual([]);
  });

  it("unwraps nested GET /api/history rows {history, media, file, progress_pct}", () => {
    const list = normalizeHistoryList([
      {
        history: {
          id: "h1",
          task_file_id: "f1",
          position_sec: 120.5,
          duration_sec: 3600,
          completed: false,
          updated_at: "2026-01-02T03:04:05+00:00",
        },
        media: { id: "m1", title: "Сериал", poster_url: null },
        file: { id: "f1", path: "Show/S01E01.mkv" },
        progress_pct: 3,
      },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("h1");
    expect(list[0].task_file_id).toBe("f1");
    expect(list[0].position_sec).toBe(120.5);
    expect(list[0].duration_sec).toBe(3600);
    expect(list[0].completed).toBe(false);
    expect(list[0].media?.title).toBe("Сериал");
    expect(list[0].file?.path).toBe("Show/S01E01.mkv");
    expect(list[0].progress_pct).toBe(3);
  });

  it("normalizeHistory unwraps a nested history object", () => {
    const history = normalizeHistory({
      history: {
        id: 9,
        task_file_id: 8,
        position_sec: "1",
        duration_sec: "2",
        completed: false,
        updated_at: "u",
      },
    });
    expect(history.id).toBe(9);
    expect(history.task_file_id).toBe(8);
    expect(history.position_sec).toBe(1);
    expect(history.duration_sec).toBe(2);
  });

  it("normalizes LibraryItem including season/episode coercion", () => {
    const item = normalizeLibraryItem({
      library_item: { id: 1, status: "ready", created_at: "c" },
      media_item: {
        id: 2,
        title: "Сериал",
        poster_url: null,
        kp_type: "series",
        year: "2021",
      },
      files: [
        {
          id: 3,
          path: "s1/e1.mkv",
          size_bytes: "100",
          status: "ready",
          season: "1",
          episode: "2",
        },
      ],
      total_size: "100",
      ready: true,
    });
    expect(item.media_item.year).toBe(2021);
    expect(item.files[0].season).toBe(1);
    expect(item.files[0].episode).toBe(2);
    expect(item.total_size).toBe(100);
    expect(item.ready).toBe(true);
  });

  it("normalizes LibraryItem defaults when optional file fields are absent", () => {
    const item = normalizeLibraryItem({
      library_item: { id: "l1", status: "pending", created_at: "c" },
      media_item: {
        id: "m1",
        title: "Фильм",
        poster_url: "p",
        kp_type: "film",
        year: 2020,
      },
      files: [{ id: 9, path: "a.mkv", size_bytes: 10, status: "queued" }],
      total_size: 10,
      ready: false,
    });
    expect(item.files[0].season).toBeUndefined();
    expect(item.files[0].episode).toBeUndefined();
    expect(item.ready).toBe(false);
  });

  it("maps raw library list payloads and tolerates non-arrays", () => {
    const list = normalizeLibraryList([
      {
        library_item: { id: 1, status: "ready", created_at: "c" },
        media_item: {
          id: 2,
          title: "A",
          poster_url: null,
          kp_type: "film",
          year: "2022",
        },
        files: [],
        total_size: "0",
        ready: true,
      },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].media_item.year).toBe(2022);
    expect(normalizeLibraryList(null)).toEqual([]);
    expect(normalizeLibraryList({})).toEqual([]);
  });

  it("normalizes RoomCreateResponse", () => {
    const room = normalizeRoomCreate({
      id: "r1",
      code: "ABCD2345",
      ws_url: "wss://api.seans.tedeshi.ru/ws/rooms/ABCD2345",
    });
    expect(room.id).toBe("r1");
    expect(room.code).toBe("ABCD2345");
    expect(room.ws_url).toContain("/ws/rooms/");
  });

  it("normalizes RoomDetailResponse (GET /api/rooms/{code})", () => {
    const detail = normalizeRoomDetail({
      room: {
        id: "r1",
        code: "ABCD2345",
        ws_url: "wss://api.seans.tedeshi.ru/ws/rooms/ABCD2345",
        task_file_id: 42,
        host_id: "u1",
      },
      members: [{ user_id: "u1", name: "Анна" }, { user_id: "u2" }],
    });
    expect(detail.room.id).toBe("r1");
    expect(detail.room.task_file_id).toBe(42);
    expect(detail.room.host_id).toBe("u1");
    expect(detail.members).toEqual([
      { user_id: "u1", name: "Анна" },
      { user_id: "u2" },
    ]);

    // Bare room object (no `room` wrapper) still parses.
    const bare = normalizeRoomDetail({
      id: "r2",
      code: "BBBB2222",
      ws_url: "wss://x/ws/rooms/BBBB2222",
      file_id: "7",
    });
    expect(bare.room.id).toBe("r2");
    expect(bare.room.task_file_id).toBe("7");
    expect(bare.members).toEqual([]);

    expect(normalizeRoomMember({ user_id: 5 })).toEqual({ user_id: 5 });
    expect(normalizeRoomMember(null)).toEqual({ user_id: 0 });
  });

  it("normalizes UserResponse", () => {
    const user = normalizeUser({
      id: "u1",
      email: "e@x.y",
      display_name: "Имя",
      can_invite: 0,
      quota_bytes: 10,
      created_at: "c",
    });
    expect(user.id).toBe("u1");
    expect(user.can_invite).toBe(false);
  });
});

describe("401 handling", () => {
  it("isUnauthorizedStatus is true only for 401", () => {
    expect(isUnauthorizedStatus(401)).toBe(true);
    expect(isUnauthorizedStatus(403)).toBe(false);
    expect(isUnauthorizedStatus(200)).toBe(false);
  });

  it("ApiError carries status and message and is identifiable", () => {
    const err = new ApiError(404, "не найдено");
    expect(err.status).toBe(404);
    expect(err.message).toBe("не найдено");
    expect(isApiError(err)).toBe(true);
    expect(isApiError(new Error("x"))).toBe(false);
  });

  it("handleUnauthorized clears the in-memory session token", () => {
    setSessionToken("jwt-token");
    expect(getSessionToken()).toBe("jwt-token");
    handleUnauthorized();
    expect(getSessionToken()).toBeNull();
  });

  describe("request()", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      setSessionToken("jwt-token");
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      setSessionToken(null);
    });

    it("sends Authorization: Bearer <JWT> and parses JSON", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const data = await request<{ id: number }>("/api/auth/me");
      expect(data).toEqual({ id: 1 });

      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { headers: Record<string, string> },
      ];
      expect(url).toContain("/api/auth/me");
      expect(init.headers.Authorization).toBe("Bearer jwt-token");
    });

    it("clears the session and throws ApiError 401 on unauthorized", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Сессия истекла" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ) as unknown as typeof fetch;

      await expect(request("/api/auth/me")).rejects.toMatchObject({
        name: "ApiError",
        status: 401,
      });
      expect(getSessionToken()).toBeNull();
    });

    it("throws ApiError with server message on other failures", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Нет места" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ) as unknown as typeof fetch;

      await expect(request("/api/library")).rejects.toMatchObject({
        status: 403,
        message: "Нет места",
      });
      // Non-401 must not clear the session.
      expect(getSessionToken()).toBe("jwt-token");
    });
  });

  it("apiUrl joins base path and encodes query params", () => {
    const url = apiUrl("/api/search", { query: "фильм", page: 2, skip: undefined });
    expect(url.startsWith("https://api.seans.tedeshi.ru/api/search?")).toBe(true);
    expect(url).toContain("page=2");
    expect(url).not.toContain("skip");
  });
});

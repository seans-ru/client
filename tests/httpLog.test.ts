import { describe, expect, it } from "vitest";
import {
  createHttpLog,
  headerBagToRecord,
  maskHeaderValue,
  MAX_BODY_CHARS,
  MAX_ENTRIES,
  scrubBody,
} from "../src/lib/httpLog";

describe("maskHeaderValue", () => {
  it("keeps the scheme and masks the secret", () => {
    expect(maskHeaderValue("Authorization", "Bearer abc.def.ghi")).toBe(
      "Bearer •••",
    );
    expect(maskHeaderValue("cookie", "session=123")).toBe("•••");
  });

  it("leaves non-sensitive headers intact", () => {
    expect(maskHeaderValue("content-type", "application/json")).toBe(
      "application/json",
    );
    expect(maskHeaderValue("x-request-id", "abc")).toBe("abc");
  });
});

describe("scrubBody", () => {
  it("masks sensitive JSON fields and keeps the rest", () => {
    const body = JSON.stringify({
      email: "a@b.c",
      password: "hunter2",
      user: { access_token: "jwt", name: "Ann" },
    });
    const out = JSON.parse(scrubBody(body) ?? "{}");
    expect(out.email).toBe("a@b.c");
    expect(out.password).toBe("•••");
    expect(out.user.access_token).toBe("•••");
    expect(out.user.name).toBe("Ann");
  });

  it("passes non-JSON bodies through", () => {
    expect(scrubBody("plain text")).toBe("plain text");
    expect(scrubBody(null)).toBe(null);
  });
});

describe("headerBagToRecord", () => {
  it("flattens Headers-like bags and plain objects", () => {
    const headersLike = {
      forEach(cb: (value: string, key: string) => void) {
        cb("application/json", "content-type");
        cb("2", "retry-count");
      },
    };
    expect(headerBagToRecord(headersLike)).toEqual({
      "content-type": "application/json",
      "retry-count": "2",
    });
    expect(headerBagToRecord({ "x-a": "1", "x-b": [1, 2] })).toEqual({
      "x-a": "1",
      "x-b": "1, 2",
    });
    expect(headerBagToRecord(null)).toEqual({});
  });
});

describe("createHttpLog", () => {
  it("records request and finalizes with the response", () => {
    const log = createHttpLog();
    const finish = log.begin({
      method: "POST",
      url: "https://api.test/login",
      reqHeaders: { Authorization: "Bearer secret", Accept: "application/json" },
      reqBody: JSON.stringify({ password: "p" }),
    });
    let entries = log.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe(null);
    expect(entries[0].reqHeaders.Authorization).toBe("Bearer •••");
    expect(JSON.parse(entries[0].reqBody ?? "{}").password).toBe("•••");

    finish({
      status: 200,
      resHeaders: { "content-type": "application/json" },
      resBody: JSON.stringify({ access_token: "jwt" }),
    });
    entries = log.getEntries();
    expect(entries[0].status).toBe(200);
    expect(entries[0].ok).toBe(true);
    expect(entries[0].durationMs).not.toBe(null);
    expect(JSON.parse(entries[0].resBody ?? "{}").access_token).toBe("•••");
    expect(entries[0].resHeaders).toEqual({ "content-type": "application/json" });
  });

  it("treats errors and error statuses as not-ok", () => {
    const log = createHttpLog();
    const fail = log.begin({ method: "GET", url: "/a" });
    fail({ error: new Error("boom") });
    expect(log.getEntries()[0].ok).toBe(false);
    expect(log.getEntries()[0].error).toBe("boom");

    const bad = log.begin({ method: "GET", url: "/b" });
    bad({ status: 500 });
    expect(log.getEntries()[0].ok).toBe(false);

    const missing = log.begin({ method: "GET", url: "/c" });
    missing();
    expect(log.getEntries()[0].ok).toBe(false);
  });

  it("keeps only the newest MAX_ENTRIES entries", () => {
    const log = createHttpLog();
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      log.begin({ method: "GET", url: `/r/${i}` })({ status: 200 });
    }
    const entries = log.getEntries();
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0].url).toBe(`/r/${MAX_ENTRIES + 9}`);
  });

  it("truncates oversized bodies", () => {
    const log = createHttpLog();
    const finish = log.begin({ method: "GET", url: "/big" });
    finish({ status: 200, resBody: "x".repeat(MAX_BODY_CHARS + 100) });
    const entry = log.getEntries()[0];
    expect(entry.resBodyTruncated).toBe(true);
    expect(entry.resBody).toHaveLength(MAX_BODY_CHARS);
  });

  it("ignores a double finish and notifies subscribers on change", () => {
    const log = createHttpLog();
    const seen: number[] = [];
    const stop = log.subscribe(() => seen.push(log.getEntries().length));
    const finish = log.begin({ method: "GET", url: "/x" });
    finish({ status: 200 });
    finish({ status: 500 });
    expect(log.getEntries()[0].status).toBe(200);
    // begin + finish notifications only (the double finish is a no-op).
    expect(seen).toEqual([1, 1]);

    const snapshot = log.getEntries();
    expect(log.getEntries()).toBe(snapshot);
    log.clear();
    expect(log.getEntries()).toHaveLength(0);
    expect(log.getEntries()).not.toBe(snapshot);
    stop();
    log.begin({ method: "GET", url: "/y" })({ status: 200 });
    expect(seen).toHaveLength(3);
  });
});

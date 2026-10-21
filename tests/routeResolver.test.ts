import { describe, expect, it } from "vitest";
import { parseDeepLink } from "../src/lib/deepLink";
import {
  isFullBleedRoute,
  matchMediaRoute,
  matchPlayerRoute,
  matchRoomRoute,
  resolveLegacyRoute,
  resolveRoute,
  resolveRouteFromDeepLink,
  ROUTES,
} from "../src/lib/routeResolver";

describe("resolveRoute", () => {
  it("maps home payload to #/", () => {
    expect(resolveRoute({ kind: "home" })).toBe(ROUTES.home);
  });

  it("maps auth callback payload to home (tokens handled separately)", () => {
    expect(
      resolveRoute({
        kind: "authCallback",
        accessToken: "tok",
        state: "st",
      }),
    ).toBe(ROUTES.home);
  });

  it("maps room payload to #/room/:code", () => {
    expect(resolveRoute({ kind: "room", roomCode: "ABCD2345" })).toBe(
      "#/room/ABCD2345",
    );
  });
});

describe("resolveRouteFromDeepLink", () => {
  it("resolves seans:// to home", () => {
    expect(resolveRouteFromDeepLink("seans://")).toBe("#/");
  });

  it("resolves auth callback to home", () => {
    expect(
      resolveRouteFromDeepLink("seans://auth/callback?access_token=a&state=b"),
    ).toBe("#/");
  });

  it("resolves room links", () => {
    expect(resolveRouteFromDeepLink("seans://room/ABCD2345")).toBe(
      "#/room/ABCD2345",
    );
  });

  it("returns null for ignored links (no navigation)", () => {
    expect(resolveRouteFromDeepLink("seans://room/bad")).toBeNull();
    expect(resolveRouteFromDeepLink("seans://nope")).toBeNull();
    expect(resolveRouteFromDeepLink("garbage")).toBeNull();
  });

  it("round-trips with parseDeepLink", () => {
    const raw = "seans://room/ZZZZ2222";
    const payload = parseDeepLink(raw);
    expect(payload).not.toBeNull();
    if (payload) {
      expect(resolveRoute(payload)).toBe("#/room/ZZZZ2222");
    }
  });
});

describe("matchRoomRoute", () => {
  it("extracts a valid room code from a hash route", () => {
    expect(matchRoomRoute("#/room/ABCD2345")).toBe("ABCD2345");
  });

  it("returns null for non-room or invalid routes", () => {
    expect(matchRoomRoute("#/")).toBeNull();
    expect(matchRoomRoute("#/login")).toBeNull();
    expect(matchRoomRoute("#/room/bad")).toBeNull();
    expect(matchRoomRoute("#/room/ABCD2345/extra")).toBeNull();
  });
});

describe("matchMediaRoute", () => {
  it("extracts the media id from #/media/:id", () => {
    expect(matchMediaRoute("#/media/42")).toBe("42");
    expect(matchMediaRoute("#/media/abc-123")).toBe("abc-123");
    expect(matchMediaRoute("#/media/9")).toBe("9");
  });

  it("returns null for non-media or invalid routes", () => {
    expect(matchMediaRoute("#/")).toBeNull();
    expect(matchMediaRoute("#/media")).toBeNull();
    expect(matchMediaRoute("#/media/")).toBeNull();
    expect(matchMediaRoute("#/media/1/2")).toBeNull();
    expect(matchMediaRoute("#/library")).toBeNull();
    expect(matchMediaRoute("#/room/ABCD2345")).toBeNull();
  });
});

describe("matchPlayerRoute", () => {
  it("extracts the file id from #/player/:fileId", () => {
    expect(matchPlayerRoute("#/player/77")).toBe("77");
    expect(matchPlayerRoute("#/player/file-1")).toBe("file-1");
  });

  it("returns null for non-player or invalid routes", () => {
    expect(matchPlayerRoute("#/")).toBeNull();
    expect(matchPlayerRoute("#/player")).toBeNull();
    expect(matchPlayerRoute("#/player/1/2")).toBeNull();
    expect(matchPlayerRoute("#/media/1")).toBeNull();
  });
});

describe("ROUTES builders", () => {
  it("builds nested hash paths", () => {
    expect(ROUTES.media(5)).toBe("#/media/5");
    expect(ROUTES.player(9)).toBe("#/player/9");
    expect(ROUTES.room("ABCD2345")).toBe("#/room/ABCD2345");
  });

  it("exposes the static shell destinations", () => {
    expect(ROUTES.home).toBe("#/");
    expect(ROUTES.login).toBe("#/login");
    expect(ROUTES.library).toBe("#/library");
    expect(ROUTES.tasks).toBe("#/tasks");
    expect(ROUTES.history).toBe("#/history");
    expect(ROUTES.settings).toBe("#/settings");
    expect(ROUTES.account).toBe("#/account");
  });
});

describe("isFullBleedRoute", () => {
  it("is true for player and room (no left nav)", () => {
    expect(isFullBleedRoute("#/player/12")).toBe(true);
    expect(isFullBleedRoute("#/room/ABCD2345")).toBe(true);
  });

  it("is false for shell and auth-gate routes", () => {
    expect(isFullBleedRoute("#/")).toBe(false);
    expect(isFullBleedRoute("#/login")).toBe(false);
    expect(isFullBleedRoute("#/library")).toBe(false);
    expect(isFullBleedRoute("#/media/1")).toBe(false);
    expect(isFullBleedRoute("#/settings")).toBe(false);
    expect(isFullBleedRoute("#/account")).toBe(false);
    expect(isFullBleedRoute("#/tasks")).toBe(false);
    expect(isFullBleedRoute("#/history")).toBe(false);
  });
});

describe("resolveLegacyRoute", () => {
  it("redirects tasks and history into the library hub", () => {
    expect(resolveLegacyRoute(ROUTES.tasks)).toBe(ROUTES.library);
    expect(resolveLegacyRoute(ROUTES.history)).toBe(ROUTES.library);
  });

  it("redirects account into settings", () => {
    expect(resolveLegacyRoute(ROUTES.account)).toBe(ROUTES.settings);
  });

  it("returns null for live destinations", () => {
    expect(resolveLegacyRoute(ROUTES.home)).toBeNull();
    expect(resolveLegacyRoute(ROUTES.library)).toBeNull();
    expect(resolveLegacyRoute(ROUTES.settings)).toBeNull();
    expect(resolveLegacyRoute(ROUTES.media(9))).toBeNull();
    expect(resolveLegacyRoute(ROUTES.player(3))).toBeNull();
    expect(resolveLegacyRoute(ROUTES.room("ABCD2345"))).toBeNull();
  });
});

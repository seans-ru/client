import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { HomeScreen } from "./screens/HomeScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { MediaScreen } from "./screens/MediaScreen";
import { PlayerScreen } from "./screens/PlayerScreen";
import { RoomScreen } from "./screens/RoomScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { parseDeepLink } from "./lib/deepLink";
import {
  getCurrentHashRoute,
  matchMediaRoute,
  matchPlayerRoute,
  matchRoomRoute,
  resolveLegacyRoute,
  resolveRoute,
  ROUTES,
} from "./lib/routeResolver";
import { AuthProvider, useAuth } from "./features/auth";
import type { AuthCallbackDetail } from "./features/auth";
import { UpdaterProvider } from "./features/updater";
import { LoadingSlot } from "./design/slots";
import { AppShell } from "./design/AppShell";

function emitAuthCallback(detail: AuthCallbackDetail): void {
  window.dispatchEvent(
    new CustomEvent<AuthCallbackDetail>("seans:auth-callback", { detail }),
  );
}

function navigate(hash: string): void {
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}

function handleDeepLinkUrl(raw: string): void {
  const payload = parseDeepLink(raw);
  if (!payload) return; // malformed / unknown — ignore, no crash

  if (payload.kind === "authCallback") {
    // Tokens are relayed in memory only (AuthProvider consumes this event).
    emitAuthCallback({
      accessToken: payload.accessToken,
      state: payload.state,
    });
  }

  navigate(resolveRoute(payload));
}

function useHashRoute(): string {
  const [route, setRoute] = useState(getCurrentHashRoute);

  useEffect(() => {
    const onChange = () => setRoute(getCurrentHashRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

/** Map a hash route to its screen body (no chrome). Unknown routes fall back to home. */
function renderScreen(route: string): ReactNode {
  const roomCode = matchRoomRoute(route);
  if (roomCode) return <RoomScreen code={roomCode} />;

  const mediaId = matchMediaRoute(route);
  if (mediaId) return <MediaScreen id={mediaId} />;

  const fileId = matchPlayerRoute(route);
  if (fileId) return <PlayerScreen fileId={fileId} />;

  if (route === ROUTES.library) return <LibraryScreen />;
  if (route === ROUTES.settings) return <SettingsScreen />;

  return <HomeScreen />;
}

/**
 * Hash router, gated on auth (three destinations):
 *   #/                home (chart hero + search)
 *   #/library         media hub (continue, next episode, downloads, rooms)
 *   #/settings        account + preferences + updates
 *   #/login           auth gate
 *   #/media/:id       media detail
 *   #/player/:fileId  player (full-bleed)
 *   #/room/:code      watch party (full-bleed)
 * Legacy `#/tasks` `#/history` → library; `#/account` → settings.
 * Anonymous users only see #/login.
 */
function Router() {
  const route = useHashRoute();
  const { status } = useAuth();

  useEffect(() => {
    const legacy = resolveLegacyRoute(route);
    if (legacy && route !== legacy) {
      navigate(legacy);
      return;
    }
    if (status === "anonymous" && route !== ROUTES.login) {
      navigate(ROUTES.login);
    }
  }, [status, route]);

  if (status === "loading") {
    return <LoadingSlot label="Проверка сессии…" />;
  }

  if (route === ROUTES.login) return <LoginScreen />;

  if (status === "anonymous") {
    // Redirect effect above sends the user to login; avoid flashing home.
    return <LoadingSlot label="Проверка сессии…" />;
  }

  return <AppShell route={route}>{renderScreen(route)}</AppShell>;
}

function Shell() {
  useEffect(() => {
    // Deep links delivered while the app is running (Tauri deep-link plugin).
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const { getCurrent, onOpenUrl } = await import(
          "@tauri-apps/plugin-deep-link"
        );

        // Cold start: URLs that launched the app are captured before JS mounts.
        const startupUrls = await getCurrent();
        if (startupUrls) {
          for (const url of startupUrls) handleDeepLinkUrl(url);
        }

        // Warm path: URLs delivered while the app is already running.
        const stop = await onOpenUrl((urls) => {
          for (const url of urls) handleDeepLinkUrl(url);
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        // Running in a plain browser (npm run dev) — deep links unavailable.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="app">
      <Router />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <UpdaterProvider>
        <Shell />
      </UpdaterProvider>
    </AuthProvider>
  );
}

export { handleDeepLinkUrl };
export type { AuthCallbackDetail };

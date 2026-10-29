/**
 * Auth context for the Seans client (M2).
 *
 * Holds the hydrated user and login status, drives the web OAuth flow
 * (system browser → seans://auth/callback, with a loopback fallback), and
 * persists the JWT via the Windows Credential Manager — never via localStorage.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetchMe } from "../../api/endpoints";
import {
  clearSessionToken,
  loadSessionToken,
  saveSessionToken,
  setSessionToken,
} from "../../api/session";
import { ROUTES, takePendingRoute } from "../../lib/routeResolver";
import type { UserResponse } from "../../api/types";
import {
  buildAuthorizeUrl,
  checkAuthCallback,
  createOAuthState,
  DEFAULT_REDIRECT_URI,
  loopbackRedirectUri,
} from "./loginFlow";

export type AuthStatus = "loading" | "anonymous" | "authenticated";

export type AuthContextValue = {
  user: UserResponse | null;
  status: AuthStatus;
  /** True while waiting for the browser redirect back into the app. */
  loginPending: boolean;
  /** Localized error from the login flow, if any. */
  loginError: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  /** Abandon a pending browser login (clears state, stops the loopback listener). */
  cancelLogin: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function navigate(hash: string): void {
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserResponse | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [loginPending, setLoginPending] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const pendingStateRef = useRef<string | null>(null);

  // Hydrate from the Credential Manager on startup.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await loadSessionToken();
        if (cancelled) return;
        if (!token) {
          setStatus("anonymous");
          return;
        }
        const me = await fetchMe();
        if (cancelled) return;
        setUser(me);
        setStatus("authenticated");
      } catch {
        if (cancelled) return;
        setSessionToken(null);
        setUser(null);
        setStatus("anonymous");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Consume `seans:auth-callback` (emitted by App from deep links / loopback).
  useEffect(() => {
    const onCallback = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        accessToken: string | null;
        state: string | null;
      };
      const check = checkAuthCallback(
        pendingStateRef.current,
        detail.state,
        detail.accessToken,
      );
      if (!check.ok) {
        // Mismatch or incomplete callback: reject and store nothing.
        if (pendingStateRef.current !== null) {
          pendingStateRef.current = null;
          setLoginPending(false);
          setLoginError(
            check.reason === "state-mismatch"
              ? "Ссылка авторизации не совпала с текущим входом. Попробуйте ещё раз."
              : "Ссылка авторизации устарела или повреждена. Попробуйте ещё раз.",
          );
        }
        return;
      }

      pendingStateRef.current = null;
      void (async () => {
        try {
          await saveSessionToken(check.accessToken);
          const me = await fetchMe();
          setUser(me);
          setStatus("authenticated");
          setLoginError(null);
          // Return to the pre-login destination (shared room link etc.).
          navigate(takePendingRoute() ?? ROUTES.home);
        } catch {
          await clearSessionToken().catch(() => {});
          setUser(null);
          setStatus("anonymous");
          setLoginError("Не удалось получить данные пользователя. Попробуйте ещё раз.");
        } finally {
          setLoginPending(false);
          void invoke("stop_loopback_auth").catch(() => {});
        }
      })();
    };

    window.addEventListener("seans:auth-callback", onCallback);
    return () => {
      window.removeEventListener("seans:auth-callback", onCallback);
    };
  }, []);

  // API rejected the JWT: drop the session and return to login.
  useEffect(() => {
    const onAuthRequired = () => {
      pendingStateRef.current = null;
      setLoginPending(false);
      void clearSessionToken().catch(() => {});
      setUser(null);
      setStatus("anonymous");
      navigate(ROUTES.login);
    };
    window.addEventListener("seans:auth-required", onAuthRequired);
    return () => window.removeEventListener("seans:auth-required", onAuthRequired);
  }, []);

  // Stop the loopback listener when the provider goes away.
  useEffect(() => {
    return () => {
      void invoke("stop_loopback_auth").catch(() => {});
    };
  }, []);

  const login = useCallback(async () => {
    setLoginError(null);
    const state = createOAuthState();
    pendingStateRef.current = state;
    setLoginPending(true);

    // Primary path: system browser → seans://auth/callback.
    try {
      await invoke("open_url", {
        url: buildAuthorizeUrl(state, DEFAULT_REDIRECT_URI),
      });
      return;
    } catch {
      // Fall through to the loopback fallback.
    }

    // Fallback: one-shot local HTTP acceptor on 127.0.0.1:<port>/callback.
    try {
      const port = await invoke<number>("start_loopback_auth");
      await invoke("open_url", {
        url: buildAuthorizeUrl(state, loopbackRedirectUri(port)),
      });
    } catch {
      pendingStateRef.current = null;
      setLoginPending(false);
      setLoginError("Не удалось открыть браузер для входа.");
    }
  }, []);

  const logout = useCallback(async () => {
    pendingStateRef.current = null;
    setLoginPending(false);
    setLoginError(null);
    void invoke("stop_loopback_auth").catch(() => {});
    try {
      await clearSessionToken();
    } catch {
      setSessionToken(null);
    }
    setUser(null);
    setStatus("anonymous");
    navigate(ROUTES.login);
  }, []);

  const cancelLogin = useCallback(() => {
    pendingStateRef.current = null;
    setLoginPending(false);
    void invoke("stop_loopback_auth").catch(() => {});
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      loginPending,
      loginError,
      login,
      logout,
      cancelLogin,
    }),
    [user, status, loginPending, loginError, login, logout, cancelLogin],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

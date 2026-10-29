/**
 * Updater context (M11): one controller for check / background download /
 * apply. Mounted once above the shell so Settings and the banner share state.
 *
 * Non-blocking by design: every Tauri call is fire-and-forget async so the
 * player and the auth gate never wait on the update endpoint.
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
import { useAuth } from "../auth";
import {
  isUpdateBannerPhase,
  nextUpdatePhase,
  shouldCheckOnStartup,
  UPDATE_CHECK_INTERVAL_MS,
} from "./updatePolicy";
import type { UpdateEvent, UpdatePhase } from "./updatePolicy";
import { checkForUpdate, readAppVersion, relaunchApp } from "./updaterApi";
import type { UpdateHandle, UpdaterDownloadEvent } from "./updaterApi";

export type UpdateProgress = {
  downloadedBytes: number;
  totalBytes: number | null;
};

export type UpdaterContextValue = {
  phase: UpdatePhase;
  /** Remote version when an update is available. */
  availableVersion: string | null;
  /** Currently running app version (null outside the Tauri shell). */
  appVersion: string | null;
  progress: UpdateProgress | null;
  error: string | null;
  /** Banner visibility: hidden after «Позже» or when no update is known. */
  bannerVisible: boolean;
  applyOnExitPending: boolean;
  lastCheckedAt: number | null;
  dismissBanner: () => void;
  /** Manual check (Settings button). Always runs, ignores the debounce. */
  checkNow: () => Promise<void>;
  /** Install the downloaded update and relaunch. */
  restartNow: () => Promise<void>;
  /** Defer the install until the app exits (best-effort on window unload). */
  applyOnExit: () => void;
};

const UpdaterContext = createContext<UpdaterContextValue | null>(null);

function progressFromEvent(
  event: UpdaterDownloadEvent,
  previous: UpdateProgress,
): UpdateProgress {
  if (event.event === "Started") {
    const total = event.data.contentLength;
    return {
      downloadedBytes: 0,
      totalBytes: typeof total === "number" && Number.isFinite(total) ? total : null,
    };
  }
  if (event.event === "Progress") {
    const chunk = event.data.chunkLength;
    return {
      downloadedBytes:
        previous.downloadedBytes +
        (typeof chunk === "number" && Number.isFinite(chunk) ? chunk : 0),
      totalBytes: previous.totalBytes,
    };
  }
  return previous;
}

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bannerVisible, setBannerVisible] = useState(false);
  const [applyOnExitPending, setApplyOnExitPending] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);

  const phaseRef = useRef<UpdatePhase>("idle");
  const updateRef = useRef<UpdateHandle | null>(null);
  const downloadingRef = useRef(false);
  const applyOnExitRef = useRef(false);
  const startupCheckedRef = useRef(false);
  const lastCheckedAtRef = useRef<number | null>(null);

  const applyEvent = useCallback((event: UpdateEvent) => {
    const next = nextUpdatePhase(phaseRef.current, event);
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const runDownload = useCallback(
    async (update: UpdateHandle) => {
      if (downloadingRef.current) return;
      downloadingRef.current = true;
      updateRef.current = update;
      applyEvent({ type: "download-start" });
      setProgress({ downloadedBytes: 0, totalBytes: null });
      try {
        await update.download((event) => {
          setProgress((previous) =>
            progressFromEvent(event, previous ?? { downloadedBytes: 0, totalBytes: null }),
          );
        });
        applyEvent({ type: "download-done" });
        setBannerVisible(true);
      } catch {
        applyEvent({ type: "fail" });
        setError("Не удалось загрузить обновление");
      } finally {
        downloadingRef.current = false;
      }
    },
    [applyEvent],
  );

  const runCheck = useCallback(
    async (options?: { manual?: boolean }) => {
      const current = phaseRef.current;
      // Never interrupt a live download or install; auto-checks skip in-flight checks.
      if (current === "downloading" || current === "applying") return;
      if (!options?.manual && current === "checking") return;
      applyEvent({ type: "check-start" });
      setError(null);
      const now = Date.now();
      try {
        const update = await checkForUpdate();
        lastCheckedAtRef.current = now;
        setLastCheckedAt(now);
        if (!update) {
          applyEvent({ type: "check-none" });
          return;
        }
        setAvailableVersion(update.version);
        applyEvent({ type: "check-found" });
        setBannerVisible(true);
        // Background download — never blocks playback.
        void runDownload(update);
      } catch {
        // Dev endpoints 404 and offline checks stay quiet on the automatic
        // cadence; a manual check surfaces the failure in Settings.
        if (options?.manual) {
          applyEvent({ type: "fail" });
          setError("Не удалось проверить обновления");
        } else {
          applyEvent({ type: "reset" });
        }
      }
    },
    [applyEvent, runDownload],
  );

  const checkNow = useCallback(async () => {
    await runCheck({ manual: true });
  }, [runCheck]);

  const restartNow = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    applyEvent({ type: "apply-start" });
    setError(null);
    try {
      await update.install();
      await relaunchApp();
    } catch {
      applyEvent({ type: "fail" });
      setError("Не удалось установить обновление");
    }
  }, [applyEvent]);

  const applyOnExit = useCallback(() => {
    if (!updateRef.current) return;
    applyOnExitRef.current = true;
    setApplyOnExitPending(true);
  }, []);

  const dismissBanner = useCallback(() => {
    setBannerVisible(false);
  }, []);

  // Startup + recurring checks, gated on the auth gate being ready (non-blocking).
  // Dev builds never auto-check: `npm run tauri dev` would otherwise find a
  // newer release and start downloading it over the working tree.
  useEffect(() => {
    if (status === "loading") return;
    void readAppVersion().then((version) => setAppVersion(version));
    if (import.meta.env.DEV) return;

    if (!startupCheckedRef.current) {
      startupCheckedRef.current = true;
      if (shouldCheckOnStartup(lastCheckedAtRef.current, Date.now())) {
        void runCheck();
      }
    }
    const timer = setInterval(() => {
      void runCheck();
    }, UPDATE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status, runCheck]);

  // Best-effort "apply on exit": hand the installer over as the window goes away.
  useEffect(() => {
    const onUnload = () => {
      if (!applyOnExitRef.current) return;
      const update = updateRef.current;
      if (!update) return;
      applyOnExitRef.current = false;
      void update.install();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const value = useMemo<UpdaterContextValue>(
    () => ({
      phase,
      availableVersion,
      appVersion,
      progress,
      error,
      bannerVisible: bannerVisible && isUpdateBannerPhase(phase),
      applyOnExitPending,
      lastCheckedAt,
      dismissBanner,
      checkNow,
      restartNow,
      applyOnExit,
    }),
    [
      phase,
      availableVersion,
      appVersion,
      progress,
      error,
      bannerVisible,
      applyOnExitPending,
      lastCheckedAt,
      dismissBanner,
      checkNow,
      restartNow,
      applyOnExit,
    ],
  );

  return (
    <UpdaterContext.Provider value={value}>{children}</UpdaterContext.Provider>
  );
}

/** Read the shared updater state (must be under `UpdaterProvider`). */
export function useUpdater(): UpdaterContextValue {
  const ctx = useContext(UpdaterContext);
  if (!ctx) {
    throw new Error("useUpdater requires UpdaterProvider");
  }
  return ctx;
}

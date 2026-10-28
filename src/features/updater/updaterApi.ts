/**
 * Thin wrappers over `tauri-plugin-updater` / `tauri-plugin-process` (M11).
 *
 * Outside the Tauri shell (plain `npm run dev` in a browser) the plugin import
 * fails and every entry point degrades to "no update" / no-op — nothing throws
 * into the UI. No runtime code is fetched: the plugins only talk to the
 * configured JSON endpoint and hand the signed installer to the OS installer.
 */

export type UpdaterDownloadEvent =
  | { event: "Started"; data: { contentLength?: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export type UpdateHandle = {
  version: string;
  currentVersion: string;
  date: string | null;
  body: string | null;
  download: (onEvent?: (event: UpdaterDownloadEvent) => void) => Promise<void>;
  install: () => Promise<void>;
  downloadAndInstall: (
    onEvent?: (event: UpdaterDownloadEvent) => void,
  ) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Wrap the plugin's Update object without assuming its exact class shape.
 * Methods are re-bound to the source instance so prototype methods keep `this`.
 */
function toUpdateHandle(raw: unknown): UpdateHandle | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const meta = source.metadata as Record<string, unknown> | undefined;
  const version =
    typeof source.version === "string"
      ? source.version
      : typeof meta?.version === "string"
        ? meta.version
        : null;
  if (!version) return null;

  const call = (name: string, args: unknown[]): Promise<void> => {
    const fn = source[name];
    if (typeof fn !== "function") {
      return Promise.reject(new Error(`updater: missing ${name}`));
    }
    return Promise.resolve(
      (fn as (...rest: unknown[]) => unknown).apply(source, args),
    ).then(() => undefined);
  };

  return {
    version,
    currentVersion:
      typeof source.currentVersion === "string" ? source.currentVersion : "",
    date: typeof source.date === "string" ? source.date : null,
    body: typeof source.body === "string" ? source.body : null,
    download: (onEvent) => call("download", [onEvent]),
    install: () => call("install", []),
    downloadAndInstall: (onEvent) => call("downloadAndInstall", [onEvent]),
    close: () => call("close", []),
  };
}

/**
 * Signing is configured: `plugins.updater.pubkey` holds the release minisign
 * key (private half lives in CI secrets only — see docs/av-checklist.md).
 * Keep false only if the pubkey is ever emptied again.
 */
export const UPDATER_SIGNING_READY = true;

/**
 * Check the configured endpoint for a newer release.
 *
 * Returns null when the updater plugin is not available (plain-browser dev),
 * when signing is not configured yet, or when the server reports no update.
 * Propagates endpoint / network errors so the UI can distinguish "up to date"
 * from "check failed" on a manual check.
 */
export async function checkForUpdate(): Promise<UpdateHandle | null> {
  if (!UPDATER_SIGNING_READY) {
    return null;
  }
  const mod = await import("@tauri-apps/plugin-updater").catch(() => null);
  if (!mod) {
    // Plugin not bundled (plain `npm run dev` in a browser) — nothing to check.
    return null;
  }
  const update = await mod.check();
  return toUpdateHandle(update);
}

/** Relaunch the app into the installed update (no-op outside Tauri). */
export async function relaunchApp(): Promise<void> {
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    // Plain browser / plugin unavailable — nothing to restart.
  }
}

/** Running app version from Tauri (`getVersion`), or null outside the shell. */
export async function readAppVersion(): Promise<string | null> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return null;
  }
}

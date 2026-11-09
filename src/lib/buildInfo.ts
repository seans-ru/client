/**
 * Build identity helpers.
 *
 * The short commit hash is injected at build/dev start by vite (`define`
 * `import.meta.env.VITE_APP_COMMIT`, see vite.config.ts) so the app can show
 * which commit it was built from — a dev run of the wrong branch is otherwise
 * indistinguishable from a missing feature.
 */

/** Label for the Settings version row: `0.1.0 (86bc520)`. */
export function formatAppVersionLabel(
  appVersion: string | null,
  commit: string,
): string {
  const base = appVersion ?? "недоступна";
  return commit ? `${base} (${commit})` : base;
}

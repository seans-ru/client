/**
 * Regenerates app icons in src-tauri/icons from the SVG master
 * (src-tauri/icons/seans-icon.svg) via the Tauri CLI, then keeps only
 * the Windows bundle set.
 * Run: node scripts/generate-icons.mjs  (requires `npm install` first)
 * Idempotent: safe to re-run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "src-tauri", "icons");
const svg = join(iconsDir, "seans-icon.svg");

if (!existsSync(svg)) {
  console.error(`icon source missing: ${svg}`);
  process.exit(1);
}

// `tauri icon` emits every platform's set; the repo bundles Windows only.
const res = spawnSync(`npx tauri icon "${svg}"`, {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
if (res.status !== 0) {
  console.error("tauri icon failed:", res.error ?? `exit ${res.status}`);
  process.exit(res.status ?? 1);
}

const keep = new Set([
  "32x32.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.ico",
  "icon.png",
  "README.txt",
  "seans-icon.svg",
]);
for (const entry of readdirSync(iconsDir, { withFileTypes: true })) {
  if (!keep.has(entry.name)) {
    rmSync(join(iconsDir, entry.name), { recursive: true, force: true });
  }
}

console.log("icons written to", iconsDir);

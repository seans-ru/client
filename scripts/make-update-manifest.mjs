#!/usr/bin/env node
/**
 * Build the Tauri updater manifest (latest.json) from a local `tauri build`
 * bundle directory. Used by CI after `tauri build --config '{"version":...}'`.
 *
 * Usage (repo root):
 *   node scripts/make-update-manifest.mjs \
 *     --version 0.1.47 \
 *     --bundle-dir src-tauri/target/release/bundle \
 *     --base-url https://seans.tedeshi.ru/updates \
 *     --out latest.json
 *
 * The update payload is the NSIS installer (`*-setup.exe`) plus its `.sig`
 * sidecar produced by `createUpdaterArtifacts`. The MSI is published alongside
 * for fresh installs but is not referenced by the manifest.
 *
 * Expected S3 layout (relative to the bucket):
 *   updates/latest.json
 *   updates/<version>/Seans_<version>_x64-setup.exe[.sig]
 *   updates/<version>/Seans_<version>_x64_en-US.msi[.sig]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function argValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) {
    throw new Error(`missing required argument ${name}`);
  }
  return args[i + 1];
}

function findNsisInstaller(bundleDir) {
  const nsisDir = join(bundleDir, "nsis");
  const files = readdirSync(nsisDir).filter(
    (f) => f.endsWith("-setup.exe") && !f.endsWith(".sig"),
  );
  if (files.length === 0) {
    throw new Error(`no *-setup.exe found in ${nsisDir}`);
  }
  // Deterministic pick when several installers are present.
  files.sort();
  return files[files.length - 1];
}

function main() {
  const args = process.argv.slice(2);
  const version = argValue(args, "--version");
  const bundleDir = argValue(args, "--bundle-dir");
  const baseUrl = argValue(args, "--base-url").replace(/\/+$/, "");
  const outPath = argValue(args, "--out");
  const notesIdx = args.indexOf("--notes");
  const notes =
    notesIdx !== -1 && notesIdx < args.length - 1 ? args[notesIdx + 1] : "";

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version must be semver X.Y.Z, got "${version}"`);
  }

  const installerName = findNsisInstaller(bundleDir);
  const sigPath = join(bundleDir, "nsis", `${installerName}.sig`);
  const signature = readFileSync(sigPath, "utf8").trim();
  if (!signature) {
    throw new Error(`empty signature file ${sigPath}`);
  }

  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature,
        url: `${baseUrl}/${version}/${installerName}`,
      },
    },
  };

  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`wrote ${outPath}: ${version} -> ${manifest.platforms["windows-x86_64"].url}`);
}

main();

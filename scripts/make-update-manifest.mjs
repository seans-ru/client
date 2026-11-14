#!/usr/bin/env node
/**
 * Build the Tauri updater manifest (latest.json) from a local `tauri build`
 * bundle directory. Used by CI after `tauri build --config '{"version":...}'`.
 *
 * Usage (repo root):
 *   node scripts/make-update-manifest.mjs \
 *     --version 0.1.47 \
 *     --bundle-dir publish/updates/0.1.47 \
 *     --base-url https://seans.tedeshi.ru/updates \
 *     --out latest.json
 *
 * The update payloads are the signed NSIS installer and signed AppImage
 * produced by `createUpdaterArtifacts`. The MSI is published alongside for
 * fresh Windows installs but is not referenced by the manifest.
 *
 * Expected S3 layout (relative to the bucket):
 *   updates/latest.json
 *   updates/<version>/Seans_<version>_x64-setup.exe[.sig]
 *   updates/<version>/Seans_<version>_x64_en-US.msi[.sig]
 *   updates/<version>/linux/Seans_<version>_amd64.AppImage[.sig]
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

function findSignedArtifact(directory, pattern, description) {
  const files = readdirSync(directory).filter(
    (f) => pattern.test(f) && !f.endsWith(".sig"),
  );
  if (files.length === 0) {
    throw new Error(`no ${description} found in ${directory}`);
  }
  files.sort();
  return files[files.length - 1];
}

function readSignature(directory, artifactName) {
  const sigPath = join(directory, `${artifactName}.sig`);
  const signature = readFileSync(sigPath, "utf8").trim();
  if (!signature) {
    throw new Error(`empty signature file ${sigPath}`);
  }
  return signature;
}

function findNsisInstaller(windowsDir) {
  const installerName = findSignedArtifact(
    windowsDir,
    /-setup\.exe$/,
    "signed *-setup.exe",
  );
  return {
    name: installerName,
    signature: readSignature(windowsDir, installerName),
  };
}

function findAppImage(linuxDir) {
  const appImageName = findSignedArtifact(
    linuxDir,
    /\.AppImage$/i,
    "signed *.AppImage",
  );
  return {
    name: appImageName,
    signature: readSignature(linuxDir, appImageName),
  };
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

  const windowsDir = join(bundleDir, "windows");
  const linuxDir = join(bundleDir, "linux");
  const windows = findNsisInstaller(windowsDir);
  const linux = findAppImage(linuxDir);

  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: windows.signature,
        url: `${baseUrl}/${version}/${windows.name}`,
      },
      "linux-x86_64": {
        signature: linux.signature,
        url: `${baseUrl}/${version}/linux/${linux.name}`,
      },
    },
  };

  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`wrote ${outPath}: ${version} -> ${Object.keys(manifest.platforms).join(", ")}`);
}

main();

# Seans Client

Native Windows desktop client for the [Seans](https://seans.tedeshi.ru) self-hosted media service.

Search films (Kinopoisk), pick torrent releases, stream completed files via presigned URLs, and watch together in rooms. **All video playback happens only in this client** (libmpv). The web app is catalog + account.

| | |
|---|---|
| Platform | Windows 10/11 x64 (v1) |
| Stack | Tauri 2 · React · TypeScript · Vite · libmpv |
| Deep links | `seans://` |
| Updates | `tauri-plugin-updater` (startup + every 6h + manual) |

## Prerequisites

- [Rust](https://rustup.rs/) stable (`x86_64-pc-windows-msvc`)
- Node.js 20+ and npm
- Visual Studio 2022 Build Tools with **Desktop development with C++** (MSVC, Windows 10/11 SDK)
- WebView2 runtime (preinstalled on Win 11; [Evergreen installer](https://developer.microsoft.com/microsoft-edge/webview2/) for Win 10)

## Develop

```bash
npm install
node scripts/generate-icons.mjs   # icons from seans-icon.svg (idempotent)
powershell -ExecutionPolicy Bypass -File scripts\fetch-mpv.ps1   # once: bundle libmpv DLLs
npm run tauri dev
```

Frontend runs on Vite’s dev server; the Rust shell is rebuilt by `tauri dev` on change.

Useful scripts:

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite only (UI hot-reload without shell) |
| `npm run build` | Type-check + production frontend bundle |
| `npm run typecheck` | `tsc --noEmit` only |
| `npm test` | Unit tests (Vitest, single run) |
| `npm run test:watch` | Vitest watch mode |
| `npm run tauri dev` | Full desktop app in dev mode |
| `npm run tauri build` | Release MSI/NSIS installer |

## Build

```bash
npm install
node scripts/generate-icons.mjs
powershell -ExecutionPolicy Bypass -File scripts\fetch-mpv.ps1   # once: bundle libmpv
npm run build
npm run tauri build
```

Or run the full M1 gate in one go: `powershell -ExecutionPolicy Bypass -File scripts\verify.ps1`.

Installer output: `src-tauri/target/release/bundle/`.

VersionInfo (CompanyName=`bundle.publisher`, ProductName, FileVersion, ProductVersion) is embedded by `tauri-build` from `src-tauri/tauri.conf.json` so the binary is ready for Authenticode signing later. Do not pack with UPX or any runtime DLL downloader — antivirus false positives.

Local release builds also need the updater signing key (updater artifacts are signed at build time):

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "keys/tauri-updater.key"   # gitignored; never commit
npm run tauri build
```

## Autobuild & updates (CI)

Every push to `main` runs `.github/workflows/build-updates.yml` on a Windows runner: typecheck + tests → libmpv fetch → signed `tauri build` with version `0.1.<run_number>` → upload installers to S3 → rewrite the updater manifest.

S3 layout (bucket):

```
updates/latest.json                                 # Tauri updater manifest
updates/0.1.47/Seans_0.1.47_x64-setup.exe[.sig]     # NSIS — update payload
updates/0.1.47/Seans_0.1.47_x64_en-US.msi[.sig]     # MSI — fresh installs
```

The client checks `https://seans.tedeshi.ru/updates/latest.json`
(`src-tauri/tauri.conf.json` → `plugins.updater.endpoints`) and applies the NSIS package through the OS installer after minisign verification against `plugins.updater.pubkey`.

Repository secrets the workflow needs:

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `keys/tauri-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty (current key has no password) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 keys for the public bucket `seans-update` (not the media keys) |

S3 target is hardcoded in the workflow: `https://s3.buckets.ru`, bucket `seans-update`, region `ru-1`, path-style. Layout: `updates/latest.json` + `updates/<version>/*`. Two provider quirks are already handled in the workflow: path-style addressing (`aws configure set default.s3.addressing_style path`) and disabled flexible checksums (`AWS_REQUEST_CHECKSUM_CALCULATION=when_required` — the API rejects `aws-chunked` CRC32 trailers with `SignatureDoesNotMatch`).

Serving: the `seans.tedeshi.ru` Caddyfile in `D:\projects\tedeshi\seans` reverse-proxies `https://seans.tedeshi.ru/updates/*` → the bucket's public domain `https://0bff548e3a0fce22fa42f4e3c39da76c.bckt.ru/`. Public reads go through that domain only — the path-style API on `s3.buckets.ru` is auth-only, so no bucket policy is needed (the bucket itself is the public one; the media bucket `seans` stays private). Objects are still minisign-signed by the updater.

Versioning: committed `version` in `tauri.conf.json` is the `0.1.x` baseline; CI overrides it per build via `tauri build --config '{"version":"0.1.<run_number>"}'`. Run numbers only grow, so every committed build is a valid update for older installs. To cut a `0.2.0` line, bump the baseline in `tauri.conf.json` + `package.json` + `src-tauri/Cargo.toml`.

The signing keypair is generated once with `npx tauri signer generate -w keys/tauri-updater.key`. Losing the private key breaks updates for shipped builds — keep a backup outside git.

## Player / libmpv

Playback uses **in-process libmpv** (not `mpv.exe`, not a sidecar process).

| | |
|---|---|
| DLLs | `src-tauri/resources/mpv/` at **build time** via `scripts/fetch-mpv.ps1` |
| Ship | `bundle.resources`: `resources/mpv/*` → `mpv/` next to `seans.exe` |
| Load | `LoadLibrary` of the local `libmpv-2.dll` only — never the network |
| Render | mpv `wid` into a Win32 child HWND behind the WebView (overlay HTML controls) |
| HW decode | `hwdec=auto-safe` (d3d11va / dxva2 / nvdec, soft fallback); active mode shown read-only |

```powershell
# Once before the first `tauri dev` / `tauri build` (idempotent, -Force to refresh):
powershell -ExecutionPolicy Bypass -File scripts\fetch-mpv.ps1
```

The script pins a shinchiro mpv-winbuild-cmp archive (URL + SHA256 in the script) and copies `libmpv-2.dll` plus its dependency DLLs into `src-tauri/resources/mpv/`. Run with `-PrintHash` to (re)compute the archive hash after a trusted download and pin it in the script. If `libmpv-2.dll` is missing at runtime the UI shows «Не найден libmpv-2.dll — пересоберите приложение с scripts/fetch-mpv.ps1» — nothing is downloaded on first launch.

AV checklist: no packers, no runtime DLL fetch, nothing written/executed from `%TEMP%`, DLLs are ordinary bundled resources. See `docs/player.md` for the WID/FFI notes.

## Deep links

The app registers the `seans://` scheme (`HKCU\Software\Classes\seans`) and runs as a single instance.

| URL | Action |
|-----|--------|
| `seans://auth/callback?access_token=&state=` | finish web login |
| `seans://room/{code}` | open room (`code` = 8 chars `A–Z2–9`) |
| `seans://` | focus app / Home |

A second launch forwards the URL to the first process via `tauri-plugin-single-instance`.

## Discord RPC

Watching shows up in Discord as a **Listening** activity: media title, episode
(`S01E03 · 22 мин из 42 мин`), a live progress bar and the poster. Inside a
watch-party room the activity also carries a party (`N из 10`, capped per
subscription plan) and a **Присоединиться** button — the friend's Seans starts
and lands in the same room.

| | |
|---|---|
| Application ID | `1565313293747494932` (`src-tauri/src/discord.rs` `DISCORD_APP_ID`) |
| Activity type | `Listening` (one line in `build_activity` to switch to `Watching`) |
| Join secret | `base64url("{user_id}:{room_code}:{nonce}")` |
| Warm join | Discord IPC `ACTIVITY_JOIN` → `#/room/{code}` |
| Cold join | Discord launches `discord-{APP_ID}://…` (registered HKCU protocol) → same pipeline |

Setup in the [Discord Developer Portal](https://discord.com/developers/applications):
set the application name to **Seans** (it renders as «Listening to Seans») and,
optionally, upload a Rich Presence art asset named `seans` (static fallback
when a title has no poster). The whole integration is best-effort — Discord
not running never affects playback.

Posters need **no registration**: the poster URL goes into `large_image` as-is
and Discord's client proxies image URLs sent over RPC automatically (see the
presence docs — `external-assets` is only needed for gateway/headless
presence, not for local RPC). No Discord login or backend support is involved.

## Project layout

```
src-tauri/          # Rust shell (deep-link + single-instance + libmpv player)
  capabilities/     # Tauri 2 permission capabilities
  resources/mpv/    # bundled libmpv-2.dll + deps (fetch-mpv.ps1, build time only)
  src/player/       # libmpv FFI + Win32 `wid` host + Tauri commands
src/
  api/              # typed Seans API client
  features/         # auth, search, media, tasks, library, player, rooms, history, reviews
  screens/          # routed screens (home, login gate, room, player)
  design/           # tokens.css + placeholder UI slots
  lib/              # deep-link parser, route resolver (pure TS)
tests/              # Vitest unit tests
docs/               # API contract notes, compose specs, AV checklist, player.md
```

## API

Base URL: `https://api.seans.tedeshi.ru`  
OpenAPI: `https://api.seans.tedeshi.ru/openapi.json`  
Auth: `Authorization: Bearer <JWT>` (stored in Windows Credential Manager via `keyring`).

## Notes

- UI strings — Russian; identifiers and docs — English.
- No password field in the client: login goes through the web (`seans://auth/callback`).
- Worker/torrent endpoints are not used by this client.

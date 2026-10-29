# Antivirus / Trust Checklist (M11)

Windows Defender (and other AV) heuristics flag packers, temp-dir code drops,
runtime DLL fetches, and unsigned PE oddities. This checklist records the hard
constraints for the Seans Windows client and where each one is satisfied in this
repository. Re-verify every item before a public release build.

## Constraints and how this repo satisfies them

| # | Constraint | How satisfied | Where |
|---|------------|---------------|-------|
| 1 | **No packers** (UPX, Themida, VMProtect, …) | Release profile is plain MSVC codegen + LTO + `strip`; no packer step exists in any build script. | `src-tauri/Cargo.toml` `[profile.release]`, `scripts/*.ps1`, `scripts/*.mjs` |
| 2 | **No runtime DLL / code / script download on first launch** | `libmpv-2.dll` and its deps are fetched at **build time only** by `scripts/fetch-mpv.ps1`, stored under `src-tauri/resources/mpv/`, and packaged via `bundle.resources`. Nothing is downloaded or `LoadLibrary`'d from the network at runtime. | `scripts/fetch-mpv.ps1`, `src-tauri/tauri.conf.json` → `bundle.resources`, `src-tauri/src/player/ffi.rs` |
| 3 | **libmpv loaded only from bundled resources** | Player resolves `libmpv-2.dll` from the app resource dir next to the executable (`mpv/` subfolder produced by `bundle.resources`). No `%TEMP%` path, no search-path hijack. | `src-tauri/src/player/`, `src-tauri/resources/mpv/README.md` |
| 4 | **Clean VersionInfo** | `tauri-build` embeds PE VersionInfo from `tauri.conf.json`: `CompanyName=bundle.publisher`, `ProductName`, `FileVersion`/`ProductVersion=version`, `LegalCopyright=bundle.copyright`. Do not post-process or blank these fields. | `src-tauri/tauri.conf.json` `bundle.publisher` / `bundle.copyright` / `version`, `src-tauri/build.rs` |
| 5 | **Never write / execute code from `%TEMP%`** | Application code never drops, unpacks, or `LoadLibrary`s payloads from temp. All native code is either linked into `seans.exe` or bundled as a resource. The updater (see note below) hands a signed installer package to the Windows installer — it does not `LoadLibrary` temp DLLs into the process. | `src-tauri/src/player/`, `src/features/updater/`, `docs/av-checklist.md` (updater note) |
| 6 | **No process injection** | No `CreateRemoteThread`, `WriteProcessMemory` on foreign processes, `SetWindowsHookEx` global hooks, or APC injection anywhere. The player renders into a **child window of our own process** (`--wid`), which is in-process composition, not injection. | `src-tauri/src/player/host.rs`, `src-tauri/src/player/session.rs` |
| 7 | **PE stays Authenticode-signable** | Plain PE (no packer/protector, no overlay obfuscation). `seans.exe` and the NSIS/MSI installers can be signed later with `signtool` without rebuilding. Out of scope for v1: purchasing the certificate. | this checklist, `docs/compose/spec/v1-client.md` (out of scope) |
| 8 | **Updater does not bypass the OS installer** | `tauri-plugin-updater` downloads the release package from the configured HTTPS endpoint and applies it via the same NSIS/MSI installer the user originally installed with. Updates are not hot-patched into the running EXE and no third-party binary is executed outside the installer chain. | `src-tauri/tauri.conf.json` `plugins.updater`, `src/features/updater/` |
| 9 | **No obfuscation / anti-debug tricks** | TypeScript is compiled normally (Vite/esbuild minify is standard bundling, not a packer). Rust is LTO-optimized but not obfuscated. No anti-debug, no time bombs, no self-delete. | `vite.config.ts`, `src-tauri/Cargo.toml` |
| 10 | **HTTPS-only update endpoint** | `plugins.updater.endpoints` is `https://seans.tedeshi.ru/...` (TLS). No plaintext update channels. | `src-tauri/tauri.conf.json` |
| 11 | **Protocol handlers are own-app launchers only** | Two HKCU `Software\Classes` URL protocols, both standard launchers (no service, no hijacking of foreign schemes): `seans` (deep links, registered by `tauri-plugin-deep-link`) and `discord-{APP_ID}` (Discord Join cold-start, a clone of discord-rpc's `Discord_Register` — command is our own exe with `"%1"`). Written on every startup, HKCU only. | `src-tauri/src/discord.rs` `register_discord_launcher`, `src-tauri/src/lib.rs` |

### Updater note (temp directory and installers)

Windows installers (NSIS/MSI) necessarily stage their payload while installing;
that is the OS installer model and is applied elevated as a proper installer
package — the same path every MSI-based product uses. The distinction we
enforce is:

- **Never** (app code): write a DLL/script to `%TEMP%` and execute or load it
  from there at runtime (classic AV heuristic hit).
- **Allowed** (OS installer): `tauri-plugin-updater` downloads the release
  installer to a system temp location and **hands off to the Windows
  installer**, which replaces the app under `Program Files` and can be
  Authenticode-signed like the original install.

When a release signing key is configured (`TAURI_SIGNING_PRIVATE_KEY` +
matching `plugins.updater.pubkey`), the updater also verifies an ed25519
signature over the downloaded package before the installer runs.

## PE VersionInfo fields expected

Embedded by `tauri-build` from `src-tauri/tauri.conf.json`. Verify with
`signtool verify /pa` and PowerShell
`(Get-Item seans.exe).VersionInfo` after each release build.

| Field | Expected value | Source |
|-------|----------------|--------|
| CompanyName | `tedeshi` | `bundle.publisher` |
| ProductName | `Seans` | `productName` |
| FileDescription | `Seans` | `productName` |
| FileVersion | `0.1.0` (matches release) | `version` |
| ProductVersion | `0.1.0` (matches release) | `version` |
| LegalCopyright | `tedeshi` | `bundle.copyright` |

Do not leave any of these empty or filler (`TODO`, `Example`, `Unknown`) —
blank VersionInfo is a common Defender/SmartScreen reputation signal.

## What NOT to do

- **Do not pack** with UPX, Themida, VMProtect, ASProtect, or any runtime
  cryptor/protector.
- **Do not download or `LoadLibrary` DLLs / scripts from the network at
  runtime** — including "just for the player". Fetch at build time
  (`scripts/fetch-mpv.ps1`) and bundle via `bundle.resources`.
- **Do not write and execute code from `%TEMP%`** (drop a `.dll`/`.js`/`.ps1`
  and run/load it) in application code.
- **Do not inject into other processes** (`CreateRemoteThread`,
  `WriteProcessMemory`, `SetWindowsHookEx` on foreign processes, APC/DLL
  injection, process hollowing).
- **Do not add Defender exclusions** or document "add an exclusion" as a fix —
  ship clean binaries instead.
- **Do not strip, spoof, or blank PE VersionInfo**.
- **Do not self-update by replacing `seans.exe` in place from app code** —
  always go through `tauri-plugin-updater` → NSIS/MSI.
- **Do not disable or spoof code-signing checks**, and do not ship with a
  self-signed cert presented as trusted.
- **Do not obfuscate** the JS/Rust payload or add anti-debug / VM detection
  tricks.
- **Do not execute anything from the browser download cache or `Downloads`**.

## Manual Windows 11 clean-install + Defender smoke (template)

Run on a **fresh Windows 11 VM** (or a machine that has never seen Seans)
before each public release. Fill in the result column.

| Step | Action | Expected | Result |
|------|--------|----------|--------|
| 1 | Snapshot the clean VM (Defender defaults, no exclusions) | Baseline recorded | |
| 2 | `Get-MpComputerStatus` → note `RealTimeProtectionEnabled: True` | Defender active | |
| 3 | Copy the built `seans-<version>-x64-setup.exe` (NSIS) into the VM (shared folder / ISO — not a browser download, to isolate SmartScreen) | File present | |
| 4 | `Get-FileHash seans-*.exe -Algorithm SHA256` and record the hash | Hash recorded for the release notes | |
| 5 | Run the installer as a normal user | NSIS installs to `%LOCALAPPDATA%\Programs\Seans` (or per-user default); no Defender alert | |
| 6 | First launch | App opens; login screen; **no** outbound fetch of DLLs (check firewall/procmon if paranoid: only `api.seans.tedeshi.ru` + `seans.tedeshi.ru`/update endpoint) | |
| 7 | Sign in, play a short MKV (HEVC + ASS) and a MP4 (H.264 + AAC) | Playback works; libmpv loaded from install dir `mpv\libmpv-2.dll` (verify in Process Explorer modules) | |
| 8 | `Get-MpThreatDetection` after the session | No detections | |
| 9 | Settings → «Проверить обновления» with the endpoint 404 (dev) or a staged update (release) | Dev: silent "no update"/error copy; Release: banner «Доступно обновление», background download, «Перезапустить сейчас» applies and relaunches into the new version | |
| 10 | After an update apply: run `signtool verify /pa seans.exe` (once signing exists) and re-check VersionInfo | Signature valid (when signed); VersionInfo fields intact | |
| 11 | Optional deep scan: `Start-MpScan -ScanType FullScan` on the install dir | No threats | |
| 12 | Uninstall from Settings → Apps | Removes the app; no leftover executable in `%TEMP%` | |

### Release-build extras (when Authenticode is purchased)

1. `npm run build` then `npm run tauri build` with `TAURI_SIGNING_PRIVATE_KEY`
   set (updater artifacts) and the private code-signing cert available.
2. Sign `seans.exe` (inside the installer) and the NSIS/MSI installers:
   `signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ...`
3. `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` is already pinned to
   the release key (private half: `keys/tauri-updater.key` locally / the
   `TAURI_SIGNING_PRIVATE_KEY` CI secret — never committed).
4. Publish the update JSON + artifacts to `updates/` on S3 so
   `https://seans.tedeshi.ru/updates/latest.json` resolves (done by
   `.github/workflows/build-updates.yml` on every push to main).
5. Re-run the Defender smoke table above on the signed binaries.

## References in this repo

- Updater wiring: `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`,
  `src-tauri/tauri.conf.json` (`plugins.updater`), `src/features/updater/`
- Bundled player DLLs: `scripts/fetch-mpv.ps1`, `src-tauri/resources/mpv/`
- VersionInfo: `src-tauri/build.rs`, `src-tauri/tauri.conf.json`
  (`bundle.publisher`, `bundle.copyright`, `version`)
- Product constraints: `docs/compose/spec/v1-client.md` (M11 / AV rules)

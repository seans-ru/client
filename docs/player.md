# Player / libmpv (M7)

In-process playback notes for the Seans Windows client. Product constraints:
no packers, **no runtime DLL download**, bundled `libmpv-2.dll` only.

## Rendering strategy: `wid` (chosen) vs `mpv_render_context`

v1 uses the **`wid`** option: libmpv creates/owns rendering inside a Win32
child window (`STATIC` class) whose HWND is passed to `mpv_set_option("wid")`
**before** `mpv_initialize`.

| | `wid` child HWND | `mpv_render_context` + D3D11 |
|---|---|---|
| Complexity | low (CreateWindowEx + MoveWindow) | high (swapchain, format, resize) |
| Overlay UI | HTML on top of the child (webview sibling Z-order) | must composite / separate view |
| Resize | `MoveWindow` on parent resize | re-create / resize swapchain |
| Fallback needed | no | not for v1 |

If `wid` proves fragile on a target GPU/driver, the documented fallback is
`mpv_render_context` + D3D11 into a shared texture — out of scope for M7.

Z-order: the host child is placed at `HWND_BOTTOM` among the main window's
children so WebView2 (transparent on the player route) draws overlay controls
above the video. `app-fullbleed.player-surface` keeps a transparent background.

## DLL layout and loading

```
seans.exe
mpv/libmpv-2.dll      ← bundle.resources: "resources/mpv/*": "mpv/"
mpv/<ffmpeg deps>.dll
```

`scripts/fetch-mpv.ps1` (build/dev time only) downloads a pinned shinchiro
mpv-winbuild-cmp archive and copies every `*.dll` into
`src-tauri/resources/mpv/`, normalizing `mpv-2.dll` → `libmpv-2.dll`.
Idempotent; `-Force` refreshes; `-PrintHash` pins SHA256.

Runtime load (`src-tauri/src/player/ffi.rs`):

1. `locate_mpv_dir()` probes `exe_dir/mpv`, `exe_dir`, `exe_dir/resources/mpv`,
   `cwd/src-tauri/resources/mpv` (dev) for `libmpv-2.dll`.
2. `libloading::Library::new` on that **local path only** — never a network URL,
   never `%TEMP%`.
3. Missing file → «Не найден libmpv-2.dll — пересоберите приложение с scripts/fetch-mpv.ps1».

## HW decode

`hwdec=auto-safe` (d3d11va / dxva2 / nvdec order, automatic software fallback).
The active decoder is read from `hwdec-current` and exposed read-only on the
player overlay (`formatHwdec`) for the future Settings screen.

## Events

`player://state` carries a `PlayerSnapshot` (serde → JSON):
`position`, `duration`, `pause`, `eof`, `error`, `tracks`, `hwdec`, `speed`,
`volume`, `mute`, `fullscreen`, `idle`, `file_loaded`, `url`.

The mpv event thread observes `time-pos` / `duration` / `pause` / `eof-reached` /
`track-list` / `hwdec-current` / `speed` / `volume` and throttles position
emits to ~4/s. `MPV_EVENT_END_FILE` with reason `ERROR` sets
«Не удалось открыть файл».

## Commands

`player_open(url, start_at?, hwnd_hint?)`, `player_play`, `player_pause`,
`player_toggle_pause`, `player_seek`, `player_set_speed` (0.25–2.0),
`player_set_volume`, `player_set_mute`, `player_set_audio_track`,
`player_set_subtitle_track`, `player_list_tracks`, `player_set_fullscreen`,
`player_toggle_fullscreen`, `player_get_state`, `player_destroy`,
`player_sync_size`.

Media URLs come from JS (`fetchFileUrl` → presigned); the Rust side does not
call the Seans API and does not fetch DLLs.

## Resume hook (M9)

`openPlayer(fileId, { startAt })` (features/player/playerNav.ts) navigates to
`#/player/:fileId` and stashes `startAt` in sessionStorage
(`seans.player.startAt`). PlayerScreen consumes it once per file id.

## Progressive playback (incomplete downloads)

While the backend is still assembling a file into S3, the client plays the
**contiguous seekable prefix** only. Source of truth is
`GET /api/media/{id}/playback` → `stream.max_seekable_bytes`
(fallback: `index.json.contiguous_bytes`). Even if a later segment becomes
available on S3, seeks past the last reported prefix stay blocked until the
next poll (5–7 s) updates the ceiling.

| Mode | `stream` | Transport |
|------|----------|-----------|
| VOD | `complete` | presigned file URL (`/api/files/{id}/url` or `video.url`) |
| Progressive | `ready && !complete` | loopback range server (`src-tauri/src/progressive/`) |
| Waiting | `!ready` | no open yet — «Готовим первые сегменты…» |

The loopback server binds `127.0.0.1:0`, maps HTTP Range requests onto
`segments[i].url` GETs, and **clips every response to `max_seekable_bytes`**.
JS also clamps seeks (`checkSeek`) and Rust `player_seek` honors
`player_set_max_seekable` as a second guard.

UI:
- Seek rail zones: downloaded (mid teal) · seekable (light teal) · future (grey).
- Dual progress: «Скачано» = `percent_downloaded`, «Доступно» = `percent_seekable`
  (they differ on non-sequential download).
- Scrub into the grey zone → toast «Этот момент ещё скачивается» (request is
  not sent).
- Hitting the prefix edge during playback → pause «Загрузка продолжается…»;
  auto-resume when the prefix grows (position is never scrolled backwards).
- `complete` mid-watch → seamless switch to the full file at the same position.

### Multi-audio

`audio_tracks[]` flags drive the Russian label:
`["dub"]` → «Русский дубляж», `["voice"]` → «Многоголосый`,
`["studio_dub"]` → studio title, `["one_voice"]` → «Одноголосый`,
`["original"]` → «Оригинал», `["dual_audio"]` → «Dual/Multi».

- `embedded=true` — switch container track (`aid`).
- `embedded=false` — external ac3/m4a attached via mpv `audio-files` at open.
- Selection is persisted per media item / per episode
  (`seans.audio.episode.{mediaId}.{fileId}`, default product scope).

### Series

Catalog from `catalog.groups[]` or `files[]`. Picker labels `SxxEyy`
(multi-episode packs `S01E03–E05`). Episodes without `has_primary_video`
are disabled («загружается») — no Play.

Known limitation: mp4 without faststart may not expose duration/seek index
until more of the file arrives; seek stays limited to the contiguous prefix
(remux is out of scope for v1).

## Smoke test (manual, parent)

- HEVC + ASS subtitles in `.mkv` (embedded subs, audio track switch).
- H.264 + AAC in `.mp4` (seek, speed 0.25–2, fullscreen).
- Missing DLL build: clear `resources/mpv/`, expect the rebuild hint error.
- Progressive: start a download, open the player at ~5%, seek only the teal
  zones; grey-zone scrub shows the toast; at the edge the player pauses and
  resumes when `percent_seekable` grows; after `complete` seeking is free.
- Multi-audio: switch dub/voice/original for a movie and an episode; reopen
  the episode and confirm the preference stuck.

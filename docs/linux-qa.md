# Linux build, release, and manual QA

This checklist covers the Linux desktop port tracked in issues #37–#41. The
AppImage and updater workflow targets x86_64. The platform-independent
`player_*` commands and loopback frame-stream contract should remain the same
as on Windows.

## Local development

On a supported Linux desktop with Tauri's GTK/WebKit development packages and
the Linux `libmpv` runtime selected by the port:

```sh
npm ci
npm run tauri dev
```

Record the output of `echo "$XDG_CURRENT_DESKTOP / $XDG_SESSION_TYPE"` and
`uname -a` with any issue. For graphics context, record `glxinfo -B` where
available. For decoder diagnostics, use `vainfo` on Intel/AMD or `nvidia-smi`
on NVIDIA and note the active decoder shown in the player's diagnostics.

The signed AppImage is built in CI on `ubuntu-latest`. The job installs Tauri's
GTK/WebKit, app-indicator, SVG, X11 automation, FUSE, and linker dependencies,
then runs `tauri build --bundles appimage` with the updater signing key. It
uploads the AppImage and its `.sig` sidecar; a publish job combines those with
the Windows artifacts and writes both `linux-x86_64` and `windows-x86_64`
entries into `latest.json`. The `.deb`/`.rpm` targets are intentionally omitted:
the Linux in-app updater is for AppImage installs.

## Manual desktop matrix

Run the same short playback scenario on each available session. Keep the source
file, resolution, and duration fixed so readback measurements can be compared.

| Desktop/session | Window + playback | Deep links / integrations | Record |
| --- | --- | --- | --- |
| GNOME / Wayland | Login, open a 1080p H.264 file, seek, resize, fullscreen, close/reopen | Browser OAuth callback; open a `seans://` room link | Mesa/GPU, `hwdec-current`, dropped/stalled frames |
| GNOME / X11 | Repeat the same playback steps | Discord Join into a room | Mesa/GPU, `hwdec-current`, dropped/stalled frames |
| KDE Plasma / Wayland | Repeat; move between displays if available | Browser OAuth callback and `seans://` | Mesa/GPU, `hwdec-current`, dropped/stalled frames |
| KDE Plasma / X11 | Repeat the same playback steps | Discord Join into a room | Mesa/GPU, `hwdec-current`, dropped/stalled frames |

For at least one session, repeat at 100% and 150% scaling, then with the
application moved between monitors using different scale factors. Check that
the canvas remains aligned with the video area, controls remain clickable, and
fullscreen/resize does not leave a stale-sized frame surface.

## Frame readback and resource sample

Start playback and copy the `[player] frame stream endpoint` URL from the
application terminal. The endpoint is a continuous raw-frame stream, so a
bounded transfer gives the approximate readback-plus-loopback throughput:

```sh
FRAME_URL='http://127.0.0.1:PORT/frames'
set +e
curl --max-time 30 --silent "$FRAME_URL" -o /dev/null \
  -w 'received=%{size_download} bytes elapsed=%{time_total}s rate=%{speed_download} B/s\n'
status=$?
set -e
test "$status" -eq 28 # expected: curl stopped at the 30-second limit
```

During the same sample, record the process CPU and memory once per second
(`pidstat -p "$(pgrep -n seans)" 1`, if `sysstat` is installed). Note the
video resolution, display scale, and source frame rate. Compare against the
1080p24 target of roughly 200 MB/s in `docs/porting.md`; use the delivered
frame-stream resolution rather than the media file's encoded resolution.

The app logs the dynamically selected loopback URL only while playback starts.
It never binds outside `127.0.0.1`. A successful run should deliver frames
continuously, keep controls responsive, and stop the stream when playback
ends. Check logs for `frame client connected`, player errors, and GTK/WebKit
warnings.

For hardware decoding, cover Intel/AMD VA-API, NVIDIA proprietary NVDEC, and
software fallback when machines are available. Confirm playback starts even
when hardware decoding is unavailable, and record the decoder name exposed by
the player (`no` means software decode).

## AppImage and updater verification

On the Linux CI artifact:

1. Confirm the `.AppImage` and matching `.AppImage.sig` exist and the manifest
   has a `linux-x86_64` URL under the versioned `linux/` directory.
2. Install and launch the AppImage on a clean Ubuntu-based desktop. Check that
   the desktop entry opens the app and playback starts.
3. Publish a higher-version signed build to a staging update endpoint, check
   for the update, install it, and verify the restarted app reports the new
   version. Do not use production `latest.json` for a test release.
4. Confirm the Windows NSIS/MSI assets and `windows-x86_64` manifest entry are
   still published from the same workflow run.

AppImage installation, the full four-session desktop matrix, mixed-DPI
multi-monitor behavior, and GPU-vendor comparisons require Linux machines and
remain manual QA. Review the existing glib Dependabot alert in GitHub Security
after Linux CI compiles GTK/WebKit; this checklist does not change the alert's
status.

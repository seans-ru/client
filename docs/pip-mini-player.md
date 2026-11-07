# Mini-player / PiP: design and prototype

Issue: [#24](https://github.com/seans-ru/client/issues/24)

Status: design and in-window prototype. This is a review artifact, not the
production PiP implementation. The prototype is registered as a normal player
extension and can be removed without changing the playback core.

## Decision

Choose **an in-window mini-player overlay** for phase 1. It keeps using the
current player session and its guarded transport, so there is one decoder,
one audio timeline, and no second source open. It can be implemented in the
existing TS extension layer. It is always above the video and player chrome
inside the application window, but it cannot stay above other applications.

Phase 2 may evaluate a native Tauri window once the prototype is reviewed.
Windows Compact Overlay is not part of this implementation.

## Options

| Option | What it provides | Cost and constraints | Decision |
| --- | --- | --- | --- |
| In-window overlay | Draggable mini view over the current video; same transport and audio session; simple close and position restore | Visible only while the player surface exists; does not survive minimizing the application; current prototype mirrors the rendered canvas | **Prototype now** |
| Separate Tauri window | True topmost window over other apps, can remain visible while the main window is covered | Requires a second webview/window lifecycle, bounds persistence, focus/close coordination, and a supported way to present the active mpv frames in another window. A DOM canvas cannot simply be shared across webviews; copying frames across windows adds bandwidth and latency. | Revisit after an explicit cross-platform render-surface design; do not rebind mpv/WGL in this issue |
| Windows Compact Overlay | Windows-managed compact view that can float over other apps | Windows-specific API and lifecycle; not portable to macOS/Linux/Android. It still needs a supported video presentation surface and a separate platform implementation. | Reject for the shared player feature |

## Prototype behavior

- Open/close from the playback settings menu. The mini-player appears over the
  video and remains above the transport and other overlays.
- Drag by the title strip. The normalized position is stored per app window and
  restored on the next open; bounds are clamped when the surface is resized.
- Play/pause and ±10 s seek use `ctx.transport`, which is the same guarded
  transport as the main controls. Progressive seek limits and room behavior
  therefore remain in force.
- The mini view mirrors the current rendered canvas at up to 15 frames/s. It
  does not open another stream or mpv session.
- Closing the current source closes the mini-player. Closing the mini-player
  never stops playback.
- Audio, subtitle selection, speed, and fullscreen remain owned by the main
  player. The mini-player has no separate audio or subtitle state.

## Playback and window cases

| Case | Expected behavior |
| --- | --- |
| Audio | Continues in the single existing mpv session. No audio is copied or restarted. |
| Subtitles | The mirrored picture contains whatever the existing renderer paints; subtitle-track selection stays in the main settings menu. |
| Controls | Mini play/pause and seek call the guarded extension transport. Other settings remain in the main controls. |
| Resize | Position is clamped to the video-area bounds; video keeps a 16:9 box. |
| Minimize main app | In-window overlay is hidden with the app. True cross-app always-on-top requires the separate-window phase. |
| Fullscreen | The overlay remains attached to the video area and above its controls. |
| Source close / switch | Source close hides the overlay; a newly opened source can reopen it from settings. |
| Performance | Canvas copy is capped at 15 fps and only runs while the mini-player is open. It adds a small canvas draw cost and no additional decoder or frame stream. |

## Prototype boundary and phase 2

This prototype reads the existing `.player-video-canvas` from the overlay slot
and copies it into a small 2D canvas. That DOM lookup is intentionally a
prototype seam: the extension contract exposes downsampled `FrameSample`s for
analysis, not full-resolution frames for a second renderer. Do not silently
raise that API's bandwidth for production. If a separate window is approved,
first agree on a cross-platform render-surface/frame-presentation contract
with the porting work, then measure frame-copy cost and latency on Windows,
macOS, and Linux. No Rust, FFI, player command, or frame-wire contract changes
are part of this issue.

## Acceptance checklist

- [x] Compare the three implementation options and record a decision.
- [x] Record audio, subtitles, controls, resize, minimize, fullscreen, and
  performance behavior.
- [x] Provide a minimal registered TS extension prototype with mirrored
  video, play/pause, seek, close, and persisted position.
- [ ] Review prototype and design with maintainers before opening a separate
  production implementation issue.

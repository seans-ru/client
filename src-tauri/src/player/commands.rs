//! Tauri commands for the libmpv player (M7).
//!
//! All commands are local: media URLs are supplied by the frontend after
//! `fetchFileUrl` (presigned), and the DLL is loaded only from bundled
//! resources next to `seans.exe`. No network I/O and no runtime DLL download.

use tauri::AppHandle;

use super::session::{self, PlayerSnapshot, TrackInfo};

/// Start playback of `url` in the embedded libmpv surface.
///
/// * `start_at` — optional resume position in seconds (M9 history hook).
/// * `hwnd_hint` — optional override HWND; normally omitted (child host window
///   is created automatically as a child of the main Tauri window).
/// * `external_audio_urls` — extra audio files (non-embedded tracks, ac3/m4a).
/// * `max_seekable_sec` — progressive ceiling; seeks are clamped to this.
#[tauri::command]
pub fn player_open(
    app: AppHandle,
    url: String,
    start_at: Option<f64>,
    hwnd_hint: Option<i64>,
    external_audio_urls: Option<Vec<String>>,
    max_seekable_sec: Option<f64>,
) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err(super::ffi::OPEN_FAILED_ERROR.to_string());
    }
    let parent = match hwnd_hint {
        Some(h) if h != 0 => h as isize,
        _ => session::main_window_hwnd(&app)?,
    };
    session::set_max_seekable_sec(max_seekable_sec);
    session::open(app, url, parent, start_at, external_audio_urls.unwrap_or_default())
}

#[tauri::command]
pub fn player_play() -> Result<(), String> {
    session::play()
}

#[tauri::command]
pub fn player_pause() -> Result<(), String> {
    session::pause()
}

#[tauri::command]
pub fn player_toggle_pause() -> Result<(), String> {
    session::toggle_pause()
}

/// Absolute seek to `seconds` (clamped to the media duration).
#[tauri::command]
pub fn player_seek(seconds: f64) -> Result<(), String> {
    session::seek(seconds)
}

/// Set playback speed, clamped to 0.25–2.0.
#[tauri::command]
pub fn player_set_speed(speed: f64) -> Result<(), String> {
    session::set_speed(speed)
}

#[tauri::command]
pub fn player_set_volume(volume: f64) -> Result<(), String> {
    session::set_volume(volume)
}

#[tauri::command]
pub fn player_set_mute(mute: bool) -> Result<(), String> {
    session::set_mute(mute)
}

/// Select an audio track by id (`<= 0` disables audio).
#[tauri::command]
pub fn player_set_audio_track(id: i64) -> Result<(), String> {
    session::set_audio_track(id)
}

/// Select a subtitle track by id; `null` / `<= 0` turns subtitles off.
#[tauri::command]
pub fn player_set_subtitle_track(id: Option<i64>) -> Result<(), String> {
    session::set_subtitle_track(id)
}

#[tauri::command]
pub fn player_list_tracks() -> Result<Vec<TrackInfo>, String> {
    session::list_tracks()
}

#[tauri::command]
pub fn player_set_fullscreen(app: AppHandle, enabled: bool) -> Result<(), String> {
    session::set_fullscreen(&app, enabled)
}

#[tauri::command]
pub fn player_toggle_fullscreen(app: AppHandle) -> Result<(), String> {
    session::toggle_fullscreen(&app)
}

#[tauri::command]
pub fn player_get_state() -> Result<PlayerSnapshot, String> {
    Ok(session::current_state())
}

/// Release the libmpv session and the child host window (route leave / close).
#[tauri::command]
pub fn player_destroy() -> Result<(), String> {
    session::destroy();
    // Progressive source is per-open; drop it with the player.
    crate::progressive::stop();
    Ok(())
}

/// Progressive seek ceiling in seconds (`None` clears it → full VOD range).
/// Transport-level guard so seeks past `max_seekable_bytes` never reach mpv.
#[tauri::command]
pub fn player_set_max_seekable(seconds: Option<f64>) -> Result<(), String> {
    session::set_max_seekable_sec(seconds);
    Ok(())
}

/// Video-area rectangle measured in the DOM (client-relative physical px).
#[derive(Debug, serde::Deserialize)]
pub struct SyncRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Size the offscreen render target to the DOM video area.
///
/// With `rect`: use its physical-pixel size (x/y ignored — the canvas fills
/// the video area in the DOM). Without `rect`: re-apply the last known size.
#[tauri::command]
pub fn player_sync_size(rect: Option<SyncRect>) -> Result<(), String> {
    match rect {
        Some(r) => {
            if r.width.is_finite() && r.height.is_finite() && r.width >= 1.0 && r.height >= 1.0 {
                session::sync_host_rect(
                    r.x.round() as i32,
                    r.y.round() as i32,
                    r.width.round() as i32,
                    r.height.round() as i32,
                );
            }
        }
        None => session::sync_host_size(),
    }
    Ok(())
}

/// Loopback URL of the raw frame stream for the page canvas
/// (`http://127.0.0.1:<port>/frames`).
#[tauri::command]
pub fn player_frames_url() -> Result<String, String> {
    super::frames::ensure_started()
}

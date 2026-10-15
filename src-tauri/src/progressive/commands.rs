//! Tauri commands for the progressive playback source (local range server).

use super::{segments_from_json, start, update, ProgressiveConfig, SegmentSpec};

/// Start the loopback range server for a still-downloading file.
///
/// Returns the local URL to pass to `player_open` (`http://127.0.0.1:<port>/`).
#[tauri::command]
pub fn progressive_start(
    size_bytes: u64,
    max_seekable_bytes: u64,
    segments: Vec<serde_json::Value>,
) -> Result<String, String> {
    if size_bytes == 0 {
        return Err("size_bytes must be > 0".to_string());
    }
    let config = ProgressiveConfig {
        size_bytes,
        max_seekable_bytes: max_seekable_bytes.min(size_bytes),
        segments: segments_from_json(&segments),
    };
    start(config)
}

/// Update the contiguous seekable prefix after a playback/index poll.
///
/// `segments` / `size_bytes` are optional refreshes (rotated signed URLs).
#[tauri::command]
pub fn progressive_update(
    max_seekable_bytes: u64,
    segments: Option<Vec<serde_json::Value>>,
    size_bytes: Option<u64>,
) -> Result<(), String> {
    let segs = segments.map(|v| segments_from_json(&v));
    update(max_seekable_bytes, segs, size_bytes)
}

/// Stop and release the progressive source (route leave / complete → VOD).
#[tauri::command]
pub fn progressive_stop() {
    super::stop();
}

/// Current seekable ceiling in bytes (diagnostics / tests).
#[tauri::command]
pub fn progressive_max_seekable() -> u64 {
    super::current_max_seekable()
}

/// Helper for callers that already have typed segments.
#[allow(dead_code)]
pub fn typed_segments(specs: Vec<SegmentSpec>) -> Vec<SegmentSpec> {
    specs
}

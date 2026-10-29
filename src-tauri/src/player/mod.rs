//! In-process libmpv player (M7 / frame-stream).
//!
//! - DLLs are **bundled resources** (`src-tauri/resources/mpv/` → `mpv/` next
//!   to `seans.exe` via `bundle.resources`). Populated at build time by
//!   `scripts/fetch-mpv.ps1`. Never downloaded at runtime (AV policy).
//! - Rendering: `vo=libmpv` into an offscreen GL target (`gl.rs`), frames are
//!   streamed to the page canvas (`frames.rs`) so HTML chrome can overlay the
//!   video without Win32/WebView2 z-order conflicts.
//! - HW decode: `hwdec=auto-safe` (d3d11va / dxva2 / nvdec with soft fallback).
//! - Errors are surfaced to JS as Russian strings («Не удалось открыть файл»,
//!   missing DLL → rebuild hint). No infinite spinner.

pub mod commands;
pub mod ffi;
pub mod frames;
pub mod gl;
pub mod host;
pub mod session;

use std::sync::{Arc, OnceLock};

pub use commands::*;

use ffi::MpvApi;

/// Cached `MpvApi` (LoadLibrary once per process).
fn api_cache() -> &'static OnceLock<Arc<MpvApi>> {
    static CACHE: OnceLock<OnceLock<Arc<MpvApi>>> = OnceLock::new();
    CACHE.get_or_init(OnceLock::new)
}

/// Load (or reuse) the bundled libmpv-2.dll from the resource directory.
pub fn load_api() -> Result<Arc<MpvApi>, String> {
    if let Some(api) = api_cache().get() {
        return Ok(api.clone());
    }
    let dir = ffi::locate_mpv_dir().ok_or_else(|| ffi::MISSING_DLL_ERROR.to_string())?;
    let api = MpvApi::load_from_dir(&dir)?;
    let _ = api_cache().set(api.clone());
    Ok(api)
}

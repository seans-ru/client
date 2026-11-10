//! In-process libmpv player (M7 / frame-stream).
//!
//! - Windows loads a build-time bundled DLL; Linux loads system `libmpv.so.2`.
//!   Neither platform downloads native libraries at runtime.
//! - Rendering: `vo=libmpv` into an offscreen GL target (`gl`), frames are
//!   streamed to the page canvas (`frames.rs`) so HTML chrome can overlay the
//!   video without Win32/WebView2 z-order conflicts.
//! - HW decode: `hwdec=auto-safe` with software fallback (VA-API/NVDEC on Linux).
//! - Errors are surfaced to JS as Russian strings («Не удалось открыть файл»,
//!   missing library → platform-specific install hint). No infinite spinner.

pub mod commands;
pub mod ffi;
pub mod frames;
#[cfg(windows)]
pub mod gl;
#[cfg(target_os = "linux")]
#[path = "gl_linux.rs"]
pub mod gl;
#[cfg(windows)]
pub mod host;
#[cfg(target_os = "linux")]
#[path = "host_linux.rs"]
pub mod host;
pub mod session;

use std::sync::{Arc, OnceLock};

pub use commands::*;

use ffi::MpvApi;

/// Cached `MpvApi` (loaded once per process).
fn api_cache() -> &'static OnceLock<Arc<MpvApi>> {
    static CACHE: OnceLock<OnceLock<Arc<MpvApi>>> = OnceLock::new();
    CACHE.get_or_init(OnceLock::new)
}

/// Load (or reuse) the platform libmpv instance.
pub fn load_api() -> Result<Arc<MpvApi>, String> {
    if let Some(api) = api_cache().get() {
        return Ok(api.clone());
    }
    #[cfg(windows)]
    let api = {
        let dir = ffi::locate_mpv_dir().ok_or_else(|| ffi::MISSING_DLL_ERROR.to_string())?;
        MpvApi::load_from_dir(&dir)?
    };
    #[cfg(target_os = "linux")]
    let api = MpvApi::load_from_system()?;
    let _ = api_cache().set(api.clone());
    Ok(api)
}

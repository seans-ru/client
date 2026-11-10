//! Linux has no native video child window in the frame-stream player.
//! The GL context is created surfaceless (with an EGL pbuffer fallback).

/// Window anchor compatibility shim used by the shared session lifecycle.
pub struct HostWindow;

impl HostWindow {
    pub fn create(_parent: isize) -> Result<Self, String> {
        Ok(Self)
    }

    pub fn fit_parent(&self) {}

    pub fn hwnd(&self) -> isize { 0 }

    pub fn client_size(&self) -> (i32, i32) { (1280, 720) }

    pub fn set_video_rect(&mut self, _x: i32, _y: i32, _width: i32, _height: i32) {}

    pub fn destroy(&mut self) {}
}

pub fn hwnd_from_tauri(_window: &tauri::WebviewWindow) -> Result<isize, String> {
    // The shared command API still carries an opaque platform anchor. Linux's
    // EGL surface ignores it and creates its own context on the render thread.
    Ok(0)
}

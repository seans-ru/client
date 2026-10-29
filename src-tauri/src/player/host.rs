//! Hidden Win32 window anchoring the offscreen GL context (`vo=libmpv`).
//!
//! The window is **never shown**: with the frame stream architecture mpv
//! renders into an offscreen OpenGL target and pixels are shipped to the page
//! canvas, so there is no on-screen HWND to fight WebView2 z-order with.
//! The client size of this window is the GL default framebuffer size, i.e.
//! the frame resolution — `set_video_rect` sizes it; x/y are ignored.
//!
//! Custom window class (`SeansMpvHost`) with `CS_OWNDC` so the DC can hold a
//! pixel format for the WGL context (see `gl.rs`).

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetAncestor, GetClientRect, MoveWindow,
    RegisterClassExW, SendMessageW, CS_OWNDC, GA_ROOT, WINDOW_EX_STYLE, WM_SIZE, WNDCLASSEXW,
    WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_TRANSPARENT,
};

/// Height reserved for the HTML control bar when no DOM video rect has been
/// supplied yet (fallback only — the frontend always sends the real rect).
pub const CONTROL_STRIP_PX: i32 = 160;

const HOST_CLASS: &str = "SeansMpvHost";

static CLASS_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Child host window over which libmpv draws video.
pub struct HostWindow {
    hwnd: HWND,
    parent: HWND,
    /// Last video-area rect from the DOM (client coords, physical px).
    /// `None` → legacy fit: full parent width minus `CONTROL_STRIP_PX`.
    video_rect: Option<(i32, i32, i32, i32)>,
}

fn wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut rect = windows_sys::Win32::Foundation::RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let ok = unsafe { GetClientRect(hwnd, &mut rect) };
    if ok == 0 {
        return (1280, 720);
    }
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    if w > 0 && h > 0 {
        (w, h)
    } else {
        (1280, 720)
    }
}

fn ensure_class_registered() -> Result<(), String> {
    if CLASS_REGISTERED.load(Ordering::SeqCst) {
        return Ok(());
    }
    let class_name = wide_null(HOST_CLASS);
    let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_OWNDC,
        lpfnWndProc: Some(DefWindowProcW),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinstance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: unsafe { GetStockObject(BLACK_BRUSH) },
        lpszMenuName: std::ptr::null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: std::ptr::null_mut(),
    };
    let atom = unsafe { RegisterClassExW(&wc) };
    if atom == 0 {
        // Another thread may have won the race; re-check is enough for our use.
        return Err("player host: RegisterClassExW failed".to_string());
    }
    CLASS_REGISTERED.store(true, Ordering::SeqCst);
    Ok(())
}

impl HostWindow {
    /// Create a child window covering the parent client minus the control strip.
    pub fn create(parent: isize) -> Result<HostWindow, String> {
        let parent = parent as HWND;
        if parent.is_null() {
            return Err("player host: null parent HWND".to_string());
        }

        let root = unsafe { GetAncestor(parent, GA_ROOT) };
        let parent = if root.is_null() { parent } else { root };

        ensure_class_registered()?;

        let (w, h) = client_size(parent);
        let video_h = (h - CONTROL_STRIP_PX).max(1);

        let class_name = wide_null(HOST_CLASS);
        let window_name = wide_null("mpv-host");
        let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };

        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TRANSPARENT as WINDOW_EX_STYLE,
                class_name.as_ptr(),
                window_name.as_ptr(),
                // Never WS_VISIBLE: the window is a GL anchor only.
                WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                0,
                0,
                w,
                video_h,
                parent,
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null(),
            )
        };

        if hwnd.is_null() {
            return Err("player host: CreateWindowExW failed".to_string());
        }

        let host = HostWindow {
            hwnd,
            parent,
            video_rect: None,
        };
        host.fit_parent();
        Ok(host)
    }

    pub fn hwnd(&self) -> isize {
        self.hwnd as isize
    }

    /// Current client size (= GL default framebuffer size).
    pub fn client_size(&self) -> (i32, i32) {
        client_size(self.hwnd)
    }

    /// Re-apply the DOM video rect when one is known; otherwise fall back to
    /// the legacy full-client-minus-control-strip fit.
    pub fn fit_parent(&self) {
        if let Some((x, y, w, h)) = self.video_rect {
            self.resize(x, y, w, h);
            return;
        }
        let (w, h) = client_size(self.parent);
        let video_h = (h - CONTROL_STRIP_PX).max(1);
        self.resize(0, 0, w, video_h);
    }

    /// Size the host to the HTML video area (client-relative physical pixels).
    /// This is the only place the mpv rect is decided — side panels and the
    /// control strip stay visible because the host never covers them.
    pub fn set_video_rect(&mut self, x: i32, y: i32, width: i32, height: i32) {
        self.video_rect = Some((x, y, width, height));
        self.resize(x, y, width, height);
    }

    /// Resize the host to an explicit client-relative rectangle.
    pub fn resize(&self, x: i32, y: i32, width: i32, height: i32) {
        let w = width.max(2);
        let h = height.max(2);
        unsafe {
            MoveWindow(self.hwnd, x, y, w, h, 1);
            SendMessageW(
                self.hwnd,
                WM_SIZE,
                0, /* SIZE_RESTORED */
                ((w as usize & 0xffff) | ((h as usize & 0xffff) << 16)) as isize,
            );
        }
    }

    pub fn destroy(&mut self) {
        if !self.hwnd.is_null() {
            unsafe {
                DestroyWindow(self.hwnd);
            }
            self.hwnd = std::ptr::null_mut();
        }
    }
}

impl Drop for HostWindow {
    fn drop(&mut self) {
        self.destroy();
    }
}

/// Extract the Win32 HWND of a Tauri webview window (main window).
pub fn hwnd_from_tauri(window: &tauri::WebviewWindow) -> Result<isize, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window
        .window_handle()
        .map_err(|e| format!("player host: no window handle ({e})"))?;
    match handle.as_raw() {
        RawWindowHandle::Win32(h) => {
            let ptr = h.hwnd.get() as isize;
            if ptr == 0 {
                Err("player host: null Win32 HWND".to_string())
            } else {
                let root = unsafe { GetAncestor(ptr as HWND, GA_ROOT) };
                if root.is_null() {
                    Ok(ptr)
                } else {
                    Ok(root as isize)
                }
            }
        }
        _ => Err("player host: not a Win32 window".to_string()),
    }
}

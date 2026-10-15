//! Win32 child window used as the mpv `wid` render target (M7).
//!
//! Custom window class (`SeansMpvHost`) with `CS_OWNDC` + black brush so
//! `vo=direct3d` can own the DC and present frames. Parented to the Tauri
//! top-level window, placed `HWND_TOP` above WebView2 (WebView2 D3D occludes
//! sibling children even when its page background is transparent). The bottom
//! `CONTROL_STRIP_PX` stays free for the HTML control bar.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetAncestor, GetClientRect, MoveWindow,
    RegisterClassExW, SendMessageW, SetWindowPos, ShowWindow, CS_OWNDC, GA_ROOT, HWND_TOP,
    SW_SHOW, WINDOW_EX_STYLE, WM_SIZE, WNDCLASSEXW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
    WS_EX_TRANSPARENT, WS_VISIBLE,
};

/// Height reserved for the HTML control bar + skip buttons (webview shows here).
/// The video host sits above this strip; `WS_EX_TRANSPARENT` lets clicks fall
/// through to HTML that happens to overlap the video rect.
pub const CONTROL_STRIP_PX: i32 = 160;

const HOST_CLASS: &str = "SeansMpvHost";

static CLASS_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Child host window over which libmpv draws video.
pub struct HostWindow {
    hwnd: HWND,
    parent: HWND,
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
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
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

        // HWND_TOP: above WebView2. WS_EX_TRANSPARENT: click-through to HTML
        // (skip / controls that sit over the video rect).
        unsafe {
            SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, 0x0013 /* NOSIZE|NOMOVE|NOACTIVATE */);
            ShowWindow(hwnd, SW_SHOW);
        }

        let host = HostWindow { hwnd, parent };
        host.fit_parent();
        Ok(host)
    }

    pub fn hwnd(&self) -> isize {
        self.hwnd as isize
    }

    /// Resize the host to the parent client area minus the HTML control strip.
    pub fn fit_parent(&self) {
        let (w, h) = client_size(self.parent);
        let video_h = (h - CONTROL_STRIP_PX).max(1);
        self.resize(0, 0, w, video_h);
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

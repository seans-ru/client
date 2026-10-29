//! Minimal libmpv FFI (M7).
//!
//! `libmpv-2.dll` is loaded with `LoadLibrary` from a **local** folder next to
//! the executable (bundled resource). Never fetched from the network at runtime.
//! A missing DLL produces the explicit Russian error string expected by the UI.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::Arc;

/// Shown when `libmpv-2.dll` cannot be found next to the app.
pub const MISSING_DLL_ERROR: &str =
    "Не найден libmpv-2.dll — пересоберите приложение с scripts/fetch-mpv.ps1";

/// Shown when libmpv cannot open/play the requested URL.
pub const OPEN_FAILED_ERROR: &str = "Не удалось открыть файл";

/* ------------------------------------------------------------------ formats */

pub const MPV_FORMAT_NONE: c_int = 0;
pub const MPV_FORMAT_STRING: c_int = 1;
pub const MPV_FORMAT_FLAG: c_int = 3;
pub const MPV_FORMAT_INT64: c_int = 4;
pub const MPV_FORMAT_DOUBLE: c_int = 5;
pub const MPV_FORMAT_NODE: c_int = 6;
pub const MPV_FORMAT_NODE_ARRAY: c_int = 7;
pub const MPV_FORMAT_NODE_MAP: c_int = 8;

/* ------------------------------------------------------------------- events */

pub const MPV_EVENT_NONE: c_int = 0;
pub const MPV_EVENT_SHUTDOWN: c_int = 1;
pub const MPV_EVENT_END_FILE: c_int = 7;
pub const MPV_EVENT_FILE_LOADED: c_int = 8;
pub const MPV_EVENT_TRACKS_CHANGED: c_int = 9;
pub const MPV_EVENT_IDLE: c_int = 11;
pub const MPV_EVENT_PAUSE: c_int = 12;
pub const MPV_EVENT_UNPAUSE: c_int = 13;
pub const MPV_EVENT_PLAYBACK_RESTART: c_int = 21;
pub const MPV_EVENT_PROPERTY_CHANGE: c_int = 22;

pub const MPV_END_FILE_REASON_EOF: c_int = 0;
pub const MPV_END_FILE_REASON_STOP: c_int = 2;
pub const MPV_END_FILE_REASON_QUIT: c_int = 3;
pub const MPV_END_FILE_REASON_ERROR: c_int = 4;

/* ----------------------------------------------------------- render API */

/// `mpv_render_param.api_type` value for the OpenGL backend.
pub const MPV_RENDER_API_TYPE_OPENGL: &[u8] = b"opengl\0";

pub const MPV_RENDER_PARAM_INVALID: c_int = 0;
pub const MPV_RENDER_PARAM_API_TYPE: c_int = 1;
pub const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
pub const MPV_RENDER_PARAM_OPENGL_FBO: c_int = 3;
pub const MPV_RENDER_PARAM_FLIP_Y: c_int = 4;

/// `mpv_render_context_update` bit: a new video frame should be rendered.
pub const MPV_RENDER_UPDATE_FRAME: u64 = 1;

#[repr(C)]
pub struct MpvRenderContext {
    _private: [u8; 0],
}

/// `mpv_get_proc_address_fn` — resolve GL entry points for the render API.
pub type MpvGetProcAddressFn =
    unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void;

#[repr(C)]
pub struct MpvOpenGLInitParams {
    pub get_proc_address: Option<MpvGetProcAddressFn>,
    pub get_proc_address_ctx: *mut c_void,
}

/// Render target: FBO 0 = the current GL context's default framebuffer.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MpvOpenGLFbo {
    pub fbo: c_int,
    pub w: c_int,
    pub h: c_int,
    pub internal_format: c_int,
}

#[repr(C)]
pub struct MpvRenderParam {
    pub type_: c_int,
    pub data: *mut c_void,
}

pub type MpvRenderUpdateFn = Option<unsafe extern "C" fn(*mut c_void)>;

/* --------------------------------------------------------------- raw types */

#[repr(C)]
pub struct MpvHandle {
    _private: [u8; 0],
}

#[repr(C)]
pub struct MpvEvent {
    pub event_id: c_int,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct MpvEventProperty {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct MpvEventEndFile {
    pub reason: c_int,
    pub error: c_int,
}

#[repr(C)]
pub union MpvNodeData {
    pub string: *mut c_char,
    pub flag: c_int,
    pub int64: i64,
    pub double: f64,
    pub list: *mut MpvNodeList,
    pub ba: *mut c_void,
}

#[repr(C)]
pub struct MpvNode {
    pub data: MpvNodeData,
    pub format: c_int,
}

#[repr(C)]
pub struct MpvNodeList {
    pub num: c_int,
    pub values: *mut MpvNode,
    pub keys: *mut *mut c_char,
}

/* -------------------------------------------------------- resolved symbols */

type FnCreate = unsafe extern "C" fn() -> *mut MpvHandle;
type FnInitialize = unsafe extern "C" fn(*mut MpvHandle) -> c_int;
type FnTerminateDestroy = unsafe extern "C" fn(*mut MpvHandle);
type FnErrorString = unsafe extern "C" fn(c_int) -> *const c_char;
type FnSetOptionString =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int;
type FnSetOption =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int;
type FnSetPropertyString =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int;
type FnSetProperty =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int;
type FnGetProperty =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int;
type FnCommandRet = unsafe extern "C" fn(
    *mut MpvHandle,
    *const *const c_char,
    *mut MpvNode,
) -> c_int;
type FnObserveProperty = unsafe extern "C" fn(
    *mut MpvHandle,
    u64,
    *const c_char,
    c_int,
) -> c_int;
type FnWaitEvent = unsafe extern "C" fn(*mut MpvHandle, f64) -> *mut MpvEvent;
type FnFree = unsafe extern "C" fn(*mut c_void);
type FnFreeNodeContents = unsafe extern "C" fn(*mut MpvNode);
type FnRenderContextCreate = unsafe extern "C" fn(
    *mut *mut MpvRenderContext,
    *mut MpvHandle,
    *mut MpvRenderParam,
) -> c_int;
type FnRenderContextFree = unsafe extern "C" fn(*mut MpvRenderContext);
type FnRenderContextSetUpdateCallback =
    unsafe extern "C" fn(*mut MpvRenderContext, MpvRenderUpdateFn, *mut c_void);
type FnRenderContextUpdate = unsafe extern "C" fn(*mut MpvRenderContext) -> u64;
type FnRenderContextRender =
    unsafe extern "C" fn(*mut MpvRenderContext, *mut MpvRenderParam) -> c_int;

/// Resolved libmpv entry points. Keeps the `Library` alive for symbol lifetime.
pub struct MpvApi {
    _lib: libloading::Library,
    create: FnCreate,
    initialize: FnInitialize,
    terminate_destroy: FnTerminateDestroy,
    error_string: FnErrorString,
    set_option_string: FnSetOptionString,
    set_option: FnSetOption,
    set_property_string: FnSetPropertyString,
    set_property: FnSetProperty,
    get_property: FnGetProperty,
    command_ret: FnCommandRet,
    observe_property: FnObserveProperty,
    wait_event: FnWaitEvent,
    free: FnFree,
    free_node_contents: FnFreeNodeContents,
    render_context_create: FnRenderContextCreate,
    render_context_free: FnRenderContextFree,
    render_context_set_update_callback: FnRenderContextSetUpdateCallback,
    render_context_update: FnRenderContextUpdate,
    render_context_render: FnRenderContextRender,
}

fn resolve<T: Copy>(lib: &libloading::Library, name: &[u8]) -> Result<T, String> {
    unsafe {
        let sym: libloading::Symbol<T> = lib.get(name).map_err(|_| {
            format!(
                "libmpv-2.dll: missing symbol {}",
                String::from_utf8_lossy(name)
            )
        })?;
        Ok(*sym)
    }
}

impl MpvApi {
    /// Load `libmpv-2.dll` from a local directory (bundled resource).
    pub fn load_from_dir(dir: &Path) -> Result<Arc<MpvApi>, String> {
        let dll = dir.join("libmpv-2.dll");
        if !dll.is_file() {
            return Err(MISSING_DLL_ERROR.to_string());
        }
        Self::load_from_path(&dll)
    }

    /// Load a concrete `libmpv-2.dll` path (local file only).
    pub fn load_from_path(dll: &Path) -> Result<Arc<MpvApi>, String> {
        let lib = unsafe { libloading::Library::new(dll) }.map_err(|e| {
            format!("{MISSING_DLL_ERROR} ({e})")
        })?;

        let api = MpvApi {
            create: resolve(&lib, b"mpv_create\0")?,
            initialize: resolve(&lib, b"mpv_initialize\0")?,
            terminate_destroy: resolve(&lib, b"mpv_terminate_destroy\0")?,
            error_string: resolve(&lib, b"mpv_error_string\0")?,
            set_option_string: resolve(&lib, b"mpv_set_option_string\0")?,
            set_option: resolve(&lib, b"mpv_set_option\0")?,
            set_property_string: resolve(&lib, b"mpv_set_property_string\0")?,
            set_property: resolve(&lib, b"mpv_set_property\0")?,
            get_property: resolve(&lib, b"mpv_get_property\0")?,
            command_ret: resolve(&lib, b"mpv_command_ret\0")?,
            observe_property: resolve(&lib, b"mpv_observe_property\0")?,
            wait_event: resolve(&lib, b"mpv_wait_event\0")?,
            free: resolve(&lib, b"mpv_free\0")?,
            free_node_contents: resolve(&lib, b"mpv_free_node_contents\0")?,
            render_context_create: resolve(&lib, b"mpv_render_context_create\0")?,
            render_context_free: resolve(&lib, b"mpv_render_context_free\0")?,
            render_context_set_update_callback: resolve(
                &lib,
                b"mpv_render_context_set_update_callback\0",
            )?,
            render_context_update: resolve(&lib, b"mpv_render_context_update\0")?,
            render_context_render: resolve(&lib, b"mpv_render_context_render\0")?,
            _lib: lib,
        };
        Ok(Arc::new(api))
    }

    pub fn error_text(&self, code: c_int) -> String {
        unsafe {
            let ptr = (self.error_string)(code);
            if ptr.is_null() {
                return format!("mpv error {code}");
            }
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }

    pub unsafe fn create(&self) -> Result<*mut MpvHandle, String> {
        let handle = (self.create)();
        if handle.is_null() {
            return Err("mpv_create failed".to_string());
        }
        Ok(handle)
    }

    pub unsafe fn initialize(&self, handle: *mut MpvHandle) -> Result<(), String> {
        let code = (self.initialize)(handle);
        if code < 0 {
            return Err(format!("mpv_initialize: {}", self.error_text(code)));
        }
        Ok(())
    }

    pub unsafe fn terminate_destroy(&self, handle: *mut MpvHandle) {
        if !handle.is_null() {
            (self.terminate_destroy)(handle);
        }
    }

    pub unsafe fn set_option_string(
        &self,
        handle: *mut MpvHandle,
        name: &str,
        value: &str,
    ) -> Result<(), String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let v = CString::new(value).map_err(|e| e.to_string())?;
        let code = (self.set_option_string)(handle, n.as_ptr(), v.as_ptr());
        if code < 0 {
            return Err(format!("set_option {name}: {}", self.error_text(code)));
        }
        Ok(())
    }

    pub unsafe fn set_option_i64(
        &self,
        handle: *mut MpvHandle,
        name: &str,
        value: i64,
    ) -> Result<(), String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let mut v = value;
        let code = (self.set_option)(handle, n.as_ptr(), MPV_FORMAT_INT64, &mut v as *mut i64 as *mut c_void);
        if code < 0 {
            return Err(format!("set_option {name}: {}", self.error_text(code)));
        }
        Ok(())
    }

    pub unsafe fn set_property_string(
        &self,
        handle: *mut MpvHandle,
        name: &str,
        value: &str,
    ) -> Result<(), String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let v = CString::new(value).map_err(|e| e.to_string())?;
        let code = (self.set_property_string)(handle, n.as_ptr(), v.as_ptr());
        if code < 0 {
            return Err(format!("set_property {name}: {}", self.error_text(code)));
        }
        Ok(())
    }

    pub unsafe fn set_property_f64(
        &self,
        handle: *mut MpvHandle,
        name: &str,
        value: f64,
    ) -> Result<(), String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let mut v = value;
        let code = (self.set_property)(handle, n.as_ptr(), MPV_FORMAT_DOUBLE, &mut v as *mut f64 as *mut c_void);
        if code < 0 {
            return Err(format!("set_property {name}: {}", self.error_text(code)));
        }
        Ok(())
    }

    pub unsafe fn set_property_flag(
        &self,
        handle: *mut MpvHandle,
        name: &str,
        value: bool,
    ) -> Result<(), String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let mut v: c_int = if value { 1 } else { 0 };
        let code = (self.set_property)(handle, n.as_ptr(), MPV_FORMAT_FLAG, &mut v as *mut c_int as *mut c_void);
        if code < 0 {
            return Err(format!("set_property {name}: {}", self.error_text(code)));
        }
        Ok(())
    }

    pub unsafe fn get_property_f64(
        &self,
        handle: *mut MpvHandle,
        name: &str,
    ) -> Result<f64, String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let mut v: f64 = 0.0;
        let code = (self.get_property)(handle, n.as_ptr(), MPV_FORMAT_DOUBLE, &mut v as *mut f64 as *mut c_void);
        if code < 0 {
            return Err(format!("get_property {name}: {}", self.error_text(code)));
        }
        Ok(v)
    }

    pub unsafe fn get_property_flag(
        &self,
        handle: *mut MpvHandle,
        name: &str,
    ) -> Result<bool, String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let mut v: c_int = 0;
        let code = (self.get_property)(handle, n.as_ptr(), MPV_FORMAT_FLAG, &mut v as *mut c_int as *mut c_void);
        if code < 0 {
            return Err(format!("get_property {name}: {}", self.error_text(code)));
        }
        Ok(v != 0)
    }

    pub unsafe fn get_property_string(
        &self,
        handle: *mut MpvHandle,
        name: &str,
    ) -> Result<String, String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let mut v: *mut c_char = ptr::null_mut();
        let code = (self.get_property)(
            handle,
            n.as_ptr(),
            MPV_FORMAT_STRING,
            &mut v as *mut *mut c_char as *mut c_void,
        );
        if code < 0 {
            return Err(format!("get_property {name}: {}", self.error_text(code)));
        }
        if v.is_null() {
            return Ok(String::new());
        }
        let text = CStr::from_ptr(v).to_string_lossy().into_owned();
        (self.free)(v as *mut c_void);
        Ok(text)
    }

    /// `mpv_command_ret` with a NULL-terminated argv (safe URL handling).
    pub unsafe fn command(
        &self,
        handle: *mut MpvHandle,
        args: &[&str],
    ) -> Result<(), String> {
        let c_args: Result<Vec<CString>, String> =
            args.iter().map(|s| CString::new(*s).map_err(|e| e.to_string())).collect();
        let c_args = c_args?;
        let mut ptrs: Vec<*const c_char> = c_args.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(ptr::null());
        let code = (self.command_ret)(handle, ptrs.as_ptr(), ptr::null_mut());
        if code < 0 {
            return Err(format!("mpv command {:?}: {}", args, self.error_text(code)));
        }
        Ok(())
    }

    pub unsafe fn observe_property(
        &self,
        handle: *mut MpvHandle,
        userdata: u64,
        name: &str,
        format: c_int,
    ) -> Result<(), String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let code = (self.observe_property)(handle, userdata, n.as_ptr(), format);
        if code < 0 {
            return Err(format!("observe {name}: {}", self.error_text(code)));
        }
        Ok(())
    }

    /// Block until the next mpv event (or timeout). Pointer is owned by libmpv.
    pub unsafe fn wait_event(&self, handle: *mut MpvHandle, timeout: f64) -> *mut MpvEvent {
        (self.wait_event)(handle, timeout)
    }

    /// `mpv_render_context_create` (OpenGL backend). Caller frees with
    /// `render_context_free` **before** `terminate_destroy`.
    pub unsafe fn render_context_create(
        &self,
        handle: *mut MpvHandle,
        init: &MpvOpenGLInitParams,
    ) -> Result<*mut MpvRenderContext, String> {
        let api_type = MPV_RENDER_API_TYPE_OPENGL.as_ptr() as *mut c_void;
        let mut params = [
            MpvRenderParam {
                type_: MPV_RENDER_PARAM_API_TYPE,
                data: api_type,
            },
            MpvRenderParam {
                type_: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                data: init as *const MpvOpenGLInitParams as *mut c_void,
            },
            MpvRenderParam {
                type_: MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];
        let mut ctx: *mut MpvRenderContext = ptr::null_mut();
        let code = (self.render_context_create)(&mut ctx, handle, params.as_mut_ptr());
        if code < 0 || ctx.is_null() {
            return Err(format!(
                "mpv_render_context_create: {}",
                self.error_text(code)
            ));
        }
        Ok(ctx)
    }

    pub unsafe fn render_context_free(&self, ctx: *mut MpvRenderContext) {
        if !ctx.is_null() {
            (self.render_context_free)(ctx);
        }
    }

    pub unsafe fn render_context_set_update_callback(
        &self,
        ctx: *mut MpvRenderContext,
        callback: MpvRenderUpdateFn,
        user: *mut c_void,
    ) {
        (self.render_context_set_update_callback)(ctx, callback, user);
    }

    /// Returns the pending update bitmask (`MPV_RENDER_UPDATE_FRAME`, …).
    pub unsafe fn render_context_update(&self, ctx: *mut MpvRenderContext) -> u64 {
        (self.render_context_update)(ctx)
    }

    /// Draw the current frame into the GL default framebuffer (FBO 0).
    pub unsafe fn render_context_render(
        &self,
        ctx: *mut MpvRenderContext,
        fbo: &MpvOpenGLFbo,
        flip_y: bool,
    ) -> Result<(), String> {
        let fbo_param = MpvOpenGLFbo { ..*fbo };
        let mut flip: i32 = if flip_y { 1 } else { 0 };
        let mut params = [
            MpvRenderParam {
                type_: MPV_RENDER_PARAM_OPENGL_FBO,
                data: &fbo_param as *const MpvOpenGLFbo as *mut c_void,
            },
            MpvRenderParam {
                type_: MPV_RENDER_PARAM_FLIP_Y,
                data: &mut flip as *mut i32 as *mut c_void,
            },
            MpvRenderParam {
                type_: MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];
        let code = (self.render_context_render)(ctx, params.as_mut_ptr());
        if code < 0 {
            return Err(format!("mpv_render_context_render: {}", self.error_text(code)));
        }
        Ok(())
    }

    pub unsafe fn get_property_node(
        &self,
        handle: *mut MpvHandle,
        name: &str,
    ) -> Result<*mut MpvNode, String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let node = Box::into_raw(Box::new(MpvNode {
            data: MpvNodeData { int64: 0 },
            format: MPV_FORMAT_NONE,
        }));
        let code = (self.get_property)(handle, n.as_ptr(), MPV_FORMAT_NODE, node as *mut c_void);
        if code < 0 {
            drop(Box::from_raw(node));
            return Err(format!("get_property {name}: {}", self.error_text(code)));
        }
        Ok(node)
    }

    pub unsafe fn free_node_contents(&self, node: *mut MpvNode) {
        if !node.is_null() {
            (self.free_node_contents)(node);
        }
    }
}

/// Find the directory that holds `libmpv-2.dll` (bundled next to `seans.exe`).
pub fn locate_mpv_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("mpv"));
            candidates.push(dir.to_path_buf());
            candidates.push(dir.join("resources").join("mpv"));
            // Dev build: src-tauri/target/{debug,release}/../../resources/mpv
            if let Some(profile) = dir.parent() {
                if let Some(target) = profile.parent() {
                    candidates.push(target.join("resources").join("mpv"));
                }
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("resources").join("mpv"));
        candidates.push(cwd.join("src-tauri").join("resources").join("mpv"));
    }

    candidates.into_iter().find(|p| p.join("libmpv-2.dll").is_file())
}

/// Read a C string pointer from a property payload (or None).
pub unsafe fn cstr_from_ptr(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let text = CStr::from_ptr(ptr).to_string_lossy().into_owned();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Read a `const char *` field from an mpv node (STRING / OSD_STRING).
pub unsafe fn node_string(node: &MpvNode) -> Option<String> {
    if node.format == MPV_FORMAT_STRING || node.format == 2 {
        cstr_from_ptr(node.data.string)
    } else {
        None
    }
}

/// Read an `int64` field from an mpv node.
pub unsafe fn node_int64(node: &MpvNode) -> Option<i64> {
    match node.format {
        MPV_FORMAT_INT64 => Some(node.data.int64),
        MPV_FORMAT_FLAG => Some(node.data.flag as i64),
        _ => None,
    }
}

/// Read a `flag` field from an mpv node.
pub unsafe fn node_flag(node: &MpvNode) -> Option<bool> {
    match node.format {
        MPV_FORMAT_FLAG => Some(node.data.flag != 0),
        MPV_FORMAT_INT64 => Some(node.data.int64 != 0),
        _ => None,
    }
}

/// Lookup a key inside an MPV_FORMAT_NODE_MAP.
pub unsafe fn map_get<'a>(list: &'a MpvNodeList, key: &str) -> Option<&'a MpvNode> {
    if list.keys.is_null() || list.values.is_null() || list.num <= 0 {
        return None;
    }
    for i in 0..list.num as isize {
        let key_ptr = *list.keys.offset(i);
        if key_ptr.is_null() {
            continue;
        }
        let k = CStr::from_ptr(key_ptr).to_string_lossy();
        if k == key {
            return Some(&*list.values.offset(i));
        }
    }
    None
}

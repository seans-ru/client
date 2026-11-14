//! EGL/OpenGL offscreen surface for Linux frame-stream playback.
//!
//! The context is created on the render thread without a host window. If the
//! driver lacks EGL_KHR_surfaceless_context, a tiny pbuffer anchors the same
//! texture-backed RGBA FBO. `glReadPixels` preserves the existing bottom-up
//! frame-stream contract.

use std::ffi::{c_char, c_void, CStr};
use std::ptr;
use std::sync::Arc;

use super::ffi::MpvGetProcAddressFn;

type EGLDisplay = *mut c_void;
type EGLConfig = *mut c_void;
type EGLContext = *mut c_void;
type EGLSurface = *mut c_void;
type EGLBoolean = u32;
type EGLint = i32;

const EGL_DEFAULT_DISPLAY: *mut c_void = ptr::null_mut();
const EGL_NO_DISPLAY: EGLDisplay = ptr::null_mut();
const EGL_NO_CONTEXT: EGLContext = ptr::null_mut();
const EGL_NO_SURFACE: EGLSurface = ptr::null_mut();
const EGL_NONE: EGLint = 0x3038;
const EGL_EXTENSIONS: EGLint = 0x3055;
const EGL_SURFACE_TYPE: EGLint = 0x3033;
const EGL_PBUFFER_BIT: EGLint = 0x0001;
const EGL_RENDERABLE_TYPE: EGLint = 0x3040;
const EGL_OPENGL_BIT: EGLint = 0x0008;
const EGL_RED_SIZE: EGLint = 0x3024;
const EGL_GREEN_SIZE: EGLint = 0x3023;
const EGL_BLUE_SIZE: EGLint = 0x3022;
const EGL_ALPHA_SIZE: EGLint = 0x3021;
const EGL_WIDTH: EGLint = 0x3057;
const EGL_HEIGHT: EGLint = 0x3056;
const EGL_OPENGL_API: u32 = 0x30A2;
const EGL_PLATFORM_SURFACELESS_MESA: u32 = 0x31DD;
const EGL_CONTEXT_MAJOR_VERSION: EGLint = 0x3098;
const EGL_CONTEXT_MINOR_VERSION: EGLint = 0x30FB;

type FnEglGetDisplay = unsafe extern "C" fn(*mut c_void) -> EGLDisplay;
type FnEglGetPlatformDisplayCore = unsafe extern "C" fn(u32, *mut c_void, *const isize) -> EGLDisplay;
type FnEglGetPlatformDisplayExt = unsafe extern "C" fn(u32, *mut c_void, *const EGLint) -> EGLDisplay;
type FnEglInitialize = unsafe extern "C" fn(EGLDisplay, *mut EGLint, *mut EGLint) -> EGLBoolean;
type FnEglTerminate = unsafe extern "C" fn(EGLDisplay) -> EGLBoolean;
type FnEglBindApi = unsafe extern "C" fn(u32) -> EGLBoolean;
type FnEglChooseConfig = unsafe extern "C" fn(
    EGLDisplay,
    *const EGLint,
    *mut EGLConfig,
    EGLint,
    *mut EGLint,
) -> EGLBoolean;
type FnEglCreateContext = unsafe extern "C" fn(
    EGLDisplay,
    EGLConfig,
    EGLContext,
    *const EGLint,
) -> EGLContext;
type FnEglDestroyContext = unsafe extern "C" fn(EGLDisplay, EGLContext) -> EGLBoolean;
type FnEglCreatePbuffer = unsafe extern "C" fn(
    EGLDisplay,
    EGLConfig,
    *const EGLint,
) -> EGLSurface;
type FnEglDestroySurface = unsafe extern "C" fn(EGLDisplay, EGLSurface) -> EGLBoolean;
type FnEglMakeCurrent = unsafe extern "C" fn(
    EGLDisplay,
    EGLSurface,
    EGLSurface,
    EGLContext,
) -> EGLBoolean;
type FnEglQueryString = unsafe extern "C" fn(EGLDisplay, EGLint) -> *const c_char;
type FnEglGetProcAddress = unsafe extern "C" fn(*const c_char) -> *mut c_void;

/* OpenGL symbols are resolved through EGL first, then libGL as a fallback. */
type FnGlReadPixels = unsafe extern "C" fn(i32, i32, i32, i32, u32, u32, *mut c_void);
type FnGlPixelStorei = unsafe extern "C" fn(u32, i32);
type FnGlViewport = unsafe extern "C" fn(i32, i32, i32, i32);
type FnGlFinish = unsafe extern "C" fn();
type FnGlGetString = unsafe extern "C" fn(u32) -> *const c_char;
type FnGlClearColor = unsafe extern "C" fn(f32, f32, f32, f32);
type FnGlClear = unsafe extern "C" fn(u32);
type FnGlGenTextures = unsafe extern "C" fn(i32, *mut u32);
type FnGlDeleteTextures = unsafe extern "C" fn(i32, *const u32);
type FnGlBindTexture = unsafe extern "C" fn(u32, u32);
type FnGlTexImage2D = unsafe extern "C" fn(u32, i32, i32, i32, i32, i32, u32, u32, *const c_void);
type FnGlTexParameteri = unsafe extern "C" fn(u32, u32, i32);
type FnGlGenFramebuffers = unsafe extern "C" fn(i32, *mut u32);
type FnGlDeleteFramebuffers = unsafe extern "C" fn(i32, *const u32);
type FnGlBindFramebuffer = unsafe extern "C" fn(u32, u32);
type FnGlFramebufferTexture2D = unsafe extern "C" fn(u32, u32, u32, u32, i32);
type FnGlCheckFramebufferStatus = unsafe extern "C" fn(u32) -> u32;

const GL_PACK_ALIGNMENT: u32 = 0x0D05;
const GL_RGBA: u32 = 0x1908;
const GL_RGBA8: i32 = 0x8058;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GL_TEXTURE_WRAP_S: u32 = 0x2802;
const GL_TEXTURE_WRAP_T: u32 = 0x2803;
const GL_LINEAR: i32 = 0x2601;
const GL_CLAMP_TO_EDGE: i32 = 0x812F;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_COLOR_BUFFER_BIT: u32 = 0x00004000;
const GL_VERSION: u32 = 0x1F02;

struct EglApi {
    _egl: libloading::Library,
    _gl: libloading::Library,
    get_proc_address: FnEglGetProcAddress,
    get_display: FnEglGetDisplay,
    get_platform_display_core: Option<FnEglGetPlatformDisplayCore>,
    get_platform_display_ext: Option<FnEglGetPlatformDisplayExt>,
    initialize: FnEglInitialize,
    terminate: FnEglTerminate,
    bind_api: FnEglBindApi,
    choose_config: FnEglChooseConfig,
    create_context: FnEglCreateContext,
    destroy_context: FnEglDestroyContext,
    create_pbuffer: FnEglCreatePbuffer,
    destroy_surface: FnEglDestroySurface,
    make_current: FnEglMakeCurrent,
    query_string: FnEglQueryString,
    gl_read_pixels: FnGlReadPixels,
    gl_pixel_storei: FnGlPixelStorei,
    gl_viewport: FnGlViewport,
    gl_finish: FnGlFinish,
    gl_get_string: FnGlGetString,
    gl_clear_color: FnGlClearColor,
    gl_clear: FnGlClear,
    gl_gen_textures: FnGlGenTextures,
    gl_delete_textures: FnGlDeleteTextures,
    gl_bind_texture: FnGlBindTexture,
    gl_tex_image_2d: FnGlTexImage2D,
    gl_tex_parameteri: FnGlTexParameteri,
    gl_gen_framebuffers: FnGlGenFramebuffers,
    gl_delete_framebuffers: FnGlDeleteFramebuffers,
    gl_bind_framebuffer: FnGlBindFramebuffer,
    gl_framebuffer_texture_2d: FnGlFramebufferTexture2D,
    gl_check_framebuffer_status: FnGlCheckFramebufferStatus,
}

fn sym<T: Copy>(lib: &libloading::Library, name: &[u8]) -> Result<T, String> {
    unsafe {
        let value: libloading::Symbol<T> = lib.get(name).map_err(|e| {
            format!("egl: missing symbol {} ({e})", String::from_utf8_lossy(name))
        })?;
        Ok(*value)
    }
}

fn sym_any<T: Copy>(lib: &libloading::Library, names: &[&[u8]]) -> Result<T, String> {
    for name in names {
        if let Ok(symbol) = unsafe { lib.get::<T>(name) } {
            return Ok(*symbol);
        }
    }
    Err(format!("egl: missing GL symbol {}", String::from_utf8_lossy(names[0])))
}

impl EglApi {
    fn load() -> Result<Arc<Self>, String> {
        let egl = unsafe { libloading::Library::new("libEGL.so.1") }
            .map_err(|e| format!("egl: cannot load libEGL.so.1 ({e})"))?;
        // EGL can resolve core GL and extension functions. libGL is retained as
        // a fallback for drivers whose EGL proc table omits core entry points.
        let gl = unsafe { libloading::Library::new("libGL.so.1") }
            .map_err(|e| format!("egl: cannot load libGL.so.1 ({e})"))?;
        let get_proc_address: FnEglGetProcAddress = sym(&egl, b"eglGetProcAddress\0")?;
        let (get_platform_display_core, get_platform_display_ext) = unsafe {
            let core = egl.get::<FnEglGetPlatformDisplayCore>(b"eglGetPlatformDisplay\0")
                .ok().map(|symbol| *symbol);
            let ext = egl.get::<FnEglGetPlatformDisplayExt>(b"eglGetPlatformDisplayEXT\0")
                .ok().map(|symbol| *symbol).or_else(|| {
                    let ptr = get_proc_address(b"eglGetPlatformDisplayEXT\0".as_ptr() as *const c_char);
                    if ptr.is_null() { None } else { Some(std::mem::transmute::<*mut c_void, FnEglGetPlatformDisplayExt>(ptr)) }
                });
            (core, ext)
        };
        let api = Self {
            get_proc_address,
            get_display: sym(&egl, b"eglGetDisplay\0")?,
            get_platform_display_core,
            get_platform_display_ext,
            initialize: sym(&egl, b"eglInitialize\0")?,
            terminate: sym(&egl, b"eglTerminate\0")?,
            bind_api: sym(&egl, b"eglBindAPI\0")?,
            choose_config: sym(&egl, b"eglChooseConfig\0")?,
            create_context: sym(&egl, b"eglCreateContext\0")?,
            destroy_context: sym(&egl, b"eglDestroyContext\0")?,
            create_pbuffer: sym(&egl, b"eglCreatePbufferSurface\0")?,
            destroy_surface: sym(&egl, b"eglDestroySurface\0")?,
            make_current: sym(&egl, b"eglMakeCurrent\0")?,
            query_string: sym(&egl, b"eglQueryString\0")?,
            gl_read_pixels: sym(&gl, b"glReadPixels\0")?,
            gl_pixel_storei: sym(&gl, b"glPixelStorei\0")?,
            gl_viewport: sym(&gl, b"glViewport\0")?,
            gl_finish: sym(&gl, b"glFinish\0")?,
            gl_get_string: sym(&gl, b"glGetString\0")?,
            gl_clear_color: sym(&gl, b"glClearColor\0")?,
            gl_clear: sym(&gl, b"glClear\0")?,
            gl_gen_textures: sym(&gl, b"glGenTextures\0")?,
            gl_delete_textures: sym(&gl, b"glDeleteTextures\0")?,
            gl_bind_texture: sym(&gl, b"glBindTexture\0")?,
            gl_tex_image_2d: sym(&gl, b"glTexImage2D\0")?,
            gl_tex_parameteri: sym(&gl, b"glTexParameteri\0")?,
            gl_gen_framebuffers: sym_any(&gl, &[b"glGenFramebuffers\0", b"glGenFramebuffersEXT\0"] )?,
            gl_delete_framebuffers: sym_any(&gl, &[b"glDeleteFramebuffers\0", b"glDeleteFramebuffersEXT\0"] )?,
            gl_bind_framebuffer: sym_any(&gl, &[b"glBindFramebuffer\0", b"glBindFramebufferEXT\0"] )?,
            gl_framebuffer_texture_2d: sym_any(&gl, &[b"glFramebufferTexture2D\0", b"glFramebufferTexture2DEXT\0"] )?,
            gl_check_framebuffer_status: sym_any(&gl, &[b"glCheckFramebufferStatus\0", b"glCheckFramebufferStatusEXT\0"] )?,
            _egl: egl,
            _gl: gl,
        };
        Ok(Arc::new(api))
    }

    unsafe fn proc(&self, name: *const c_char) -> *mut c_void {
        let address = (self.get_proc_address)(name);
        if !address.is_null() {
            return address;
        }
        self._gl.get::<unsafe extern "C" fn()>(CStr::from_ptr(name).to_bytes_with_nul())
            .map(|symbol| *symbol as *mut c_void)
            .unwrap_or(ptr::null_mut())
    }
}

unsafe extern "C" fn mpv_get_proc_address(ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    if ctx.is_null() || name.is_null() {
        return ptr::null_mut();
    }
    let api = &*(ctx as *const EglApi);
    api.proc(name)
}

/// Render-thread-owned EGL context and offscreen FBO.
pub struct GlSurface {
    api: Arc<EglApi>,
    display: EGLDisplay,
    context: EGLContext,
    surface: EGLSurface,
    texture: u32,
    fbo: u32,
    width: i32,
    height: i32,
}

impl GlSurface {
    pub fn attach(_anchor: isize, width: i32, height: i32) -> Result<Self, String> {
        let api = EglApi::load()?;
        let platform_display = unsafe {
            api.get_platform_display_core
                .and_then(|get_display| {
                    let display = get_display(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, [EGL_NONE as isize].as_ptr());
                    (display != EGL_NO_DISPLAY).then_some(display)
                })
                .or_else(|| api.get_platform_display_ext.and_then(|get_display| {
                    let display = get_display(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, [EGL_NONE].as_ptr());
                    (display != EGL_NO_DISPLAY).then_some(display)
                }))
        };
        let mut display = platform_display.unwrap_or(EGL_NO_DISPLAY);
        let mut major = 0;
        let mut minor = 0;
        let mut initialized = display != EGL_NO_DISPLAY
            && unsafe { (api.initialize)(display, &mut major, &mut minor) } != 0;
        if !initialized {
            if display != EGL_NO_DISPLAY { unsafe { (api.terminate)(display); } }
            display = unsafe { (api.get_display)(EGL_DEFAULT_DISPLAY) };
            initialized = display != EGL_NO_DISPLAY
                && unsafe { (api.initialize)(display, &mut major, &mut minor) } != 0;
        }
        if display == EGL_NO_DISPLAY {
            return Err("egl: EGL_DEFAULT_DISPLAY is unavailable".to_string());
        }
        if !initialized {
            return Err("egl: eglInitialize failed (check EGL/DRI driver setup)".to_string());
        }
        if unsafe { (api.bind_api)(EGL_OPENGL_API) } == 0 {
            unsafe { (api.terminate)(display) };
            return Err("egl: OpenGL API is unavailable".to_string());
        }
        let attrs = [
            EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
            EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
            EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
            EGL_NONE,
        ];
        let mut config = ptr::null_mut();
        let mut count = 0;
        if unsafe { (api.choose_config)(display, attrs.as_ptr(), &mut config, 1, &mut count) } == 0 || count == 0 {
            unsafe { (api.terminate)(display) };
            return Err("egl: no RGBA8 OpenGL config".to_string());
        }
        let extensions = unsafe {
            let ptr = (api.query_string)(display, EGL_EXTENSIONS);
            if ptr.is_null() { String::new() } else { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
        };
        let supports_context_version = major > 1 || (major == 1 && minor >= 5)
            || extensions.split_ascii_whitespace().any(|ext| ext == "EGL_KHR_create_context");
        if !supports_context_version {
            unsafe { (api.terminate)(display) };
            return Err("egl: EGL_KHR_create_context is required to request OpenGL 2.1 for libmpv".to_string());
        }
        // libmpv's OpenGL render API requires at least OpenGL 2.1; EGL's
        // default context version is only 1.0, so request the minimum explicitly.
        let context_attrs = [EGL_CONTEXT_MAJOR_VERSION, 2, EGL_CONTEXT_MINOR_VERSION, 1, EGL_NONE];
        let context = unsafe { (api.create_context)(display, config, EGL_NO_CONTEXT, context_attrs.as_ptr()) };
        if context == EGL_NO_CONTEXT {
            unsafe { (api.terminate)(display) };
            return Err("egl: could not create an OpenGL 2.1 context required by libmpv".to_string());
        }
        let surfaceless = extensions.split_ascii_whitespace().any(|ext| ext == "EGL_KHR_surfaceless_context");
        let surface = if surfaceless {
            EGL_NO_SURFACE
        } else {
            let pbuffer_attrs = [EGL_WIDTH, 2, EGL_HEIGHT, 2, EGL_NONE];
            let value = unsafe { (api.create_pbuffer)(display, config, pbuffer_attrs.as_ptr()) };
            if value == EGL_NO_SURFACE {
                unsafe { (api.destroy_context)(display, context); (api.terminate)(display); }
                return Err("egl: surfaceless context unavailable and pbuffer creation failed".to_string());
            }
            value
        };
        if unsafe { (api.make_current)(display, surface, surface, context) } == 0 {
            if surface != EGL_NO_SURFACE { unsafe { (api.destroy_surface)(display, surface); } }
            unsafe { (api.destroy_context)(display, context); (api.terminate)(display); }
            return Err("egl: eglMakeCurrent failed".to_string());
        }
        let version = unsafe {
            let ptr = (api.gl_get_string)(GL_VERSION);
            if ptr.is_null() { "unknown".to_string() } else { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
        };
        let version_number = version.split_ascii_whitespace().next().and_then(|number| {
            let (major, minor) = number.split_once('.')?;
            Some((major.parse::<u32>().ok()?, minor.parse::<u32>().ok()?))
        });
        if version_number.map_or(true, |value| value < (2, 1)) {
            unsafe {
                (api.make_current)(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
                if surface != EGL_NO_SURFACE { (api.destroy_surface)(display, surface); }
                (api.destroy_context)(display, context);
                (api.terminate)(display);
            }
            return Err(format!("egl: OpenGL {version} is below the 2.1 minimum required by libmpv"));
        }
        println!("[player] EGL {}.{} OpenGL {} ({})", major, minor, version, if surfaceless { "surfaceless" } else { "pbuffer fallback" });
        let mut result = Self { api, display, context, surface, texture: 0, fbo: 0, width: 0, height: 0 };
        result.resize(width, height)?;
        unsafe {
            (result.api.gl_clear_color)(1.0, 0.0, 0.0, 1.0);
            (result.api.gl_clear)(GL_COLOR_BUFFER_BIT);
        }
        let diagnostic = result.read_pixels();
        let center = ((result.height as usize / 2) * result.width as usize + result.width as usize / 2) * 4;
        let red = diagnostic.get(center).copied().unwrap_or(0);
        let green = diagnostic.get(center + 1).copied().unwrap_or(255);
        let blue = diagnostic.get(center + 2).copied().unwrap_or(255);
        if red < 200 || green > 40 || blue > 40 {
            return Err("egl: offscreen FBO readback self-check failed".to_string());
        }
        unsafe { (result.api.gl_clear_color)(0.0, 0.0, 0.0, 1.0); (result.api.gl_clear)(GL_COLOR_BUFFER_BIT); }
        Ok(result)
    }

    pub fn proc_address_fn(&self) -> (MpvGetProcAddressFn, *mut c_void) {
        (mpv_get_proc_address, Arc::as_ptr(&self.api) as *mut c_void)
    }

    pub fn fbo_id(&self) -> i32 { self.fbo as i32 }
    pub fn internal_format(&self) -> i32 { GL_RGBA8 }
    pub fn size(&self) -> (i32, i32) { (self.width, self.height) }

    pub fn resize(&mut self, width: i32, height: i32) -> Result<(), String> {
        let width = width.max(2);
        let height = height.max(2);
        if self.width == width && self.height == height { return Ok(()); }
        unsafe {
            if self.texture == 0 {
                (self.api.gl_gen_textures)(1, &mut self.texture);
                (self.api.gl_gen_framebuffers)(1, &mut self.fbo);
            }
            (self.api.gl_bind_texture)(GL_TEXTURE_2D, self.texture);
            (self.api.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            (self.api.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            (self.api.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            (self.api.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            (self.api.gl_tex_image_2d)(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, ptr::null());
            (self.api.gl_bind_framebuffer)(GL_FRAMEBUFFER, self.fbo);
            (self.api.gl_framebuffer_texture_2d)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, self.texture, 0);
            if (self.api.gl_check_framebuffer_status)(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE {
                return Err("egl: offscreen framebuffer is incomplete".to_string());
            }
            (self.api.gl_viewport)(0, 0, width, height);
        }
        self.width = width;
        self.height = height;
        Ok(())
    }

    pub fn read_pixels(&self) -> Vec<u8> {
        let mut pixels = vec![0; self.width as usize * self.height as usize * 4];
        unsafe {
            (self.api.gl_bind_framebuffer)(GL_FRAMEBUFFER, self.fbo);
            (self.api.gl_pixel_storei)(GL_PACK_ALIGNMENT, 1);
            (self.api.gl_read_pixels)(0, 0, self.width, self.height, GL_RGBA, GL_UNSIGNED_BYTE, pixels.as_mut_ptr() as *mut c_void);
            (self.api.gl_finish)();
        }
        pixels
    }
}

impl Drop for GlSurface {
    fn drop(&mut self) {
        unsafe {
            (self.api.gl_bind_framebuffer)(GL_FRAMEBUFFER, 0);
            if self.fbo != 0 { (self.api.gl_delete_framebuffers)(1, &self.fbo); }
            if self.texture != 0 { (self.api.gl_delete_textures)(1, &self.texture); }
            (self.api.make_current)(self.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
            if self.surface != EGL_NO_SURFACE { (self.api.destroy_surface)(self.display, self.surface); }
            (self.api.destroy_context)(self.display, self.context);
            (self.api.terminate)(self.display);
        }
    }
}

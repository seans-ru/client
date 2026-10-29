//! Offscreen OpenGL surface for `vo=libmpv` (frame-stream player).
//!
//! mpv's render API draws into a **texture-backed FBO owned by us** — not the
//! hidden window's default framebuffer (hidden-window backbuffers are flaky
//! and produced all-zero reads). The hidden host window (`host.rs`) only
//! anchors the WGL context. Pixels are read back as tightly packed RGBA
//! (`GL_PACK_ALIGNMENT = 1`) in GL row order (bottom-up).
//!
//! All GL/WGL entry points are resolved with `libloading` from `opengl32.dll`
//! (GL 1.1 + WGL) / `gdi32.dll` (pixel format) / `kernel32.dll`
//! (`GetProcAddress`); FBO entry points come through `wglGetProcAddress`.
//!
//! The surface is bound to the thread that calls `attach` (the render thread).

#![cfg(windows)]

use std::ffi::{c_char, c_void};
use std::sync::Arc;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::HDC;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;

use super::ffi::MpvGetProcAddressFn;

/* ------------------------------------------------------------- GL consts */

const GL_PACK_ALIGNMENT: u32 = 0x0D05;
const GL_RGBA: u32 = 0x1908;
const GL_RGBA8: u32 = 0x8058;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GL_TEXTURE_WRAP_S: u32 = 0x2802;
const GL_TEXTURE_WRAP_T: u32 = 0x2803;
const GL_LINEAR: u32 = 0x2601;
const GL_CLAMP_TO_EDGE: u32 = 0x812F;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_COLOR_BUFFER_BIT: u32 = 0x00004000;
const GL_VERSION: u32 = 0x1F02;

/* --------------------------------------------------------- pixel format */

#[repr(C)]
#[derive(Clone, Copy)]
struct PixelFormatDescriptor {
    n_size: u16,
    n_version: u16,
    dw_flags: u32,
    i_pixel_type: u8,
    c_color_bits: u8,
    c_red_bits: u8,
    c_red_shift: u8,
    c_green_bits: u8,
    c_green_shift: u8,
    c_blue_bits: u8,
    c_blue_shift: u8,
    c_alpha_bits: u8,
    c_alpha_shift: u8,
    c_accum_bits: u8,
    c_accum_red_bits: u8,
    c_accum_green_bits: u8,
    c_accum_blue_bits: u8,
    c_accum_alpha_bits: u8,
    c_depth_bits: u8,
    c_stencil_bits: u8,
    c_aux_buffers: u8,
    i_layer_type: u8,
    b_reserved: u8,
    dw_layer_mask: u32,
    dw_visible_mask: u32,
    dw_damage_mask: u32,
}

const PFD_DRAW_TO_WINDOW: u32 = 0x0004;
const PFD_SUPPORT_OPENGL: u32 = 0x0020;
const PFD_DOUBLEBUFFER: u32 = 0x0001;
const PFD_MAIN_PLANE: u8 = 0;

/* ------------------------------------------------------------- GL loader */

type FnWglCreateContext = unsafe extern "system" fn(HDC) -> isize;
type FnWglMakeCurrent = unsafe extern "system" fn(HDC, isize) -> i32;
type FnWglDeleteContext = unsafe extern "system" fn(isize) -> i32;
type FnWglGetProcAddress = unsafe extern "system" fn(*const c_char) -> *mut c_void;
type FnGlReadPixels =
    unsafe extern "system" fn(i32, i32, i32, i32, u32, u32, *mut c_void);
type FnGlPixelStorei = unsafe extern "system" fn(u32, i32);
type FnGlViewport = unsafe extern "system" fn(i32, i32, i32, i32);
type FnGlFinish = unsafe extern "system" fn();
type FnGlGetString = unsafe extern "system" fn(u32) -> *const c_char;
type FnGlGetError = unsafe extern "system" fn() -> u32;
type FnGlClearColor = unsafe extern "system" fn(f32, f32, f32, f32);
type FnGlClear = unsafe extern "system" fn(u32);
type FnGlGenTextures = unsafe extern "system" fn(i32, *mut u32);
type FnGlDeleteTextures = unsafe extern "system" fn(i32, *const u32);
type FnGlBindTexture = unsafe extern "system" fn(u32, u32);
type FnGlTexImage2D =
    unsafe extern "system" fn(u32, i32, i32, i32, i32, i32, u32, u32, *const c_void);
type FnGlTexParameteri = unsafe extern "system" fn(u32, u32, i32);
type FnGlGenFramebuffers = unsafe extern "system" fn(i32, *mut u32);
type FnGlDeleteFramebuffers = unsafe extern "system" fn(i32, *const u32);
type FnGlBindFramebuffer = unsafe extern "system" fn(u32, u32);
type FnGlFramebufferTexture2D = unsafe extern "system" fn(u32, u32, u32, u32, i32);
type FnGlCheckFramebufferStatus = unsafe extern "system" fn(u32) -> u32;
type FnChoosePixelFormat = unsafe extern "system" fn(HDC, *const PixelFormatDescriptor) -> i32;
type FnSetPixelFormat = unsafe extern "system" fn(HDC, i32, *const PixelFormatDescriptor) -> i32;
type FnGetDc = unsafe extern "system" fn(HWND) -> HDC;
type FnReleaseDc = unsafe extern "system" fn(HWND, HDC) -> i32;
type FnGetProcAddress =
    unsafe extern "system" fn(*mut c_void, *const c_char) -> *mut c_void;

struct GlApi {
    _opengl: libloading::Library,
    _gdi: libloading::Library,
    _user: libloading::Library,
    _kernel: libloading::Library,
    /// HMODULE of `opengl32.dll` for the `GetProcAddress` fallback path.
    opengl_handle: *mut c_void,
    wgl_create_context: FnWglCreateContext,
    wgl_make_current: FnWglMakeCurrent,
    wgl_delete_context: FnWglDeleteContext,
    wgl_get_proc_address: FnWglGetProcAddress,
    gl_read_pixels: FnGlReadPixels,
    gl_pixel_storei: FnGlPixelStorei,
    gl_viewport: FnGlViewport,
    gl_finish: FnGlFinish,
    gl_get_string: FnGlGetString,
    gl_get_error: FnGlGetError,
    gl_clear_color: FnGlClearColor,
    gl_clear: FnGlClear,
    gl_gen_textures: FnGlGenTextures,
    gl_delete_textures: FnGlDeleteTextures,
    gl_bind_texture: FnGlBindTexture,
    gl_tex_image_2d: FnGlTexImage2D,
    gl_tex_parameteri: FnGlTexParameteri,
    choose_pixel_format: FnChoosePixelFormat,
    set_pixel_format: FnSetPixelFormat,
    get_dc: FnGetDc,
    release_dc: FnReleaseDc,
    get_proc_address: FnGetProcAddress,
}

fn sym<T: Copy>(lib: &libloading::Library, name: &[u8]) -> Result<T, String> {
    unsafe {
        let s: libloading::Symbol<T> = lib.get(name).map_err(|_| {
            format!("gl: missing symbol {}", String::from_utf8_lossy(name))
        })?;
        Ok(*s)
    }
}

impl GlApi {
    fn load() -> Result<Arc<GlApi>, String> {
        let opengl = unsafe { libloading::Library::new("opengl32.dll") }
            .map_err(|e| format!("gl: load opengl32.dll ({e})"))?;
        let gdi = unsafe { libloading::Library::new("gdi32.dll") }
            .map_err(|e| format!("gl: load gdi32.dll ({e})"))?;
        let user = unsafe { libloading::Library::new("user32.dll") }
            .map_err(|e| format!("gl: load user32.dll ({e})"))?;
        // GetProcAddress lives in kernel32, NOT in opengl32.
        let kernel = unsafe { libloading::Library::new("kernel32.dll") }
            .map_err(|e| format!("gl: load kernel32.dll ({e})"))?;
        let opengl_name: Vec<u16> = "opengl32.dll"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let opengl_handle = unsafe { GetModuleHandleW(opengl_name.as_ptr()) } as *mut c_void;
        if opengl_handle.is_null() {
            return Err("gl: GetModuleHandleW(opengl32.dll) failed".to_string());
        }
        Ok(Arc::new(GlApi {
            opengl_handle,
            wgl_create_context: sym(&opengl, b"wglCreateContext\0")?,
            wgl_make_current: sym(&opengl, b"wglMakeCurrent\0")?,
            wgl_delete_context: sym(&opengl, b"wglDeleteContext\0")?,
            wgl_get_proc_address: sym(&opengl, b"wglGetProcAddress\0")?,
            gl_read_pixels: sym(&opengl, b"glReadPixels\0")?,
            gl_pixel_storei: sym(&opengl, b"glPixelStorei\0")?,
            gl_viewport: sym(&opengl, b"glViewport\0")?,
            gl_finish: sym(&opengl, b"glFinish\0")?,
            gl_get_string: sym(&opengl, b"glGetString\0")?,
            gl_get_error: sym(&opengl, b"glGetError\0")?,
            gl_clear_color: sym(&opengl, b"glClearColor\0")?,
            gl_clear: sym(&opengl, b"glClear\0")?,
            gl_gen_textures: sym(&opengl, b"glGenTextures\0")?,
            gl_delete_textures: sym(&opengl, b"glDeleteTextures\0")?,
            gl_bind_texture: sym(&opengl, b"glBindTexture\0")?,
            gl_tex_image_2d: sym(&opengl, b"glTexImage2D\0")?,
            gl_tex_parameteri: sym(&opengl, b"glTexParameteri\0")?,
            choose_pixel_format: sym(&gdi, b"ChoosePixelFormat\0")?,
            set_pixel_format: sym(&gdi, b"SetPixelFormat\0")?,
            get_dc: sym(&user, b"GetDC\0")?,
            release_dc: sym(&user, b"ReleaseDC\0")?,
            get_proc_address: sym(&kernel, b"GetProcAddress\0")?,
            _opengl: opengl,
            _gdi: gdi,
            _user: user,
            _kernel: kernel,
        }))
    }

    /// Resolve an extension entry point (WGL first, then `GetProcAddress`).
    fn proc<T: Copy>(&self, names: &[&[u8]]) -> Result<T, String> {
        for name in names {
            let cname = name.as_ptr() as *const c_char;
            let ptr = unsafe {
                let mut p = (self.wgl_get_proc_address)(cname);
                if p.is_null()
                    || p as usize == 1
                    || p as usize == 2
                    || p as usize == 3
                    || p as usize == usize::MAX
                {
                    p = (self.get_proc_address)(self.opengl_handle, cname);
                }
                p
            };
            if !ptr.is_null() {
                // SAFETY: caller names match the requested signature.
                return Ok(unsafe { std::mem::transmute_copy(&ptr) });
            }
        }
        Err(format!(
            "gl: missing symbol {}",
            String::from_utf8_lossy(names[0])
        ))
    }
}

/// `mpv_get_proc_address_fn` trampoline: WGL extensions + opengl32 fallback.
/// `ctx` points at the `GlApi` that owns the loaders.
pub unsafe extern "C" fn get_proc_address(
    ctx: *mut c_void,
    name: *const c_char,
) -> *mut c_void {
    if ctx.is_null() || name.is_null() {
        return std::ptr::null_mut();
    }
    let api = &*(ctx as *const GlApi);
    let ptr = (api.wgl_get_proc_address)(name);
    let bad = ptr.is_null()
        || ptr as usize == 1
        || ptr as usize == 2
        || ptr as usize == 3
        || ptr as usize == usize::MAX;
    if !bad {
        return ptr;
    }
    (api.get_proc_address)(api.opengl_handle, name)
}

/* ------------------------------------------------------------- the surface */

/// FBO entry points (GL 3.0 / ARB_framebuffer_object, EXT fallback).
struct FboFns {
    gen_framebuffers: FnGlGenFramebuffers,
    delete_framebuffers: FnGlDeleteFramebuffers,
    bind_framebuffer: FnGlBindFramebuffer,
    framebuffer_texture_2d: FnGlFramebufferTexture2D,
    check_framebuffer_status: FnGlCheckFramebufferStatus,
}

pub struct GlSurface {
    hwnd: HWND,
    hdc: HDC,
    hglrc: isize,
    api: Arc<GlApi>,
    fbo_fns: FboFns,
    fbo: u32,
    texture: u32,
    width: i32,
    height: i32,
}

impl GlSurface {
    /// Create the WGL context on `hwnd`, build a texture-backed FBO render
    /// target and make the context current on **this** thread.
    pub fn attach(hwnd: isize, width: i32, height: i32) -> Result<GlSurface, String> {
        let api = GlApi::load()?;
        let hwnd = hwnd as HWND;
        if hwnd.is_null() {
            return Err("gl: null host hwnd".to_string());
        }
        let hdc = unsafe { (api.get_dc)(hwnd) };
        if hdc.is_null() {
            return Err("gl: GetDC failed".to_string());
        }

        let pfd = PixelFormatDescriptor {
            n_size: std::mem::size_of::<PixelFormatDescriptor>() as u16,
            n_version: 1,
            dw_flags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
            i_pixel_type: 0, // PFD_TYPE_RGBA
            c_color_bits: 32,
            c_red_bits: 8,
            c_red_shift: 0,
            c_green_bits: 8,
            c_green_shift: 0,
            c_blue_bits: 8,
            c_blue_shift: 0,
            c_alpha_bits: 8,
            c_alpha_shift: 0,
            c_accum_bits: 0,
            c_accum_red_bits: 0,
            c_accum_green_bits: 0,
            c_accum_blue_bits: 0,
            c_accum_alpha_bits: 0,
            c_depth_bits: 0,
            c_stencil_bits: 0,
            c_aux_buffers: 0,
            i_layer_type: PFD_MAIN_PLANE,
            b_reserved: 0,
            dw_layer_mask: 0,
            dw_visible_mask: 0,
            dw_damage_mask: 0,
        };
        let fmt = unsafe { (api.choose_pixel_format)(hdc, &pfd) };
        if fmt == 0 {
            unsafe { (api.release_dc)(hwnd, hdc) };
            return Err("gl: ChoosePixelFormat failed".to_string());
        }
        if unsafe { (api.set_pixel_format)(hdc, fmt, &pfd) } == 0 {
            unsafe { (api.release_dc)(hwnd, hdc) };
            return Err("gl: SetPixelFormat failed".to_string());
        }
        let hglrc = unsafe { (api.wgl_create_context)(hdc) };
        if hglrc == 0 {
            unsafe { (api.release_dc)(hwnd, hdc) };
            return Err("gl: wglCreateContext failed".to_string());
        }
        if unsafe { (api.wgl_make_current)(hdc, hglrc) } == 0 {
            unsafe {
                (api.wgl_delete_context)(hglrc);
                (api.release_dc)(hwnd, hdc);
            }
            return Err("gl: wglMakeCurrent failed".to_string());
        }

        let version = unsafe {
            let ptr = (api.gl_get_string)(GL_VERSION);
            if ptr.is_null() {
                "unknown".to_string()
            } else {
                std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned()
            }
        };
        println!("[player] GL version: {version}");

        let fbo_fns = FboFns {
            gen_framebuffers: api.proc(&[b"glGenFramebuffers\0", b"glGenFramebuffersEXT\0"])?,
            delete_framebuffers: api.proc(&[
                b"glDeleteFramebuffers\0",
                b"glDeleteFramebuffersEXT\0",
            ])?,
            bind_framebuffer: api.proc(&[b"glBindFramebuffer\0", b"glBindFramebufferEXT\0"])?,
            framebuffer_texture_2d: api.proc(&[
                b"glFramebufferTexture2D\0",
                b"glFramebufferTexture2DEXT\0",
            ])?,
            check_framebuffer_status: api.proc(&[
                b"glCheckFramebufferStatus\0",
                b"glCheckFramebufferStatusEXT\0",
            ])?,
        };

        let mut surface = GlSurface {
            hwnd,
            hdc,
            hglrc,
            api,
            fbo_fns,
            fbo: 0,
            texture: 0,
            width: width.max(2),
            height: height.max(2),
        };
        surface.create_target()?;
        surface.apply_state();

        // Self-test: a red clear must come back red from readback. Proves the
        // FBO + read path independently of mpv.
        unsafe {
            (surface.api.gl_clear_color)(1.0, 0.0, 0.0, 1.0);
            (surface.api.gl_clear)(GL_COLOR_BUFFER_BIT);
            (surface.api.gl_finish)();
        }
        let probe = surface.read_pixels();
        let px = probe.get(0..4).unwrap_or(&[0, 0, 0, 0]);
        println!(
            "[player] GL self-test probe RGBA {}/{}/{}/{}",
            px[0], px[1], px[2], px[3]
        );
        if px[0] < 250 || px[3] < 250 {
            eprintln!("[player] GL self-test FAILED — FBO readback is broken");
        }

        Ok(surface)
    }

    /// (Re)allocate the texture-backed FBO at the current size.
    fn create_target(&mut self) -> Result<(), String> {
        let api = &self.api;
        let fns = &self.fbo_fns;
        unsafe {
            if self.texture != 0 {
                (api.gl_delete_textures)(1, &self.texture);
            }
            if self.fbo != 0 {
                (fns.delete_framebuffers)(1, &self.fbo);
            }
            let mut tex = 0u32;
            (api.gl_gen_textures)(1, &mut tex);
            (api.gl_bind_texture)(GL_TEXTURE_2D, tex);
            (api.gl_tex_image_2d)(
                GL_TEXTURE_2D,
                0,
                GL_RGBA8 as i32,
                self.width,
                self.height,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                std::ptr::null(),
            );
            (api.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR as i32);
            (api.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR as i32);
            (api.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE as i32);
            (api.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE as i32);

            let mut fbo = 0u32;
            (fns.gen_framebuffers)(1, &mut fbo);
            (fns.bind_framebuffer)(GL_FRAMEBUFFER, fbo);
            (fns.framebuffer_texture_2d)(
                GL_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_2D,
                tex,
                0,
            );
            let status = (fns.check_framebuffer_status)(GL_FRAMEBUFFER);
            if status != GL_FRAMEBUFFER_COMPLETE {
                return Err(format!("gl: FBO incomplete (0x{status:04X})"));
            }
            self.texture = tex;
            self.fbo = fbo;
        }
        Ok(())
    }

    /// Load-address trampoline for `mpv_render_context_create`.
    pub fn proc_address_fn(&self) -> (MpvGetProcAddressFn, *mut c_void) {
        (
            get_proc_address,
            Arc::as_ptr(&self.api) as *mut c_void,
        )
    }

    /// FBO id to hand to mpv (`mpv_opengl_fbo.fbo`).
    pub fn fbo_id(&self) -> i32 {
        self.fbo as i32
    }

    /// GL internal format of the FBO texture (`mpv_opengl_fbo.internal_format`).
    pub fn internal_format(&self) -> i32 {
        GL_RGBA8 as i32
    }

    fn apply_state(&self) {
        unsafe {
            (self.fbo_fns.bind_framebuffer)(GL_FRAMEBUFFER, self.fbo);
            (self.api.gl_viewport)(0, 0, self.width, self.height);
            (self.api.gl_pixel_storei)(GL_PACK_ALIGNMENT, 1);
        }
    }

    /// Resize the render target (recreates the texture when the size changed).
    pub fn resize(&mut self, width: i32, height: i32) -> Result<(), String> {
        let w = width.max(2);
        let h = height.max(2);
        if w == self.width && h == self.height {
            return Ok(());
        }
        self.width = w;
        self.height = h;
        self.create_target()?;
        self.apply_state();
        Ok(())
    }

    pub fn size(&self) -> (i32, i32) {
        (self.width, self.height)
    }

    /// Read the FBO as tightly packed RGBA (bottom-up rows, GL order).
    pub fn read_pixels(&self) -> Vec<u8> {
        let len = (self.width as usize) * (self.height as usize) * 4;
        let mut buf = vec![0u8; len];
        unsafe {
            (self.fbo_fns.bind_framebuffer)(GL_FRAMEBUFFER, self.fbo);
            (self.api.gl_finish)();
            (self.api.gl_read_pixels)(
                0,
                0,
                self.width,
                self.height,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                buf.as_mut_ptr() as *mut c_void,
            );
        }
        buf
    }

    /// Make the context current on the calling thread (thread hand-off).
    pub fn make_current(&self) -> bool {
        unsafe { (self.api.wgl_make_current)(self.hdc, self.hglrc) != 0 }
    }
}

impl Drop for GlSurface {
    fn drop(&mut self) {
        unsafe {
            (self.fbo_fns.bind_framebuffer)(GL_FRAMEBUFFER, 0);
            if self.fbo != 0 {
                (self.fbo_fns.delete_framebuffers)(1, &self.fbo);
            }
            if self.texture != 0 {
                (self.api.gl_delete_textures)(1, &self.texture);
            }
            (self.api.wgl_make_current)(std::ptr::null_mut(), 0);
            (self.api.wgl_delete_context)(self.hglrc);
            (self.api.release_dc)(self.hwnd, self.hdc);
        }
    }
}

//! libmpv session lifecycle (M7): open URL, transport, tracks, events.
//!
//! One global session at a time (the UI has a single player surface). The mpv
//! event loop runs on a dedicated thread and pushes JSON state to the frontend
//! via Tauri events (`player://state`).
//!
//! Locking rules (avoid deadlocks):
//! - `SESSION` mutex guards only the session record; it is **never** held while
//!   joining the event thread.
//! - The event loop shares `Arc<Mutex<PlayerSnapshot>>` and does not touch
//!   `SESSION`.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::ffi::{
    self, MpvApi, MpvHandle, MpvNodeList, MPV_END_FILE_REASON_EOF, MPV_END_FILE_REASON_ERROR,
    MPV_EVENT_END_FILE,
    MPV_EVENT_FILE_LOADED, MPV_EVENT_IDLE, MPV_EVENT_PAUSE, MPV_EVENT_PLAYBACK_RESTART,
    MPV_EVENT_PROPERTY_CHANGE, MPV_EVENT_SHUTDOWN, MPV_EVENT_TRACKS_CHANGED, MPV_EVENT_UNPAUSE,
    MPV_FORMAT_FLAG, MPV_FORMAT_NODE_ARRAY, MPV_FORMAT_NODE_MAP, MPV_FORMAT_STRING,
    OPEN_FAILED_ERROR,
};
use super::frames;
use super::gl;
use super::host::{self, HostWindow};

/// Tauri event name carrying a full `PlayerSnapshot`.
pub const PLAYER_STATE_EVENT: &str = "player://state";

/* ---------------------------------------------------------------- snapshot */

#[derive(Debug, Clone, Serialize)]
pub struct TrackInfo {
    pub id: i64,
    /// "audio" | "video" | "sub"
    pub kind: String,
    pub title: String,
    pub lang: String,
    pub codec: String,
    pub selected: bool,
    pub external: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerSnapshot {
    pub position: f64,
    pub duration: f64,
    pub pause: bool,
    pub eof: bool,
    pub error: Option<String>,
    pub tracks: Vec<TrackInfo>,
    /// Active hwdec name ("no" when software). Surfaced read-only in Settings.
    pub hwdec: String,
    /// Active video output (`vo-current`) — diagnostic for embed issues.
    pub vo: String,
    /// Decoded frame size (`video-params` w/h), 0 when no video.
    pub video_w: i64,
    pub video_h: i64,
    pub speed: f64,
    pub volume: f64,
    pub mute: bool,
    pub fullscreen: bool,
    pub idle: bool,
    pub file_loaded: bool,
    pub url: String,
}

impl Default for PlayerSnapshot {
    fn default() -> Self {
        PlayerSnapshot {
            position: 0.0,
            duration: 0.0,
            pause: true,
            eof: false,
            error: None,
            tracks: Vec::new(),
            hwdec: "no".to_string(),
            vo: String::new(),
            video_w: 0,
            video_h: 0,
            speed: 1.0,
            volume: 100.0,
            mute: false,
            fullscreen: false,
            idle: true,
            file_loaded: false,
            url: String::new(),
        }
    }
}

/* ----------------------------------------------------------------- session */

type SharedSnapshot = Arc<Mutex<PlayerSnapshot>>;

/// `*mut MpvHandle` wrapper that is `Send` for the event thread.
/// The pointer is only used by the mpv API (documented as callable from any
/// thread for `mpv_wait_event` / property access).
#[derive(Clone, Copy)]
struct SendHandle(*mut MpvHandle);
unsafe impl Send for SendHandle {}
unsafe impl Sync for SendHandle {}

struct SessionInner {
    api: Arc<MpvApi>,
    handle: *mut MpvHandle,
    host: HostWindow,
    app: AppHandle,
    stop: Arc<AtomicBool>,
    snapshot: SharedSnapshot,
    event_thread: Option<JoinHandle<()>>,
    /// Offscreen render loop (`vo=libmpv` → GL FBO → frame stream).
    render_stop: Arc<AtomicBool>,
    render_thread: Option<JoinHandle<()>>,
    render_size: Arc<RenderSize>,
}

/// Desired frame size in physical pixels (JS `player_sync_size` → render target).
struct RenderSize {
    width: AtomicI32,
    height: AtomicI32,
}

impl RenderSize {
    fn new(width: i32, height: i32) -> Arc<RenderSize> {
        Arc::new(RenderSize {
            width: AtomicI32::new(width.max(2)),
            height: AtomicI32::new(height.max(2)),
        })
    }

    fn set(&self, width: i32, height: i32) {
        self.width.store(width.max(2), Ordering::SeqCst);
        self.height.store(height.max(2), Ordering::SeqCst);
    }

    fn get(&self) -> (i32, i32) {
        (
            self.width.load(Ordering::SeqCst),
            self.height.load(Ordering::SeqCst),
        )
    }
}

/// Wake-up signal for the render loop (mpv `update_callback` → render now).
struct RenderSignal {
    flag: Mutex<bool>,
    cv: Condvar,
}

impl RenderSignal {
    fn notify(&self) {
        if let Ok(mut flag) = self.flag.lock() {
            *flag = true;
        }
        self.cv.notify_all();
    }

    fn wait(&self, stop: &AtomicBool) {
        let mut flag = self.flag.lock().unwrap_or_else(|e| e.into_inner());
        while !*flag && !stop.load(Ordering::SeqCst) {
            let (guard, _) = self
                .cv
                .wait_timeout(flag, Duration::from_millis(100))
                .unwrap_or_else(|e| e.into_inner());
            flag = guard;
        }
        *flag = false;
    }
}

unsafe extern "C" fn on_render_update(user: *mut c_void) {
    if user.is_null() {
        return;
    }
    let signal = &*(user as *const RenderSignal);
    signal.notify();
}

/// Owns the GL surface + mpv render context on its thread. Draws each new
/// video frame into the hidden host window's default framebuffer, reads the
/// pixels back and publishes them to the frame stream hub.
fn render_loop(
    api: Arc<MpvApi>,
    handle: SendHandle,
    hwnd: isize,
    size: Arc<RenderSize>,
    hub: Arc<frames::FrameHub>,
    stop: Arc<AtomicBool>,
) {
    let (w, h) = size.get();
    let mut gl = match gl::GlSurface::attach(hwnd, w, h) {
        Ok(surface) => surface,
        Err(e) => {
            eprintln!("[player] GL attach failed: {e}");
            return;
        }
    };
    let handle = handle.0;

    let (get_proc_address, get_proc_address_ctx) = gl.proc_address_fn();
    let init = ffi::MpvOpenGLInitParams {
        get_proc_address: Some(get_proc_address),
        get_proc_address_ctx,
    };
    let rctx = match unsafe { api.render_context_create(handle, &init) } {
        Ok(ctx) => ctx,
        Err(e) => {
            eprintln!("[player] render context failed: {e}");
            return;
        }
    };

    let signal = Box::into_raw(Box::new(RenderSignal {
        flag: Mutex::new(false),
        cv: Condvar::new(),
    }));
    unsafe {
        api.render_context_set_update_callback(
            rctx,
            Some(on_render_update),
            signal as *mut c_void,
        );
    }
    println!("[player] render pipeline ready ({}x{})", w, h);

    let mut rendered: u64 = 0;
    let mut render_errors: u32 = 0;
    while !stop.load(Ordering::SeqCst) {
        unsafe { (*signal).wait(&stop) };
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let (w, h) = size.get();
        if let Err(e) = gl.resize(w, h) {
            eprintln!("[player] GL resize: {e}");
        }
        let (fw, fh) = gl.size();
        // Render into OUR texture-backed FBO (not the hidden window surface —
        // that path produced all-zero readbacks).
        let fbo = ffi::MpvOpenGLFbo {
            fbo: gl.fbo_id(),
            w: fw,
            h: fh,
            internal_format: gl.internal_format(),
        };
        unsafe {
            api.render_context_update(rctx);
        }
        match unsafe { api.render_context_render(rctx, &fbo, false) } {
            Ok(()) => {
                let pixels = gl.read_pixels();
                let pts = unsafe { api.get_property_f64(handle, "time-pos") }.unwrap_or(0.0);
                hub.publish(frames::FramePacket {
                    width: fw as u32,
                    height: fh as u32,
                    pts,
                    pixels,
                });
                rendered += 1;
                // Periodic breadcrumb: proves frames flow and shows whether
                // the picture is actually non-black (mid-frame pixel).
                if rendered == 1 || rendered % 120 == 0 {
                    let packet = hub.peek().map(|(_, p)| p);
                    if let Some(p) = packet {
                        let mid = (((p.height / 2) as usize) * (p.width as usize)
                            + (p.width / 2) as usize)
                            * 4;
                        let px = p.pixels.get(mid..mid + 4).unwrap_or(&[0, 0, 0, 0]);
                        println!(
                            "[player] frames={} size={}x{} pts={:.2} mid_px=RGBA{}/{}/{}/{}",
                            rendered, p.width, p.height, p.pts, px[0], px[1], px[2], px[3]
                        );
                    }
                }
            }
            Err(e) => {
                render_errors += 1;
                if render_errors <= 3 {
                    eprintln!("[player] render error: {e}");
                }
            }
        }
    }
    println!("[player] render loop exit (frames={rendered})");

    unsafe {
        api.render_context_set_update_callback(rctx, None, std::ptr::null_mut());
        api.render_context_free(rctx);
        drop(Box::from_raw(signal));
    }
}

// `MpvHandle` is only used under the session mutex / event thread protocol.
unsafe impl Send for SessionInner {}

struct Session {
    inner: Mutex<Option<SessionInner>>,
}

fn session() -> &'static Session {
    static SESSION: OnceLock<Session> = OnceLock::new();
    SESSION.get_or_init(|| Session {
        inner: Mutex::new(None),
    })
}

fn emit_state(app: &AppHandle, snap: &PlayerSnapshot) {
    let _ = app.emit(PLAYER_STATE_EVENT, snap.clone());
}

/// Clamp playback speed to the product range 0.25–2.0.
pub fn clamp_speed(speed: f64) -> f64 {
    if !speed.is_finite() {
        return 1.0;
    }
    speed.clamp(0.25, 2.0)
}

/// Clamp an absolute seek into [0, duration] (duration 0 → no upper bound).
pub fn clamp_seek(seconds: f64, duration: f64) -> f64 {
    if !seconds.is_finite() {
        return 0.0;
    }
    let lo = 0.0;
    let hi = if duration.is_finite() && duration > 0.0 {
        duration
    } else {
        f64::MAX
    };
    seconds.max(lo).min(hi)
}

unsafe fn read_tracks(api: &MpvApi, handle: *mut MpvHandle) -> Vec<TrackInfo> {
    let mut out = Vec::new();
    let node_ptr = match api.get_property_node(handle, "track-list") {
        Ok(n) => n,
        Err(_) => return out,
    };

    {
        let node = &*node_ptr;
        if node.format == MPV_FORMAT_NODE_ARRAY {
            let list = node.data.list;
            if !list.is_null() {
                let list_ref: &MpvNodeList = &*list;
                let num = list_ref.num.max(0) as usize;
                for i in 0..num {
                    if list_ref.values.is_null() {
                        break;
                    }
                    let item = &*list_ref.values.add(i);
                    if item.format != MPV_FORMAT_NODE_MAP {
                        continue;
                    }
                    let map = item.data.list;
                    if map.is_null() {
                        continue;
                    }
                    let map_ref: &MpvNodeList = &*map;
                    let id = ffi::map_get(map_ref, "id")
                        .and_then(|n| ffi::node_int64(n))
                        .unwrap_or(0);
                    let kind = ffi::map_get(map_ref, "type")
                        .and_then(|n| ffi::node_string(n))
                        .unwrap_or_default();
                    let title = ffi::map_get(map_ref, "title")
                        .and_then(|n| ffi::node_string(n))
                        .unwrap_or_default();
                    let lang = ffi::map_get(map_ref, "lang")
                        .and_then(|n| ffi::node_string(n))
                        .unwrap_or_default();
                    let codec = ffi::map_get(map_ref, "codec")
                        .and_then(|n| ffi::node_string(n))
                        .unwrap_or_default();
                    let selected = ffi::map_get(map_ref, "selected")
                        .and_then(|n| ffi::node_flag(n))
                        .unwrap_or(false);
                    let external = ffi::map_get(map_ref, "external")
                        .and_then(|n| ffi::node_flag(n))
                        .unwrap_or(false);
                    out.push(TrackInfo {
                        id,
                        kind,
                        title,
                        lang,
                        codec,
                        selected,
                        external,
                    });
                }
            }
        }
    }

    api.free_node_contents(node_ptr);
    drop(Box::from_raw(node_ptr));
    out
}

unsafe fn refresh_snapshot(api: &MpvApi, handle: *mut MpvHandle, snap: &mut PlayerSnapshot) {
    snap.position = api.get_property_f64(handle, "time-pos").unwrap_or(0.0);
    snap.duration = api.get_property_f64(handle, "duration").unwrap_or(0.0);
    snap.pause = api.get_property_flag(handle, "pause").unwrap_or(true);
    snap.eof = api.get_property_flag(handle, "eof-reached").unwrap_or(false);
    snap.speed = api.get_property_f64(handle, "speed").unwrap_or(1.0);
    snap.volume = api.get_property_f64(handle, "volume").unwrap_or(100.0);
    snap.mute = api.get_property_flag(handle, "mute").unwrap_or(false);
    snap.hwdec = api
        .get_property_string(handle, "hwdec-current")
        .unwrap_or_else(|_| "no".to_string());
    snap.vo = api
        .get_property_string(handle, "vo-current")
        .unwrap_or_default();
    snap.video_w = api
        .get_property_f64(handle, "width")
        .unwrap_or(0.0)
        .max(0.0) as i64;
    snap.video_h = api
        .get_property_f64(handle, "height")
        .unwrap_or(0.0)
        .max(0.0) as i64;
    snap.idle = api
        .get_property_flag(handle, "idle-active")
        .unwrap_or(snap.idle);
    snap.file_loaded = api
        .get_property_flag(handle, "file-loaded")
        .unwrap_or(snap.file_loaded);
    snap.tracks = read_tracks(api, handle);
}

/// Wire property observers so the event thread receives change notifications.
unsafe fn observe_core(api: &MpvApi, handle: *mut MpvHandle) {
    let pairs: &[(u64, &str, i32)] = &[
        (1, "time-pos", ffi::MPV_FORMAT_DOUBLE),
        (2, "duration", ffi::MPV_FORMAT_DOUBLE),
        (3, "pause", MPV_FORMAT_FLAG),
        (4, "eof-reached", MPV_FORMAT_FLAG),
        (5, "track-list", ffi::MPV_FORMAT_NODE),
        (6, "hwdec-current", MPV_FORMAT_STRING),
        (7, "speed", ffi::MPV_FORMAT_DOUBLE),
        (8, "volume", ffi::MPV_FORMAT_DOUBLE),
    ];
    for (id, name, fmt) in pairs {
        let _ = api.observe_property(handle, *id, name, *fmt);
    }
}

/// Make the WebView chrome see-through so the mpv `wid` child shows behind it.
/// Currently unused: the host is HWND_TOP above the webview (see host.rs).
#[allow(dead_code)]
fn set_webview_transparent(app: &AppHandle, transparent: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let color = if transparent {
            Some(tauri::window::Color(0, 0, 0, 0))
        } else {
            Some(tauri::window::Color(0, 0, 0, 255))
        };
        let _ = window.set_background_color(color);
    }
}

/// Open `url` in a fresh libmpv session bound to a child HWND of `parent_hwnd`.
///
/// `external_audio_urls` are attached as mpv `audio-files` (non-embedded tracks).
pub fn open(
    app: AppHandle,
    url: String,
    parent_hwnd: isize,
    start_at: Option<f64>,
    external_audio_urls: Vec<String>,
) -> Result<(), String> {
    // Tear down any previous session *outside* the new one's lock (join-safe).
    destroy();

    let api = super::load_api()?;
    let host = HostWindow::create(parent_hwnd)?;

    let handle = unsafe { api.create()? };

    // Options must be set before initialize.
    // vo=libmpv: render API into an offscreen GL target (see `gl.rs` +
    // `frames.rs`) — the page canvas receives the pixels, so HTML chrome can
    // freely overlay the video (no HWND z-order fights with WebView2).
    if let Err(e) = unsafe { api.set_option_string(handle, "vo", "libmpv") } {
        unsafe { api.terminate_destroy(handle) };
        return Err(e);
    }

    // HW decode with automatic software fallback (hwdec=auto-safe).
    if let Err(e) = unsafe { api.set_option_string(handle, "hwdec", "auto-safe") } {
        unsafe { api.terminate_destroy(handle) };
        return Err(e);
    }

    // Keep the last frame at EOF; no OSC/input (UI owns controls).
    let _ = unsafe { api.set_option_string(handle, "keep-open", "yes") };
    let _ = unsafe { api.set_option_string(handle, "osc", "no") };
    let _ = unsafe { api.set_option_string(handle, "input-default-bindings", "no") };
    let _ = unsafe { api.set_option_string(handle, "input-cursor", "no") };
    // External (non-embedded) audio tracks: ac3/m4a sidecar files.
    if !external_audio_urls.is_empty() {
        let joined = external_audio_urls
            .iter()
            .filter(|u| !u.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(":");
        if !joined.is_empty() {
            let _ = unsafe { api.set_option_string(handle, "audio-files", &joined) };
        }
    }
    // Do not set force-window: it can allocate a black surface before the
    // first frame and confuse the embed path on some builds.

    if let Err(e) = unsafe { api.initialize(handle) } {
        unsafe { api.terminate_destroy(handle) };
        return Err(e);
    }

    // Size the hidden GL anchor window to the default render target; the
    // frontend overrides this via `player_sync_size` with the canvas size.
    host.fit_parent();
    unsafe { observe_core(&api, handle) };

    if let Some(secs) = start_at {
        if secs.is_finite() && secs > 0.0 {
            let _ = unsafe { api.set_property_f64(handle, "start", secs) };
        }
    }

    let mut snapshot = PlayerSnapshot {
        url: url.clone(),
        ..Default::default()
    };

    // Load the presigned media URL (any container/codec libmpv supports).
    let load_error =
        unsafe { api.command(handle, &["loadfile", url.as_str(), "replace"]) }.err();
    if load_error.is_some() {
        snapshot.error = Some(OPEN_FAILED_ERROR.to_string());
        snapshot.pause = true;
    }
    unsafe { refresh_snapshot(&api, handle, &mut snapshot) };
    if load_error.is_some() {
        snapshot.error = Some(OPEN_FAILED_ERROR.to_string());
    }
    emit_state(&app, &snapshot);

    let shared: SharedSnapshot = Arc::new(Mutex::new(snapshot));
    let stop = Arc::new(AtomicBool::new(false));

    let thread_api = api.clone();
    let thread_app = app.clone();
    let thread_stop = stop.clone();
    let thread_snap = shared.clone();
    let thread_handle = SendHandle(handle);
    let event_thread = std::thread::spawn(move || {
        event_loop(thread_api, thread_handle, thread_app, thread_stop, thread_snap);
    });

    // Offscreen render loop: mpv → GL → frame stream (page canvas).
    let (anchor_w, anchor_h) = host.client_size();
    let render_size = RenderSize::new(anchor_w, anchor_h);
    let render_stop = Arc::new(AtomicBool::new(false));
    let render_thread = {
        let api = api.clone();
        let handle = SendHandle(handle);
        let hwnd = host.hwnd();
        let size = render_size.clone();
        let hub = frames::hub();
        let stop = render_stop.clone();
        std::thread::spawn(move || {
            render_loop(api, handle, hwnd, size, hub, stop);
        })
    };
    let _ = frames::ensure_started();

    let inner = SessionInner {
        api,
        handle,
        host,
        app,
        stop,
        snapshot: shared,
        event_thread: Some(event_thread),
        render_stop,
        render_thread: Some(render_thread),
        render_size,
    };

    // Store only after the thread is running; destroy() joins without holding
    // this mutex (see `destroy`).
    if let Ok(mut guard) = session().inner.lock() {
        *guard = Some(inner);
    }
    Ok(())
}

/// Tear down a session. `inner` must already be removed from `SESSION`.
fn teardown(mut inner: SessionInner) {
    // Stop the render loop first: it owns the GL context and the mpv render
    // context, which must be freed before the mpv handle is destroyed.
    inner.render_stop.store(true, Ordering::SeqCst);
    if let Some(handle) = inner.render_thread.take() {
        let _ = handle.join();
    }
    // Signal the event loop next, then join *before* destroying the mpv
    // handle: the loop may still call get_property until it observes `stop`
    // (wait_event timeout is 0.25s). Destroying first is a use-after-free.
    inner.stop.store(true, Ordering::SeqCst);
    if let Some(handle) = inner.event_thread.take() {
        // Never called while holding `SESSION` — the event loop uses its own
        // snapshot lock and would otherwise deadlock on join.
        let _ = handle.join();
    }
    unsafe {
        inner.api.terminate_destroy(inner.handle);
    }
    inner.host.destroy();
}

/// Tear down the player (window close / route leave). Safe when idle.
pub fn destroy() {
    let taken = match session().inner.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(inner) = taken {
        teardown(inner);
    }
}

/// Latest snapshot for `player_get_state` / the first paint after mount.
pub fn current_state() -> PlayerSnapshot {
    let inner = match session().inner.lock() {
        Ok(guard) => guard.as_ref().map(|s| s.snapshot.clone()),
        Err(poisoned) => poisoned
            .into_inner()
            .as_ref()
            .map(|s| s.snapshot.clone()),
    };
    match inner {
        Some(shared) => shared.lock().map(|s| s.clone()).unwrap_or_default(),
        None => PlayerSnapshot::default(),
    }
}

fn with_session<T>(
    f: impl FnOnce(&MpvApi, *mut MpvHandle, &SharedSnapshot) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = session()
        .inner
        .lock()
        .map_err(|e| format!("player lock: {e}"))?;
    let inner = guard.as_mut().ok_or("Плеер не запущен")?;
    // Split borrows: api/handle are read-only, snapshot is shared.
    let api = inner.api.clone();
    let handle = inner.handle;
    let shared = inner.snapshot.clone();
    let app = inner.app.clone();
    let out = f(api.as_ref(), handle, &shared)?;
    if let Ok(snap) = shared.lock() {
        emit_state(&app, &snap);
    }
    Ok(out)
}

pub fn play() -> Result<(), String> {
    with_session(|api, handle, shared| unsafe {
        api.set_property_flag(handle, "pause", false)?;
        if let Ok(mut snap) = shared.lock() {
            snap.pause = false;
            snap.eof = false;
        }
        Ok(())
    })
}

pub fn pause() -> Result<(), String> {
    with_session(|api, handle, shared| unsafe {
        api.set_property_flag(handle, "pause", true)?;
        if let Ok(mut snap) = shared.lock() {
            snap.pause = true;
        }
        Ok(())
    })
}

pub fn toggle_pause() -> Result<(), String> {
    with_session(|api, handle, shared| {
        let paused = unsafe { api.get_property_flag(handle, "pause") }.unwrap_or(true);
        unsafe { api.set_property_flag(handle, "pause", !paused)? };
        if let Ok(mut snap) = shared.lock() {
            snap.pause = !paused;
        }
        Ok(())
    })
}

/// Absolute seek to `seconds` (clamped to duration + progressive ceiling).
///
/// Progressive ceiling is a process-global (seconds) set via
/// `set_max_seekable_sec` from the playback poll. It is **not** held in
/// `SESSION` so `seek` cannot deadlock with `with_session`.
pub fn seek(seconds: f64) -> Result<(), String> {
    with_session(|api, handle, shared| {
        let duration = shared
            .lock()
            .map(|s| s.duration)
            .unwrap_or(0.0);
        let mut target = clamp_seek(seconds, duration);
        if let Some(ceiling) = max_seekable_sec() {
            target = target.min(ceiling);
        }
        unsafe { api.set_property_f64(handle, "time-pos", target)? };
        if let Ok(mut snap) = shared.lock() {
            snap.position = target;
            snap.eof = false;
        }
        Ok(())
    })
}

/// Bits of the progressive seek ceiling in seconds (`f64`).
/// `0` means unlimited (VOD / unknown).
fn max_seekable_sec_bits() -> &'static std::sync::atomic::AtomicU64 {
    static BITS: OnceLock<std::sync::atomic::AtomicU64> = OnceLock::new();
    BITS.get_or_init(|| std::sync::atomic::AtomicU64::new(0))
}

/// Current progressive seek ceiling in seconds, or `None` when unrestricted.
pub fn max_seekable_sec() -> Option<f64> {
    let bits = max_seekable_sec_bits().load(Ordering::SeqCst);
    if bits == 0 {
        return None;
    }
    let value = f64::from_bits(bits);
    if value.is_finite() && value > 0.0 {
        Some(value)
    } else {
        None
    }
}

/// Update the progressive seek ceiling in seconds (`None` clears it for VOD).
pub fn set_max_seekable_sec(seconds: Option<f64>) {
    let bits = match seconds {
        Some(s) if s.is_finite() && s > 0.0 => s.to_bits(),
        _ => 0,
    };
    max_seekable_sec_bits().store(bits, Ordering::SeqCst);
}

pub fn set_speed(speed: f64) -> Result<(), String> {
    with_session(|api, handle, shared| {
        let v = clamp_speed(speed);
        unsafe { api.set_property_f64(handle, "speed", v)? };
        if let Ok(mut snap) = shared.lock() {
            snap.speed = v;
        }
        Ok(())
    })
}

pub fn set_volume(volume: f64) -> Result<(), String> {
    with_session(|api, handle, shared| {
        let v = if volume.is_finite() {
            volume.clamp(0.0, 100.0)
        } else {
            100.0
        };
        unsafe { api.set_property_f64(handle, "volume", v)? };
        if let Ok(mut snap) = shared.lock() {
            snap.volume = v;
            if v > 0.0 && snap.mute {
                let _ = unsafe { api.set_property_flag(handle, "mute", false) };
                snap.mute = false;
            }
        }
        Ok(())
    })
}

pub fn set_mute(mute: bool) -> Result<(), String> {
    with_session(|api, handle, shared| unsafe {
        api.set_property_flag(handle, "mute", mute)?;
        if let Ok(mut snap) = shared.lock() {
            snap.mute = mute;
        }
        Ok(())
    })
}

/// Select an audio track by mpv track id (`0`/negative disables audio).
pub fn set_audio_track(id: i64) -> Result<(), String> {
    with_session(|api, handle, shared| {
        let value = if id <= 0 {
            "no".to_string()
        } else {
            id.to_string()
        };
        unsafe { api.set_property_string(handle, "aid", &value)? };
        if let Ok(mut snap) = shared.lock() {
            for t in snap.tracks.iter_mut() {
                if t.kind == "audio" {
                    t.selected = t.id == id && id > 0;
                }
            }
        }
        Ok(())
    })
}

/// Select a subtitle track by id; `None` (or `<= 0`) turns subtitles off.
pub fn set_subtitle_track(id: Option<i64>) -> Result<(), String> {
    with_session(|api, handle, shared| {
        let id = id.unwrap_or(0);
        let value = if id <= 0 {
            "no".to_string()
        } else {
            id.to_string()
        };
        unsafe { api.set_property_string(handle, "sid", &value)? };
        if let Ok(mut snap) = shared.lock() {
            for t in snap.tracks.iter_mut() {
                if t.kind == "sub" {
                    t.selected = t.id == id && id > 0;
                }
            }
        }
        Ok(())
    })
}

pub fn list_tracks() -> Result<Vec<TrackInfo>, String> {
    with_session(|api, handle, shared| {
        let tracks = unsafe { read_tracks(api, handle) };
        if let Ok(mut snap) = shared.lock() {
            snap.tracks = tracks.clone();
        }
        Ok(tracks)
    })
}

/// Toggle/set fullscreen on the Tauri window (video surface follows via resize).
pub fn set_fullscreen(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "player: main window not found".to_string())?;
    window
        .set_fullscreen(enabled)
        .map_err(|e| format!("fullscreen: {e}"))?;

    sync_host_size();

    if let Ok(guard) = session().inner.lock() {
        if let Some(inner) = guard.as_ref() {
            if let Ok(mut snap) = inner.snapshot.lock() {
                snap.fullscreen = enabled;
                emit_state(&inner.app, &snap);
            }
        }
    }
    Ok(())
}

pub fn toggle_fullscreen(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "player: main window not found".to_string())?;
    let current = window
        .is_fullscreen()
        .map_err(|e| format!("fullscreen: {e}"))?;
    set_fullscreen(app, !current)
}

/// Keep the mpv child window on the last known video rect (legacy fit when the
/// DOM has not supplied one yet). Called after window resize / fullscreen.
pub fn sync_host_size() {
    if let Ok(mut guard) = session().inner.lock() {
        if let Some(inner) = guard.as_mut() {
            inner.host.fit_parent();
        }
    }
}

/// Size the frame stream render target (JS `player_sync_size`, physical px).
/// The hidden GL anchor window tracks the same size — its client area *is*
/// the default framebuffer mpv renders into. x/y are ignored (nothing is
/// positioned on screen anymore).
pub fn sync_host_rect(_x: i32, _y: i32, width: i32, height: i32) {
    if let Ok(mut guard) = session().inner.lock() {
        if let Some(inner) = guard.as_mut() {
            inner.render_size.set(width, height);
            inner.host.set_video_rect(0, 0, width, height);
        }
    }
}

/* ------------------------------------------------------------- event loop */

fn event_loop(
    api: Arc<MpvApi>,
    handle: SendHandle,
    app: AppHandle,
    stop: Arc<AtomicBool>,
    snapshot: SharedSnapshot,
) {
    let handle = handle.0;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut pending_emit = false;

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }

        let event = unsafe { api.wait_event(handle, 0.25) };
        if !event.is_null() {
            let event_id = unsafe { (*event).event_id };
            match event_id {
                MPV_EVENT_SHUTDOWN => break,
                MPV_EVENT_END_FILE => {
                    let reason = unsafe {
                        let data = (*event).data as *const ffi::MpvEventEndFile;
                        if data.is_null() {
                            0
                        } else {
                            (*data).reason
                        }
                    };
                    if let Ok(mut snap) = snapshot.lock() {
                        if reason == MPV_END_FILE_REASON_ERROR {
                            snap.error = Some(OPEN_FAILED_ERROR.to_string());
                            snap.pause = true;
                            snap.file_loaded = false;
                            emit_state(&app, &snap);
                        } else if reason == MPV_END_FILE_REASON_EOF {
                            snap.eof = true;
                            snap.pause = true;
                            emit_state(&app, &snap);
                        }
                    }
                }
                MPV_EVENT_FILE_LOADED
                | MPV_EVENT_PLAYBACK_RESTART
                | MPV_EVENT_TRACKS_CHANGED => {
                    if let Ok(mut snap) = snapshot.lock() {
                        unsafe {
                            refresh_snapshot(&api, handle, &mut snap);
                        }
                        snap.error = None;
                        snap.file_loaded =
                            event_id == MPV_EVENT_FILE_LOADED || snap.file_loaded;
                        emit_state(&app, &snap);
                        last_emit = Instant::now();
                        pending_emit = false;
                    }
                }
                MPV_EVENT_PAUSE | MPV_EVENT_UNPAUSE | MPV_EVENT_IDLE => {
                    if let Ok(mut snap) = snapshot.lock() {
                        unsafe {
                            refresh_snapshot(&api, handle, &mut snap);
                        }
                        emit_state(&app, &snap);
                        last_emit = Instant::now();
                        pending_emit = false;
                    }
                }
                MPV_EVENT_PROPERTY_CHANGE => {
                    // time-pos / duration stream in; throttle the JS emit.
                    if let Ok(mut snap) = snapshot.lock() {
                        unsafe {
                            refresh_snapshot(&api, handle, &mut snap);
                        }
                        pending_emit = true;
                    }
                }
                _ => {}
            }
        }

        // Flush throttled progress emits. Must run every iteration, not only on
        // wait_event timeouts: during playback time-pos events stream in
        // continuously and the timeout branch is never reached — the clock
        // would freeze except on pause/unpause.
        if pending_emit && last_emit.elapsed() >= Duration::from_millis(250) {
            if let Ok(snap) = snapshot.lock() {
                emit_state(&app, &snap);
            }
            last_emit = Instant::now();
            pending_emit = false;
        }
    }
}

/// Parent HWND helper re-exported for commands.
pub fn main_window_hwnd(app: &AppHandle) -> Result<isize, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "player: main window not found".to_string())?;
    host::hwnd_from_tauri(&window)
}

#[cfg(test)]
mod tests {
    use super::{clamp_seek, clamp_speed};

    #[test]
    fn speed_clamps_to_product_range() {
        assert_eq!(clamp_speed(0.1), 0.25);
        assert_eq!(clamp_speed(0.25), 0.25);
        assert_eq!(clamp_speed(1.0), 1.0);
        assert_eq!(clamp_speed(2.0), 2.0);
        assert_eq!(clamp_speed(5.0), 2.0);
        assert_eq!(clamp_speed(f64::NAN), 1.0);
    }

    #[test]
    fn seek_clamps_into_duration() {
        assert_eq!(clamp_seek(-5.0, 100.0), 0.0);
        assert_eq!(clamp_seek(50.0, 100.0), 50.0);
        assert_eq!(clamp_seek(150.0, 100.0), 100.0);
        assert_eq!(clamp_seek(-1.0, 0.0), 0.0);
    }
}

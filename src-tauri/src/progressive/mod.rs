//! Progressive playback source (local loopback HTTP range server).
//!
//! While the backend is still downloading a file into S3, the client must only
//! expose the contiguous seekable prefix (`max_seekable_bytes`). This module
//! serves that virtual file to libmpv over `http://127.0.0.1:<port>/` and maps
//! Range requests onto segment GETs (clipped to the last reported prefix).
//!
//! Product contract:
//! - Never serve bytes at/after `max_seekable_bytes`, even if a later segment
//!   is already on S3. The prefix only grows when the playback/index poll
//!   updates it via `update()`.
//! - Skip segment holes (`available = false`) by zero-filling — the UI already
//!   blocks seeks there; the demuxer still needs a contiguous byte stream.
//! - Loopback only (127.0.0.1). No remote bind.

pub mod commands;

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

/// One byte slice of the virtual file, backed by a remote segment URL.
#[derive(Debug, Clone)]
pub struct SegmentSpec {
    pub index: i64,
    pub start: u64,
    pub end: u64,
    pub url: String,
    pub available: bool,
}

#[derive(Debug, Clone)]
pub struct ProgressiveConfig {
    /// Total virtual file size (`video.size_bytes`).
    pub size_bytes: u64,
    /// Contiguous seekable prefix — source of truth for the ceiling.
    pub max_seekable_bytes: u64,
    pub segments: Vec<SegmentSpec>,
}

/// Shared live state used by accept threads and limit updates.
struct LiveState {
    config: Mutex<ProgressiveConfig>,
    stop: Arc<AtomicBool>,
    /// Atomic copy of the ceiling for lock-free Range checks.
    max_seekable: AtomicU64,
}

struct ServerHandle {
    stop: Arc<AtomicBool>,
    port: u16,
    join: Option<JoinHandle<()>>,
}

static LIVE: OnceLock<Mutex<Option<Arc<LiveState>>>> = OnceLock::new();
static SERVER: OnceLock<Mutex<Option<ServerHandle>>> = OnceLock::new();

fn live_slot() -> &'static Mutex<Option<Arc<LiveState>>> {
    LIVE.get_or_init(|| Mutex::new(None))
}

fn server_slot() -> &'static Mutex<Option<ServerHandle>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// Start (or replace) the progressive source. Returns `http://127.0.0.1:<port>/`.
pub fn start(config: ProgressiveConfig) -> Result<String, String> {
    stop_internal();

    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let state = Arc::new(LiveState {
        max_seekable: AtomicU64::new(config.max_seekable_bytes),
        config: Mutex::new(config),
        stop: stop_flag.clone(),
    });

    let thread_state = state.clone();
    let join = std::thread::spawn(move || {
        accept_loop(listener, thread_state);
    });

    if let Ok(mut guard) = live_slot().lock() {
        *guard = Some(state);
    }
    if let Ok(mut guard) = server_slot().lock() {
        *guard = Some(ServerHandle {
            stop: stop_flag,
            port,
            join: Some(join),
        });
    }

    Ok(format!("http://127.0.0.1:{port}/"))
}

/// Update the contiguous prefix after a playback/index poll. Optionally
/// refresh segment availability/URLs when the backend rotates signed links.
pub fn update(
    max_seekable_bytes: u64,
    segments: Option<Vec<SegmentSpec>>,
    size_bytes: Option<u64>,
) -> Result<(), String> {
    let live = live_slot()
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .as_ref()
        .cloned()
        .ok_or_else(|| "progressive source is not running".to_string())?;

    live.max_seekable.store(max_seekable_bytes, Ordering::SeqCst);
    let mut cfg = live.config.lock().map_err(|e| format!("lock: {e}"))?;
    cfg.max_seekable_bytes = max_seekable_bytes;
    if let Some(size) = size_bytes {
        cfg.size_bytes = size;
    }
    if let Some(segs) = segments {
        cfg.segments = segs;
    }
    Ok(())
}

fn stop_internal() {
    let live = live_slot().lock().ok().and_then(|mut g| g.take());
    if let Some(live) = live {
        live.stop.store(true, Ordering::SeqCst);
    }
    if let Ok(mut guard) = server_slot().lock() {
        if let Some(mut server) = guard.take() {
            server.stop.store(true, Ordering::SeqCst);
            // Unblock accept() with a dummy connection.
            let _ = TcpStream::connect(("127.0.0.1", server.port));
            if let Some(handle) = server.join.take() {
                let _ = handle.join();
            }
        }
    }
}

/// Stop the progressive source (player destroy / complete → VOD switch).
pub fn stop() {
    stop_internal();
}

/// Current seekable ceiling in bytes (0 when not running).
pub fn current_max_seekable() -> u64 {
    live_slot()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.max_seekable.load(Ordering::SeqCst)))
        .unwrap_or(0)
}

/// Diagnostics: bound port (0 when not running).
pub fn current_port() -> u16 {
    server_slot()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.port))
        .unwrap_or(0)
}

/* --------------------------------------------------------------- HTTP bits */

fn accept_loop(listener: TcpListener, state: Arc<LiveState>) {
    for stream in listener.incoming() {
        if state.stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(stream) = stream else { continue };
        let st = state.clone();
        std::thread::spawn(move || {
            let _ = handle_connection(stream, st);
        });
    }
}

fn handle_connection(mut stream: TcpStream, state: Arc<LiveState>) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));

    let mut buf = [0u8; 8192];
    let mut req = Vec::new();
    loop {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }
        req.extend_from_slice(&buf[..n]);
        if req.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if req.len() > 64 * 1024 {
            break;
        }
    }

    let text = String::from_utf8_lossy(&req);
    let mut lines = text.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let _path = parts.next().unwrap_or("/");

    if method != "GET" && method != "HEAD" {
        write_status(&mut stream, 405, "Method Not Allowed", 0, None)?;
        return Ok(());
    }

    let mut range: Option<(u64, u64)> = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Range:") {
            range = parse_range(value.trim());
        }
    }

    let (size, usable) = {
        let cfg = state.config.lock().unwrap_or_else(|e| e.into_inner());
        let live_ceiling = state.max_seekable.load(Ordering::SeqCst);
        let ceiling = if live_ceiling > 0 {
            live_ceiling
        } else {
            cfg.max_seekable_bytes
        };
        (cfg.size_bytes, ceiling.min(cfg.size_bytes))
    };

    // Hard contract clip: never leave the contiguous prefix.
    if usable == 0 {
        write_status(&mut stream, 503, "Not Ready", 0, None)?;
        return Ok(());
    }

    let (start, end_inclusive) = match range {
        Some((s, e)) => {
            let e = if e == u64::MAX { usable.saturating_sub(1) } else { e };
            if s >= usable || s > e {
                write_status(
                    &mut stream,
                    416,
                    "Range Not Satisfiable",
                    0,
                    Some((0, usable.saturating_sub(1), size)),
                )?;
                return Ok(());
            }
            (s, e.min(usable.saturating_sub(1)))
        }
        None => (0, usable.saturating_sub(1)),
    };

    let content_len = end_inclusive - start + 1;
    write_status(
        &mut stream,
        206,
        "Partial Content",
        content_len,
        Some((start, end_inclusive, size)),
    )?;

    if method == "HEAD" {
        return Ok(());
    }

    serve_byte_range(&mut stream, &state, start, end_inclusive)?;
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Write);
    Ok(())
}

fn write_status(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    content_len: u64,
    content_range: Option<(u64, u64, u64)>,
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {code} {reason}\r\nAccept-Ranges: bytes\r\nContent-Length: {content_len}\r\n"
    );
    if let Some((s, e, size)) = content_range {
        head.push_str(&format!("Content-Range: bytes {s}-{e}/{size}\r\n"));
    }
    head.push_str("Content-Type: application/octet-stream\r\nConnection: close\r\n\r\n");
    stream.write_all(head.as_bytes())
}

fn parse_range(value: &str) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?;
    let mut it = value.split('-');
    let start = it.next()?.trim();
    let end = it.next()?.trim();
    if start.is_empty() {
        // Suffix form: bytes=-N (last N bytes). We only serve a prefix, so map
        // onto the seekable ceiling when it fits, else fail closed via caller.
        let n: u64 = end.parse().ok()?;
        return Some((u64::MAX.saturating_sub(n.saturating_sub(1)), u64::MAX));
    }
    let s: u64 = start.parse().ok()?;
    let e: u64 = if end.is_empty() {
        u64::MAX
    } else {
        end.parse().ok()?
    };
    Some((s, e))
}

/// Fetch `[start, end_inclusive]` of the virtual file from segments and write it.
fn serve_byte_range(
    stream: &mut TcpStream,
    state: &Arc<LiveState>,
    start: u64,
    end_inclusive: u64,
) -> std::io::Result<()> {
    let segments = {
        let cfg = state.config.lock().unwrap_or_else(|e| e.into_inner());
        cfg.segments.clone()
    };

    let mut cursor = start;
    while cursor <= end_inclusive {
        let seg = segments
            .iter()
            .find(|s| s.available && s.start <= cursor && cursor < s.end)
            .cloned();
        let Some(seg) = seg else {
            // Hole: zero-fill so the demuxer sees a contiguous stream. The UI
            // already blocks seeks past the reported prefix.
            let hole_end = segments
                .iter()
                .filter(|s| s.start > cursor)
                .map(|s| s.start)
                .min()
                .unwrap_or(end_inclusive + 1)
                .min(end_inclusive + 1);
            let zeros = vec![0u8; 64 * 1024];
            let mut pos = cursor;
            while pos < hole_end {
                let n = ((hole_end - pos) as usize).min(zeros.len());
                stream.write_all(&zeros[..n])?;
                pos += n as u64;
            }
            cursor = hole_end;
            continue;
        };

        let seg_from = cursor.max(seg.start);
        let seg_to = (end_inclusive + 1).min(seg.end);
        if seg_to <= seg_from {
            cursor = seg.end.max(cursor + 1);
            continue;
        }

        // Range inside the remote segment object.
        let remote_from = seg_from - seg.start;
        let remote_to = seg_to - seg.start - 1;
        match fetch_segment_range(&seg.url, remote_from, remote_to) {
            Ok(bytes) => {
                let mut pos = 0usize;
                while pos < bytes.len() {
                    let n = stream.write(&bytes[pos..])?;
                    if n == 0 {
                        return Ok(());
                    }
                    pos += n;
                }
            }
            Err(_) => {
                let len = (seg_to - seg_from) as usize;
                let zeros = vec![0u8; len.min(64 * 1024)];
                let mut left = len;
                while left > 0 {
                    let n = left.min(zeros.len());
                    stream.write_all(&zeros[..n])?;
                    left -= n;
                }
            }
        }
        cursor = seg_to;
    }
    Ok(())
}

/// HTTP(S) GET with a byte range from a segment URL (S3).
fn fetch_segment_range(url: &str, from: u64, to: u64) -> Result<Vec<u8>, String> {
    let agent = ureq::builder()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60))
        .build();
    let resp = agent
        .get(url)
        .set("Range", &format!("bytes={from}-{to}"))
        .call()
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    if status != 200 && status != 206 {
        return Err(format!("segment HTTP {status}"));
    }
    let mut out = Vec::new();
    resp.into_reader()
        .take(64 * 1024 * 1024)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Map JS segment payload into Rust.
pub fn segments_from_json(values: &[serde_json::Value]) -> Vec<SegmentSpec> {
    let mut out = Vec::with_capacity(values.len());
    for v in values {
        out.push(SegmentSpec {
            index: v.get("index").and_then(|x| x.as_i64()).unwrap_or(0),
            start: v.get("start").and_then(|x| x.as_u64()).unwrap_or(0),
            end: v.get("end").and_then(|x| x.as_u64()).unwrap_or(0),
            url: v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            available: v
                .get("available")
                .and_then(|x| x.as_bool())
                .unwrap_or(true),
        });
    }
    out
}

/// Clip a requested byte range to the seekable prefix (pure helper).
pub fn clip_to_seekable(start: u64, end: u64, max_seekable: u64) -> (u64, u64) {
    if max_seekable == 0 {
        return (0, 0);
    }
    let s = start.min(max_seekable);
    let e = end.min(max_seekable.saturating_sub(1));
    if s > e {
        (s, s)
    } else {
        (s, e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_never_exceeds_prefix() {
        assert_eq!(clip_to_seekable(0, 1000, 250), (0, 249));
        assert_eq!(clip_to_seekable(200, 1000, 250), (200, 249));
        // Entirely past the prefix: empty at the ceiling (start clipped).
        assert_eq!(clip_to_seekable(300, 1000, 250), (250, 250));
        assert_eq!(clip_to_seekable(0, 10, 0), (0, 0));
    }

    #[test]
    fn parse_range_header() {
        assert_eq!(parse_range("bytes=0-99"), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-"), Some((100, u64::MAX)));
        assert_eq!(parse_range("bytes=0-0"), Some((0, 0)));
    }

    #[test]
    fn segments_from_json_parses_contract() {
        let raw = serde_json::json!([
            {"index": 0, "start": 0, "end": 8388608, "url": "s0", "available": true},
            {"index": 1, "start": 8388608, "end": 16777216, "url": "s1", "available": false}
        ]);
        let segs = segments_from_json(raw.as_array().unwrap());
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].end, 8388608);
        assert!(!segs[1].available);
    }
}

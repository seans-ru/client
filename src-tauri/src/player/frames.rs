//! Frame stream: offscreen mpv pixels → the page canvas (loopback HTTP).
//!
//! The render thread publishes RGBA frames into a latest-wins hub; a tiny
//! HTTP server on `127.0.0.1` streams them to the frontend as a raw binary
//! body (`Connection: close`, no Content-Length — Chromium's fetch delivers
//! the body until EOF through a `ReadableStream`).
//!
//! Wire format per frame (little-endian):
//!   `u32 width | u32 height | f64 pts_seconds | u32 pixel_bytes | RGBA…`
//! Pixels are bottom-up rows (GL order) — the page shader flips Y.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// One rendered video frame.
pub struct FramePacket {
    pub width: u32,
    pub height: u32,
    pub pts: f64,
    /// RGBA8, bottom-up rows, `width * height * 4` bytes.
    pub pixels: Vec<u8>,
}

struct HubState {
    latest: Option<(u64, FramePacket)>,
    seq: u64,
}

/// Latest-wins frame slot: slow clients always get the newest frame.
pub struct FrameHub {
    state: Mutex<HubState>,
    cv: Condvar,
}

impl FrameHub {
    pub fn new() -> Arc<FrameHub> {
        Arc::new(FrameHub {
            state: Mutex::new(HubState {
                latest: None,
                seq: 0,
            }),
            cv: Condvar::new(),
        })
    }

    pub fn publish(&self, packet: FramePacket) {
        if let Ok(mut state) = self.state.lock() {
            state.seq += 1;
            state.latest = Some((state.seq, packet));
            self.cv.notify_all();
        }
    }

    /// Block until a frame newer than `after_seq` exists (or timeout), then
    /// clone it. Non-destructive — every subscriber sees every frame.
    pub fn wait_next(&self, after_seq: u64, timeout: Duration) -> Option<(u64, FramePacket)> {
        let mut state = match self.state.lock() {
            Ok(s) => s,
            Err(_) => return None,
        };
        loop {
            if let Some((seq, _)) = &state.latest {
                if *seq > after_seq {
                    return Some(clone_packet(&state));
                }
            }
            let (guard, result) = self
                .cv
                .wait_timeout(state, timeout)
                .unwrap_or_else(|e| e.into_inner());
            state = guard;
            if result.timed_out() {
                return match &state.latest {
                    Some((seq, _)) if *seq > after_seq => Some(clone_packet(&state)),
                    _ => None,
                };
            }
        }
    }

    /// Non-destructive read of the newest frame.
    pub fn peek(&self) -> Option<(u64, FramePacket)> {
        let state = self.state.lock().ok()?;
        if state.latest.is_none() {
            return None;
        }
        Some(clone_packet(&state))
    }
}

fn clone_packet(state: &HubState) -> (u64, FramePacket) {
    let (seq, packet) = state.latest.as_ref().expect("caller checked");
    (
        *seq,
        FramePacket {
            width: packet.width,
            height: packet.height,
            pts: packet.pts,
            pixels: packet.pixels.clone(),
        },
    )
}

/* ------------------------------------------------------------- the server */

struct ServerHandle {
    port: u16,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

fn server_slot() -> &'static Mutex<Option<ServerHandle>> {
    static SLOT: Mutex<Option<ServerHandle>> = Mutex::new(None);
    &SLOT
}

/// Process-wide frame hub (one player session at a time).
pub fn hub() -> Arc<FrameHub> {
    static HUB: std::sync::OnceLock<Arc<FrameHub>> = std::sync::OnceLock::new();
    HUB.get_or_init(FrameHub::new).clone()
}

/// Start (or reuse) the frame stream server. Returns `http://127.0.0.1:<port>/frames`.
pub fn ensure_started() -> Result<String, String> {
    if let Ok(guard) = server_slot().lock() {
        if let Some(server) = guard.as_ref() {
            if !server.stop.load(Ordering::SeqCst) {
                return Ok(format!("http://127.0.0.1:{}/frames", server.port));
            }
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("frames bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("frames addr: {e}"))?
        .port();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread_hub = hub();
    let join = std::thread::spawn(move || accept_loop(listener, thread_hub, thread_stop));

    if let Ok(mut guard) = server_slot().lock() {
        if let Some(mut old) = guard.take() {
            old.stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(("127.0.0.1", old.port));
            if let Some(handle) = old.join.take() {
                let _ = handle.join();
            }
        }
        *guard = Some(ServerHandle {
            port,
            stop,
            join: Some(join),
        });
    }
    Ok(format!("http://127.0.0.1:{port}/frames"))
}

/// Stop the frame stream server (player teardown).
pub fn stop() {
    if let Ok(mut guard) = server_slot().lock() {
        if let Some(mut server) = guard.take() {
            server.stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(("127.0.0.1", server.port));
            if let Some(handle) = server.join.take() {
                let _ = handle.join();
            }
        }
    }
}

fn accept_loop(listener: TcpListener, hub: Arc<FrameHub>, stop: Arc<AtomicBool>) {
    for stream in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(stream) = stream else { continue };
        let hub = hub.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            let _ = handle_connection(stream, hub, stop);
        });
    }
}

fn handle_connection(
    mut stream: TcpStream,
    hub: Arc<FrameHub>,
    stop: Arc<AtomicBool>,
) -> std::io::Result<()> {
    // Read the request head (we only care about the path).
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 512];
    let mut total = 0usize;
    loop {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        head.extend_from_slice(&chunk[..n]);
        total += n;
        if head.windows(4).any(|w| w == b"\r\n\r\n") || total > 8192 {
            break;
        }
    }
    let head_text = String::from_utf8_lossy(&head);
    let path_ok = head_text
        .lines()
        .next()
        .map(|line| line.contains(" /frames"))
        .unwrap_or(false);
    if !path_ok {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return Ok(());
    }

    stream.write_all(
        b"HTTP/1.1 200 OK\r\n\
          Content-Type: application/octet-stream\r\n\
          Cache-Control: no-store\r\n\
          Connection: close\r\n\
          Access-Control-Allow-Origin: *\r\n\
          \r\n",
    )?;
    stream.flush()?;
    println!("[player] frame client connected");

    let mut sent_seq = 0u64;
    // Seed with the current frame so the canvas paints immediately.
    if let Some((seq, packet)) = hub.peek() {
        write_frame(&mut stream, &packet)?;
        sent_seq = seq;
    }

    while !stop.load(Ordering::SeqCst) {
        match hub.wait_next(sent_seq, Duration::from_millis(250)) {
            Some((seq, packet)) => {
                write_frame(&mut stream, &packet)?;
                sent_seq = seq;
            }
            None => {
                // Client may have gone away while idle; probe with a zero write.
                if stream.write(&[]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
    Ok(())
}

fn write_frame(stream: &mut TcpStream, packet: &FramePacket) -> std::io::Result<()> {
    let mut header = [0u8; 24];
    header[0..4].copy_from_slice(&packet.width.to_le_bytes());
    header[4..8].copy_from_slice(&packet.height.to_le_bytes());
    header[8..16].copy_from_slice(&packet.pts.to_le_bytes());
    header[16..20].copy_from_slice(&(packet.pixels.len() as u32).to_le_bytes());
    // [20..24] reserved
    stream.write_all(&header)?;
    stream.write_all(&packet.pixels)?;
    stream.flush()
}

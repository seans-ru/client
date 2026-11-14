//! Tauri commands for auth (M2): JWT storage in the OS credential store,
//! system-browser opening for web OAuth, and a one-shot loopback HTTP acceptor
//! used as a fallback redirect target when `seans://` is unavailable.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Keyring service/account — kept in sync with src/api/session.ts.
const KEYRING_SERVICE: &str = "seans";
const KEYRING_ACCOUNT: &str = "session";

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())
}

/// Store the JWT in the platform credential store. Never persisted from JS.
#[tauri::command]
pub fn save_token(token: String) -> Result<(), String> {
    if token.is_empty() {
        return Err("token must not be empty".to_string());
    }
    let entry = keyring_entry()?;
    entry.set_password(&token).map_err(|e| e.to_string())
}

/// Read the JWT from the platform credential store, or None when absent.
#[tauri::command]
pub fn load_token() -> Result<Option<String>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete the JWT from the platform credential store (missing entry is not an error).
#[tauri::command]
pub fn clear_token() -> Result<(), String> {
    let entry = keyring_entry()?;
    match entry.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Open a URL in the system browser (web OAuth login page).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}

struct LoopbackServer {
    stop: Arc<AtomicBool>,
    port: u16,
    handle: Option<std::thread::JoinHandle<()>>,
}

static LOOPBACK: Mutex<Option<LoopbackServer>> = Mutex::new(None);

fn stop_loopback_inner(slot: &mut Option<LoopbackServer>) {
    if let Some(server) = slot.take() {
        server.stop.store(true, Ordering::SeqCst);
        // Unblock a pending accept() with a dummy connection.
        let _ = TcpStream::connect(("127.0.0.1", server.port));
        if let Some(handle) = server.handle {
            let _ = handle.join();
        }
    }
}

/// Stop the one-shot loopback auth acceptor, if running.
#[tauri::command]
pub fn stop_loopback_auth() {
    if let Ok(mut guard) = LOOPBACK.lock() {
        stop_loopback_inner(&mut guard);
    }
}

/// Query string of the first request line: `GET /callback?a=1 HTTP/1.1` → `a=1`.
fn extract_query(request: &str) -> Option<String> {
    let line = request.lines().next()?;
    let target = line.split_whitespace().nth(1)?;
    let (_, query) = target.split_once('?')?;
    Some(query.to_string())
}

/// Start a one-shot HTTP acceptor on 127.0.0.1:<ephemeral>/callback.
///
/// Returns the bound port. The frontend builds
/// `http://127.0.0.1:{port}/callback` as the OAuth redirect_uri.
/// On the first request the query (access_token, state, …) is relayed to the
/// frontend as a `seans://auth/callback?<query>` deep-link URL.
#[tauri::command]
pub fn start_loopback_auth(app: AppHandle) -> Result<u16, String> {
    let mut guard = LOOPBACK.lock().map_err(|e| e.to_string())?;
    stop_loopback_inner(&mut guard);

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();

    let handle = std::thread::spawn(move || {
        for stream in listener.incoming() {
            if thread_stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(mut stream) = stream else {
                continue;
            };

            let mut buf = [0u8; 8192];
            let read = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..read]);
            let query = extract_query(&request);

            let body = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Seans</title></head><body><p>Вход выполнен. Можно закрыть эту вкладку.</p></body></html>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();

            if let Some(query) = query {
                if !query.is_empty() {
                    // Reuse the existing deep-link pipeline in JS.
                    let url = format!("seans://auth/callback?{}", query);
                    let _ = app.emit("deep-link://new-url", vec![url]);
                }
            }
            break; // one-shot
        }
        thread_stop.store(true, Ordering::SeqCst);
    });

    *guard = Some(LoopbackServer {
        stop,
        port,
        handle: Some(handle),
    });
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::extract_query;

    #[test]
    fn extracts_query_from_request_line() {
        assert_eq!(
            extract_query("GET /callback?access_token=t&state=s HTTP/1.1\r\nHost: x"),
            Some("access_token=t&state=s".to_string())
        );
    }

    #[test]
    fn returns_none_without_query() {
        assert_eq!(extract_query("GET /callback HTTP/1.1"), None);
        assert_eq!(extract_query(""), None);
    }
}

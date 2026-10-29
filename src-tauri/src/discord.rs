//! Discord Rich Presence: Listening activity + joinable watch-party rooms.
//!
//! A worker thread owns the `discord_presence::Client` and receives commands
//! over an mpsc channel — Tauri commands never touch Discord IPC directly and
//! never block the UI. Everything is best-effort: Discord not running is a
//! normal state, errors are logged and playback continues.
//!
//! Join flow (friend clicks «Присоединиться» on the activity):
//!   * warm — Discord dispatches `ACTIVITY_JOIN` with the join secret over IPC;
//!   * cold — Discord launches the registered `discord-{APP_ID}://…` protocol
//!     (see `register_discord_launcher`), the secret arrives in argv.
//! Both paths stash the payload in `PENDING_JOIN` (the frontend may not be
//! mounted yet) and emit `DISCORD_JOIN_EVENT`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use discord_presence::models::{Activity, ActivityType, EventData};
use discord_presence::{Client, Event};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Discord Application ID (Developer Portal → Application ID).
pub const DISCORD_APP_ID: u64 = 1565313293747494932;

/// Frontend event: a friend clicked Join — payload `JoinEventPayload`.
pub const DISCORD_JOIN_EVENT: &str = "discord://join";

#[derive(Debug, Clone, Serialize)]
pub struct JoinEventPayload {
    pub secret: String,
}

/// Activity fields pushed from the frontend (camelCase over the invoke bridge).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscordActivityInput {
    pub details: Option<String>,
    pub state: Option<String>,
    pub large_image: Option<String>,
    pub large_text: Option<String>,
    pub small_image: Option<String>,
    pub small_text: Option<String>,
    /// Unix ms; start = "already watched for X", end = start + duration.
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    /// Room code — each room is its own Discord party.
    pub party_id: Option<String>,
    pub party_size: Option<u32>,
    pub party_max: Option<u32>,
    pub join_secret: Option<String>,
}

enum DiscordCmd {
    SetActivity(Box<DiscordActivityInput>),
    Clear,
}

static TX: OnceLock<Sender<DiscordCmd>> = OnceLock::new();
static PENDING_JOIN: Mutex<Option<String>> = Mutex::new(None);

fn store_pending(secret: String) {
    if let Ok(mut guard) = PENDING_JOIN.lock() {
        *guard = Some(secret);
    }
}

/// Route a join payload: stash for the mount-time consumer and emit to JS.
pub(crate) fn dispatch_join(app: &AppHandle, secret: String) {
    store_pending(secret.clone());
    let _ = app.emit(DISCORD_JOIN_EVENT, JoinEventPayload { secret });
}

/// Discord cold-launches the app as `discord-{APP_ID}://<payload>` (URL protocol).
/// Returns the raw payload for the frontend's lenient `extractRoomCode`.
pub fn join_secret_candidate(arg: &str) -> Option<String> {
    let lower = arg.to_ascii_lowercase();
    if lower.starts_with("discord-") && arg.contains("://") {
        Some(arg.to_string())
    } else {
        None
    }
}

/// Map the frontend payload onto a Discord `Activity` (Listening type).
fn build_activity(base: Activity, input: DiscordActivityInput) -> Activity {
    let mut act = base.activity_type(ActivityType::Listening);
    if input.party_id.is_some() {
        act = act.instance(true);
    }
    if let Some(v) = input.details {
        act = act.details(v);
    }
    if let Some(v) = input.state {
        act = act.state(v);
    }
    if input.large_image.is_some() || input.small_image.is_some() {
        let (li, lt, si, st) = (
            input.large_image,
            input.large_text,
            input.small_image,
            input.small_text,
        );
        act = act.assets(|a| {
            let mut a = a;
            if let Some(v) = li {
                a = a.large_image(v);
            }
            if let Some(v) = lt {
                a = a.large_text(v);
            }
            if let Some(v) = si {
                a = a.small_image(v);
            }
            if let Some(v) = st {
                a = a.small_text(v);
            }
            a
        });
    }
    if input.start_ms.is_some() || input.end_ms.is_some() {
        let (s, e) = (input.start_ms, input.end_ms);
        act = act.timestamps(|t| {
            let mut t = t;
            if let Some(v) = s {
                t = t.start(v);
            }
            if let Some(v) = e {
                t = t.end(v);
            }
            t
        });
    }
    if let (Some(pid), Some(size), Some(max)) = (input.party_id, input.party_size, input.party_max) {
        act = act.party(|p| p.id(pid).size((size, max)));
    }
    if let Some(secret) = input.join_secret {
        act = act.secrets(|s| s.join(secret));
    }
    act
}

/// Recursive lookup of a JSON value by key. `EventData` serializes as an
/// externally tagged enum (`{"ActivityJoin": {"secret": …}}`), so the useful
/// fields nest under variant names — walk the tree instead of matching shapes.
fn find_key<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(v) = map.get(key) {
                return Some(v);
            }
            map.values().find_map(|v| find_key(v, key))
        }
        serde_json::Value::Array(items) => items.iter().find_map(|v| find_key(v, key)),
        _ => None,
    }
}

/// Extract `secret` from an `ACTIVITY_JOIN` dispatch without depending on the
/// crate's builder-generated field shapes.
fn extract_secret(event: &EventData) -> Option<String> {
    let value = serde_json::to_value(event).ok()?;
    find_key(&value, "secret")?.as_str().map(str::to_string)
}

/// Extract the requester's user id from an `ACTIVITY_JOIN_REQUEST` dispatch.
fn extract_user_id(event: &EventData) -> Option<u64> {
    let value = serde_json::to_value(event).ok()?;
    let user = find_key(&value, "user")?;
    let id = user.get("id").or_else(|| find_key(user, "id"))?;
    id.as_u64()
        .or_else(|| id.as_str().and_then(|s| s.parse().ok()))
}

fn run_client(app: AppHandle, rx: Receiver<DiscordCmd>) {
    let mut client = Client::new(DISCORD_APP_ID);
    // Handlers run on the connection thread; the join-request auto-approve
    // needs `&mut Client`, which the worker loop owns — bridge via a channel.
    let (invite_tx, invite_rx) = mpsc::channel::<u64>();

    // Dropping an EventCallbackHandle unregisters the listener — persist them.
    {
        let app = app.clone();
        client
            .on_activity_join(move |ctx| {
                if let Some(secret) = extract_secret(&ctx.event) {
                    dispatch_join(&app, secret);
                }
            })
            .persist();
    }
    {
        // "Ask to Join" on a full party → auto-approve; the requester then
        // receives our join secret and lands in the same room.
        let invites = invite_tx;
        client
            .on_activity_join_request(move |ctx| {
                if let Some(user_id) = extract_user_id(&ctx.event) {
                    let _ = invites.send(user_id);
                }
            })
            .persist();
    }
    let connected = Arc::new(AtomicBool::new(false));
    {
        let flag = connected.clone();
        client
            .on_connected(move |_| flag.store(true, Ordering::SeqCst))
            .persist();
    }
    {
        let flag = connected.clone();
        client
            .on_disconnected(move |_| flag.store(false, Ordering::SeqCst))
            .persist();
    }

    client.start();

    // Discord dispatches join events only to subscribers; subscriptions are
    // per-connection, so re-subscribe after every (re)connect.
    let mut subscribed = false;
    loop {
        let is_connected = connected.load(Ordering::SeqCst);
        if is_connected && !subscribed {
            subscribed = client.subscribe(Event::ActivityJoin, |a| a).is_ok()
                && client.subscribe(Event::ActivityJoinRequest, |a| a).is_ok();
        } else if subscribed && !is_connected {
            subscribed = false;
        }

        while let Ok(user_id) = invite_rx.try_recv() {
            if let Err(e) = client.send_activity_join_invite(user_id) {
                eprintln!("[discord] approve join request: {e}");
            }
        }

        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(DiscordCmd::SetActivity(input)) => {
                if let Err(e) = client.set_activity(|act| build_activity(act, *input)) {
                    eprintln!("[discord] set_activity: {e}");
                }
            }
            Ok(DiscordCmd::Clear) => {
                if let Err(e) = client.clear_activity() {
                    eprintln!("[discord] clear_activity: {e}");
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Register `discord-{APP_ID}://` so Discord can cold-launch Seans on Join.
/// Same mechanism as `Discord_Register` in discord-rpc: an HKCU URL protocol
/// whose command is the current exe. Idempotent — also refreshes the path
/// after an update/install move.
fn register_discord_launcher() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY_CURRENT_USER, KEY_WRITE, REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Create `HKCU\<subkey>` (if needed) and set a REG_SZ value under it.
    unsafe fn set_sz(subkey: &str, name: Option<&str>, data: &str) {
        let subkey_w = wide(subkey);
        let mut hkey = std::ptr::null_mut();
        let status = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey_w.as_ptr(),
            0,
            std::ptr::null_mut(),
            0,
            KEY_WRITE,
            std::ptr::null(),
            &mut hkey,
            std::ptr::null_mut(),
        );
        if status != 0 {
            eprintln!("[discord] registry create {subkey}: {status}");
            return;
        }
        let name_w = name.map(wide);
        let data_w = wide(data);
        let name_ptr = name_w
            .as_ref()
            .map(|w| w.as_ptr())
            .unwrap_or(std::ptr::null());
        RegSetValueExW(
            hkey,
            name_ptr,
            0,
            REG_SZ,
            data_w.as_ptr() as *const u8,
            (data_w.len() * 2) as u32,
        );
        RegCloseKey(hkey);
    }

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe = exe.to_string_lossy().to_string();
    let root = format!("Software\\Classes\\discord-{DISCORD_APP_ID}");

    unsafe {
        set_sz(&root, None, "URL:Run Seans (Discord join)");
        set_sz(&root, Some("URL Protocol"), "");
        set_sz(&format!("{root}\\DefaultIcon"), None, &exe);
        // "%1" carries the discord-{APP_ID}://… payload into argv.
        set_sz(
            &format!("{root}\\shell\\open\\command"),
            None,
            &format!("\"{exe}\" \"%1\""),
        );
    }
}

/// Boot the Discord worker thread, register the launch protocol, and consume
/// any join payload Discord passed at process start.
pub fn init(app: &AppHandle) {
    register_discord_launcher();

    // Cold-start join: Windows runs the registered command with the protocol
    // URL in argv. Forward it through the same pipeline as the IPC event.
    for arg in std::env::args().skip(1) {
        if let Some(secret) = join_secret_candidate(&arg) {
            dispatch_join(app, secret);
        }
    }

    let (tx, rx) = mpsc::channel::<DiscordCmd>();
    let _ = TX.set(tx);
    let app = app.clone();
    std::thread::spawn(move || run_client(app, rx));
}

/// Tauri command: update the rich presence payload.
#[tauri::command]
pub fn discord_set_activity(input: DiscordActivityInput) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(DiscordCmd::SetActivity(Box::new(input)));
    }
}

/// Tauri command: clear the rich presence payload.
#[tauri::command]
pub fn discord_clear_activity() {
    if let Some(tx) = TX.get() {
        let _ = tx.send(DiscordCmd::Clear);
    }
}

/// Tauri command: take the join secret stashed before the frontend mounted.
#[tauri::command]
pub fn discord_take_pending_join() -> Option<String> {
    PENDING_JOIN.lock().ok().and_then(|mut g| g.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discord_protocol_args_are_join_candidates() {
        assert_eq!(
            join_secret_candidate("discord-1565313293747494932://abc"),
            Some("discord-1565313293747494932://abc".to_string())
        );
        assert_eq!(join_secret_candidate("seans://room/ABCD2345"), None);
        assert_eq!(join_secret_candidate("--flag"), None);
    }

    #[test]
    fn extract_secret_reads_activity_join_payload() {
        let event = EventData::ActivityJoin(
            serde_json::from_str(r#"{"secret":"128734:ABCD2345:nonce"}"#).unwrap(),
        );
        assert_eq!(
            extract_secret(&event),
            Some("128734:ABCD2345:nonce".to_string())
        );
    }

    #[test]
    fn extract_user_id_reads_join_request_payload() {
        let event = EventData::ActivityJoinRequest(
            serde_json::from_str(
                r#"{"user":{"id":"128734","username":"x","discriminator":"0","avatar":""}}"#,
            )
            .unwrap(),
        );
        assert_eq!(extract_user_id(&event), Some(128734));
    }
}

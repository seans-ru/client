mod commands;
mod player;
mod progressive;

use tauri::{Emitter, Manager};

/// Focus and raise the main window (single-instance / deep-link wake-up).
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Collect `seans://` URLs from a process argv (second launch / protocol activation).
fn urls_from_argv(argv: &[String]) -> Vec<String> {
    argv
        .iter()
        .filter(|arg| arg.to_lowercase().starts_with("seans://"))
        .cloned()
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Second process forwards its args to the first and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let urls = urls_from_argv(&argv);
            if !urls.is_empty() {
                // Same event name the deep-link plugin uses; JS `onOpenUrl` consumes it.
                let _ = app.emit("deep-link://new-url", urls);
            }
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        // M11: updater + process relaunch (JS drives check/download; relaunch on demand).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            // Keep the mpv `wid` child window sized to the main window client area.
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(|event| {
                    if let tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } = event {
                        player::session::sync_host_size();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::save_token,
            commands::load_token,
            commands::clear_token,
            commands::open_url,
            commands::start_loopback_auth,
            commands::stop_loopback_auth,
            player::player_open,
            player::player_play,
            player::player_pause,
            player::player_toggle_pause,
            player::player_seek,
            player::player_set_speed,
            player::player_set_volume,
            player::player_set_mute,
            player::player_set_audio_track,
            player::player_set_subtitle_track,
            player::player_list_tracks,
            player::player_set_fullscreen,
            player::player_toggle_fullscreen,
            player::player_get_state,
            player::player_destroy,
            player::player_sync_size,
            player::player_set_max_seekable,
            progressive::commands::progressive_start,
            progressive::commands::progressive_update,
            progressive::commands::progressive_stop,
            progressive::commands::progressive_max_seekable,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Seans")
        // Windows deep-link URLs arrive via `deep-link://new-url` (plugin + single-instance).
        // `RunEvent::Opened` is macOS/iOS/Android only and is handled inside the plugin.
        .run(|_, _| {});
}

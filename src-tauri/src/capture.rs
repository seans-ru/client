//! Capture support (issue #14): default capture directory, clip export via an
//! optional ffmpeg binary, and reveal-in-folder. Thin commands only — the
//! player core (`session.rs` / FFI / `player_*`) is not touched; screenshots
//! themselves are written by mpv (`screenshot-to-file`) through the existing
//! bridge.
//!
//! ffmpeg is OPTIONAL and never bundled by default. Lookup order:
//!   1. `<resource_dir>/ffmpeg/ffmpeg.exe` (or `ffmpeg` on non-Windows),
//!   2. `<resource_dir>/ffmpeg.exe`,
//!   3. next to the app executable,
//!   4. `PATH`.
//! Without it `capture_export_clip` fails with code `ffmpeg-missing` and the
//! UI offers the honest fallback (save the start/end frames via mpv).

use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::{AppHandle, Emitter, Manager};

/// Structured error so the frontend can branch (e.g. `ffmpeg-missing`
/// triggers the frames fallback instead of a dead-end toast).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureError {
    pub code: String,
    pub message: String,
}

impl CaptureError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        CaptureError {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// `Pictures/Seans`, created on demand (issue: «дефолтная папка
/// «Изображения/Seans»»).
#[tauri::command]
pub fn capture_default_dir(app: AppHandle) -> Result<String, CaptureError> {
    let pictures = app
        .path()
        .picture_dir()
        .map_err(|e| CaptureError::new("no-pictures-dir", e.to_string()))?;
    let dir = pictures.join("Seans");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CaptureError::new("create-dir-failed", e.to_string()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Reveal `path` in the system file manager («Показать в папке»).
#[tauri::command]
pub fn capture_reveal(path: String) -> Result<(), CaptureError> {
    reveal_path(Path::new(&path))
}

#[cfg(windows)]
fn reveal_path(path: &Path) -> Result<(), CaptureError> {
    if path.as_os_str().is_empty() {
        return Err(CaptureError::new("invalid-path", "путь пуст"));
    }
    if path.is_file() {
        // Explorer selects the file with `/select,<path>` (one argument).
        let mut arg = OsString::from("/select,");
        arg.push(path.as_os_str());
        Command::new("explorer")
            .arg(arg)
            .spawn()
            .map_err(|e| CaptureError::new("reveal-failed", e.to_string()))?;
        Ok(())
    } else {
        open::that(path).map_err(|e| CaptureError::new("reveal-failed", e.to_string()))
    }
}

#[cfg(not(windows))]
fn reveal_path(path: &Path) -> Result<(), CaptureError> {
    if path.as_os_str().is_empty() {
        return Err(CaptureError::new("invalid-path", "путь пуст"));
    }
    let target = if path.is_file() {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    open::that(target).map_err(|e| CaptureError::new("reveal-failed", e.to_string()))
}

/// Progress ping while ffmpeg runs (`-progress pipe:1`).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgressEvent {
    out_time_ms: u64,
}

const EXPORT_PROGRESS_EVENT: &str = "capture://export-progress";

/// Cut `[start, end]` of `source` into `out_path` with stream copy
/// (`-c copy`, no re-encode) — video + first audio track, so a clip keeps its
/// sound. Container follows the output extension (mp4 gets `+faststart`).
///
/// `-ss` is an input seek (nearest keyframe ≤ start) and `-t` is the output
/// duration — the unambiguous pair for a stream-copy cut (`-to` before `-i`
/// means different things across ffmpeg versions).
pub fn export_args(start: f64, end: f64, source: &str, out_path: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-ss".into(),
        format_seconds(start),
        "-i".into(),
        source.to_string(),
        "-t".into(),
        format_seconds(end - start),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0?".into(),
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
    ];
    if is_mp4_path(out_path) {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }
    args.push(out_path.to_string());
    args
}

fn is_mp4_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".mp4") || lower.ends_with(".m4v")
}

/// Trimmed timestamp for ffmpeg (`12.5`, not `12.500000000000002`).
fn format_seconds(value: f64) -> String {
    let clamped = if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    };
    let s = format!("{clamped:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Parse one `-progress` line (`out_time=HH:MM:SS.uuuuuu`) into milliseconds.
pub fn parse_out_time_ms(line: &str) -> Option<u64> {
    let rest = line.trim().strip_prefix("out_time=")?;
    let mut parts = rest.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let total_ms = (hours * 3600.0 + minutes * 60.0 + seconds) * 1000.0;
    if !total_ms.is_finite() || total_ms < 0.0 {
        return None;
    }
    Some(total_ms.round() as u64)
}

/// Explicit ffmpeg locations, then bare `ffmpeg` for the PATH lookup by spawn.
pub fn resolve_ffmpeg(app: &AppHandle) -> PathBuf {
    #[cfg(windows)]
    const NAMES: &[&str] = &["ffmpeg.exe", "ffmpeg"];
    #[cfg(not(windows))]
    const NAMES: &[&str] = &["ffmpeg"];

    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        dirs.push(resource.join("ffmpeg"));
        dirs.push(resource);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    for dir in dirs {
        for name in NAMES {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("ffmpeg")
}

/// Export the `[start, end]` clip of `source` into `out_path` (issue #14).
/// Streams `-progress` pings as `capture://export-progress` events.
#[tauri::command]
pub async fn capture_export_clip(
    app: AppHandle,
    source: String,
    start: f64,
    end: f64,
    out_path: String,
) -> Result<(), CaptureError> {
    if source.trim().is_empty() {
        return Err(CaptureError::new("invalid-source", "нет источника видео"));
    }
    if out_path.trim().is_empty() {
        return Err(CaptureError::new("invalid-path", "нет пути сохранения"));
    }
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start {
        return Err(CaptureError::new("invalid-range", "некорректный отрезок A→B"));
    }

    tauri::async_runtime::spawn_blocking(move || run_export(app, source, start, end, out_path))
        .await
        .map_err(|e| CaptureError::new("join-failed", e.to_string()))?
}

fn run_export(
    app: AppHandle,
    source: String,
    start: f64,
    end: f64,
    out_path: String,
) -> Result<(), CaptureError> {
    let ffmpeg = resolve_ffmpeg(&app);
    let args = export_args(start, end, &source, &out_path);

    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CaptureError::new(
                    "ffmpeg-missing",
                    "ffmpeg не найден — положите ffmpeg.exe в папку ресурсов или в PATH",
                )
            } else {
                CaptureError::new("spawn-failed", e.to_string())
            }
        })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CaptureError::new("spawn-failed", "нет канала stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CaptureError::new("spawn-failed", "нет канала stderr"))?;

    let progress_app = app.clone();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(ms) = parse_out_time_ms(&line) {
                let _ = progress_app.emit(
                    EXPORT_PROGRESS_EVENT,
                    ExportProgressEvent {
                        out_time_ms: ms,
                    },
                );
            }
        }
    });

    let err_lines = std::thread::spawn(move || {
        let mut tail: Vec<String> = Vec::new();
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            tail.push(line);
            if tail.len() > 12 {
                tail.remove(0);
            }
        }
        tail
    });

    let status = child.wait().map_err(|e| CaptureError::new("io", e.to_string()))?;
    let _ = reader.join();
    let tail = err_lines.join().unwrap_or_default();

    if !status.success() {
        let detail = if tail.is_empty() {
            format!("ffmpeg завершился с кодом {}", status)
        } else {
            tail.join("\n")
        };
        return Err(CaptureError::new("ffmpeg-failed", detail));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{export_args, format_seconds, parse_out_time_ms};

    #[test]
    fn export_args_stream_copy_with_faststart_for_mp4() {
        let args = export_args(10.0, 25.5, "https://cdn/x.mkv", "C:/out/clip.mp4");
        assert_eq!(args[0], "-hide_banner");
        assert!(args.windows(2).any(|w| w == ["-ss", "10"]));
        // Output duration, not an absolute end timestamp.
        assert!(args.windows(2).any(|w| w == ["-t", "15.5"]));
        assert!(args.windows(2).any(|w| w == ["-c", "copy"]));
        assert!(args.windows(2).any(|w| w == ["-movflags", "+faststart"]));
        assert_eq!(args.last().map(String::as_str), Some("C:/out/clip.mp4"));
    }

    #[test]
    fn export_args_mkv_skips_faststart() {
        let args = export_args(0.0, 1.0, "src", "clip.mkv");
        assert!(!args.contains(&"faststart".to_string()) && !args.contains(&"+faststart".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("clip.mkv"));
    }

    #[test]
    fn format_seconds_trims_noise() {
        assert_eq!(format_seconds(10.0), "10");
        assert_eq!(format_seconds(12.5), "12.5");
        assert_eq!(format_seconds(-3.0), "0");
        assert_eq!(format_seconds(f64::NAN), "0");
    }

    #[test]
    fn parses_progress_out_time() {
        assert_eq!(parse_out_time_ms("out_time=00:00:12.500000"), Some(12500));
        assert_eq!(parse_out_time_ms("out_time=01:02:03.250000"), Some(3723250));
        assert_eq!(parse_out_time_ms("out_time_ms=12500"), None);
        assert_eq!(parse_out_time_ms("frame=42"), None);
        assert_eq!(parse_out_time_ms("out_time=00:00:01"), Some(1000));
    }
}

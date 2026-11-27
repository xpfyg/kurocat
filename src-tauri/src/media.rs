//! Lightweight "is the user listening to music?" watcher.
//!
//! Rather than capturing system audio (permissions, privacy, false positives from
//! meetings/videos), we only look for well-known music player processes. This keeps
//! the feature permission-free and dependency-free on all three platforms.
//!
//! The watcher polls every few seconds and emits `mini-media` with the current
//! state, so the frontend simply toggles the cat's relaxed mood.

use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const POLL_INTERVAL: Duration = Duration::from_secs(8);

/// Lower-case path / executable fragments of popular music players.
/// Matched against the full macOS executable path, Windows image names,
/// or the Linux `/proc/<pid>/comm` value.
#[cfg(target_os = "macos")]
const MUSIC_APP_HINTS: &[&str] = &[
    "/music.app/",
    "/spotify.app/",
    "/qqmusic.app/",
    "/neteasemusic.app/",
    "/kugou.app/",
    "/kugoumusic.app/",
    "/kuwo.app/",
    "/kuwomusic.app/",
    "/qishui.app/",
    "/qishuimusic.app/",
    "/yesplaymusic.app/",
    "/foobar2000.app/",
    "/vox.app/",
    "/strawberry.app/",
    "/swinsian.app/",
    "/netease music.app/",
];

#[cfg(windows)]
const MUSIC_APP_HINTS: &[&str] = &[
    "spotify.exe",
    "qqmusic.exe",
    "cloudmusic.exe",
    "neteasecloudmusic.exe",
    "netease music.exe",
    "kugou.exe",
    "kwmusic.exe",
    "kwplayer.exe",
    "qishui.exe",
    "qishuimusic.exe",
    "douyinmusic",
    "music.ui.exe",
    "itunes.exe",
    "foobar2000.exe",
    "aimp.exe",
    "yesplaymusic.exe",
    "listen1.exe",
];

#[cfg(target_os = "linux")]
const MUSIC_APP_HINTS: &[&str] = &[
    "spotify",
    "qqmusic",
    "cloudmusic",
    "netease-cloud-mus",
    "kugou",
    "kwmusic",
    "qishui",
    "rhythmbox",
    "clementine",
    "strawberry",
    "deadbeef",
    "audacious",
    "elisa",
    "mpd",
    "cmus",
    "museeks",
];

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
const MUSIC_APP_HINTS: &[&str] = &[];

fn line_is_music_app(line: &str) -> bool {
    let lower = line.to_lowercase();
    MUSIC_APP_HINTS
        .iter()
        .any(|hint| lower.contains(hint) && !hint.is_empty())
}

fn env_force_music() -> Option<bool> {
    std::env::var("MINICAT_MUSIC").ok().and_then(|value| {
        let v = value.trim();
        if v == "1" || v.eq_ignore_ascii_case("true") {
            Some(true)
        } else if v == "0" || v.eq_ignore_ascii_case("false") {
            Some(false)
        } else {
            None
        }
    })
}

#[cfg(target_os = "macos")]
fn music_app_running() -> bool {
    use std::ffi::{c_int, c_void};

    // PROC_PIDPATHINFO_MAXSIZE = 4 * MAXPATHLEN (4096) on macOS.
    const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;

    extern "C" {
        fn proc_listallpids(buffer: *mut c_void, buffersize: c_int) -> c_int;
        fn proc_pidpath(pid: c_int, buffer: *mut c_void, buffersize: u32) -> c_int;
    }

    // Native libproc lookup: zero fork/exec overhead compared to spawning `/bin/ps`.
    unsafe {
        let count_hint = proc_listallpids(std::ptr::null_mut(), 0);
        if count_hint <= 0 {
            return false;
        }
        let capacity = (count_hint as usize).saturating_add(64);
        let mut pids = vec![0i32; capacity];
        let buf_bytes = (pids.len() * std::mem::size_of::<i32>()) as c_int;
        let num_pids = proc_listallpids(pids.as_mut_ptr() as *mut c_void, buf_bytes);
        if num_pids <= 0 {
            return false;
        }
        let limit = (num_pids as usize).min(pids.len());
        let mut path_buf = [0u8; PROC_PIDPATHINFO_MAXSIZE];
        for &pid in &pids[..limit] {
            if pid <= 0 {
                continue;
            }
            let len = proc_pidpath(
                pid,
                path_buf.as_mut_ptr() as *mut c_void,
                PROC_PIDPATHINFO_MAXSIZE as u32,
            );
            if len > 0 {
                let slice = &path_buf[..len as usize];
                if let Ok(path) = std::str::from_utf8(slice) {
                    if line_is_music_app(path) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[cfg(windows)]
fn music_app_running() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    // Native Win32 Toolhelp32 process enumeration: zero child processes spawned,
    // completely eliminating the flashing CMD window and `tasklist.exe` CPU overhead.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return false;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        let mut found = false;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let exe_name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if line_is_music_app(&exe_name) {
                    found = true;
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
        found
    }
}

#[cfg(target_os = "linux")]
fn music_app_running() -> bool {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let pid = name.to_string_lossy();
        if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        std::fs::read_to_string(entry.path().join("comm"))
            .map(|comm| line_is_music_app(&comm))
            .unwrap_or(false)
    })
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn music_app_running() -> bool {
    false
}

/// Public probe kept simple so it can be unit-tested / reused elsewhere.
pub fn is_music_playing() -> bool {
    if let Some(forced) = env_force_music() {
        return forced;
    }
    music_app_running()
}

pub fn start_media_watcher(app: AppHandle) {
    thread::spawn(move || {
        // Wait briefly so the webview listener is attached before initial emit,
        // then only emit when state changes (plus one redundant sync after startup).
        thread::sleep(Duration::from_secs(2));
        let mut last_state: Option<bool> = None;
        let mut initial_syncs_left: u8 = 2;
        loop {
            let playing = is_music_playing();
            if last_state != Some(playing) || initial_syncs_left > 0 {
                last_state = Some(playing);
                initial_syncs_left = initial_syncs_left.saturating_sub(1);
                let _ = app.emit("mini-media", playing);
            }
            thread::sleep(POLL_INTERVAL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_music_players_configured_for_this_platform() {
        #[cfg(target_os = "macos")]
        {
            assert!(line_is_music_app(
                "/Applications/Spotify.app/Contents/MacOS/Spotify"
            ));
            assert!(line_is_music_app(
                "/System/Applications/Music.app/Contents/MacOS/Music"
            ));
            assert!(line_is_music_app(
                "/Applications/QQMusic.app/Contents/MacOS/QQMusic"
            ));
            assert!(line_is_music_app(
                "/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic"
            ));
        }
        #[cfg(windows)]
        {
            assert!(line_is_music_app(
                "\"Spotify.exe\",\"1234\",\"Console\",\"1\",\"120,000 K\""
            ));
            assert!(line_is_music_app(
                "\"cloudmusic.exe\",\"1234\",\"Console\",\"1\",\"120,000 K\""
            ));
        }
        #[cfg(target_os = "linux")]
        {
            assert!(line_is_music_app("spotify\n"));
            assert!(line_is_music_app("kugou\n"));
        }
    }

    #[test]
    fn ignores_unrelated_processes() {
        assert!(!line_is_music_app("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"));
        assert!(!line_is_music_app("WeChatAppEx"));
        assert!(!line_is_music_app("\"chrome.exe\",\"1\",\"Console\",\"1\",\"1 K\""));
        assert!(!line_is_music_app(""));
    }

    #[test]
    fn native_process_scan_runs_cleanly() {
        let _ = is_music_playing();
    }
}

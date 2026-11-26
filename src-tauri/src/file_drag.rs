//! Global "user is dragging files" detector + move-to-recycle-bin helper.
//!
//! When the user starts dragging files anywhere on the desktop, the cat pulls a
//! little trash can out from behind its back. Files dropped onto the can are
//! moved to the OS recycle bin / Trash (never permanently deleted).
//!
//! Detection strategy per platform:
//! - macOS: the shared drag pasteboard (`NSPasteboardNameDrag`) bumps its
//!   `changeCount` whenever a new drag session starts. While the left button is
//!   held we compare against the idle baseline and count `public.file-url` items.
//! - Windows: Explorer / shell drags show the shell drag-image helper window
//!   (`SysDragImage`) while the left button is held.
//! - Other platforms: rely on the webview's own drag-enter event (frontend).

use crate::config::AppSettings;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDragInfo {
    pub active: bool,
    /// Number of dragged files (0 = unknown on this platform).
    pub count: u32,
    /// Which side the cat should hand the trash can to: "left" | "right".
    pub side: String,
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void, CString};
    use std::mem::transmute;
    use std::ptr::null_mut;

    #[link(name = "objc")]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    type Id = *mut c_void;

    unsafe fn sel(name: &[u8]) -> Id {
        sel_registerName(name.as_ptr() as *const c_char)
    }

    unsafe fn cls(name: &[u8]) -> Id {
        objc_getClass(name.as_ptr() as *const c_char)
    }

    unsafe fn ns_string(s: &str) -> Id {
        let c = CString::new(s).unwrap_or_default();
        let f: extern "C" fn(Id, Id, *const c_char) -> Id = transmute(objc_msgSend as *const ());
        f(cls(b"NSString\0"), sel(b"stringWithUTF8String:\0"), c.as_ptr())
    }

    pub struct Probe {
        pub left_down: bool,
        pub change_count: isize,
    }

    pub fn probe() -> Probe {
        unsafe {
            let pool = objc_autoreleasePoolPush();
            let msg_usize: extern "C" fn(Id, Id) -> usize = transmute(objc_msgSend as *const ());
            let msg_isize: extern "C" fn(Id, Id) -> isize = transmute(objc_msgSend as *const ());
            let msg_obj_obj: extern "C" fn(Id, Id, Id) -> Id = transmute(objc_msgSend as *const ());

            let buttons = msg_usize(cls(b"NSEvent\0"), sel(b"pressedMouseButtons\0"));
            let pb = msg_obj_obj(
                cls(b"NSPasteboard\0"),
                sel(b"pasteboardWithName:\0"),
                ns_string("Apple CFPasteboard drag"),
            );
            let change_count = if pb.is_null() {
                0
            } else {
                msg_isize(pb, sel(b"changeCount\0"))
            };
            objc_autoreleasePoolPop(pool);
            Probe {
                left_down: buttons & 1 != 0,
                change_count,
            }
        }
    }

    /// Counts dragged items that carry a file URL on the shared drag pasteboard.
    pub fn dragged_file_count() -> usize {
        unsafe {
            let pool = objc_autoreleasePoolPush();
            let msg_obj: extern "C" fn(Id, Id) -> Id = transmute(objc_msgSend as *const ());
            let msg_usize: extern "C" fn(Id, Id) -> usize = transmute(objc_msgSend as *const ());
            let msg_obj_obj: extern "C" fn(Id, Id, Id) -> Id = transmute(objc_msgSend as *const ());
            let msg_obj_usize: extern "C" fn(Id, Id, usize) -> Id =
                transmute(objc_msgSend as *const ());
            let msg_bool_obj: extern "C" fn(Id, Id, Id) -> i8 = transmute(objc_msgSend as *const ());

            let mut count = 0usize;
            let pb = msg_obj_obj(
                cls(b"NSPasteboard\0"),
                sel(b"pasteboardWithName:\0"),
                ns_string("Apple CFPasteboard drag"),
            );
            if !pb.is_null() {
                let items = msg_obj(pb, sel(b"pasteboardItems\0"));
                if !items.is_null() {
                    let n = msg_usize(items, sel(b"count\0")).min(4096);
                    let file_url = ns_string("public.file-url");
                    for i in 0..n {
                        let item = msg_obj_usize(items, sel(b"objectAtIndex:\0"), i);
                        if item.is_null() {
                            continue;
                        }
                        let types = msg_obj(item, sel(b"types\0"));
                        if !types.is_null()
                            && msg_bool_obj(types, sel(b"containsObject:\0"), file_url) != 0
                        {
                            count += 1;
                        }
                    }
                }
            }
            objc_autoreleasePoolPop(pool);
            count
        }
    }

    /// Moves a file to the user's Trash via NSFileManager (no AppleScript / Finder permission prompt).
    pub fn trash_path(path: &str) -> bool {
        unsafe {
            let pool = objc_autoreleasePoolPush();
            let msg_obj: extern "C" fn(Id, Id) -> Id = transmute(objc_msgSend as *const ());
            let msg_obj_obj: extern "C" fn(Id, Id, Id) -> Id = transmute(objc_msgSend as *const ());
            let trash_fn: extern "C" fn(Id, Id, Id, Id, Id) -> i8 =
                transmute(objc_msgSend as *const ());

            let url = msg_obj_obj(cls(b"NSURL\0"), sel(b"fileURLWithPath:\0"), ns_string(path));
            let fm = msg_obj(cls(b"NSFileManager\0"), sel(b"defaultManager\0"));
            let ok = !url.is_null()
                && !fm.is_null()
                && trash_fn(
                    fm,
                    sel(b"trashItemAtURL:resultingItemURL:error:\0"),
                    url,
                    null_mut(),
                    null_mut(),
                ) != 0;
            objc_autoreleasePoolPop(pool);
            ok
        }
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, IsWindowVisible};

    pub fn left_down() -> bool {
        unsafe { (GetAsyncKeyState(0x01) as u16 & 0x8000) != 0 }
    }

    /// The shell drag-image helper window is visible while files are dragged from Explorer/Desktop.
    pub fn shell_drag_image_visible() -> bool {
        let class: Vec<u16> = "SysDragImage\0".encode_utf16().collect();
        unsafe {
            let h = FindWindowW(class.as_ptr(), std::ptr::null());
            !h.is_null() && IsWindowVisible(h) != 0
        }
    }

    #[cfg_attr(target_arch = "x86", repr(C, packed(1)))]
    #[cfg_attr(not(target_arch = "x86"), repr(C))]
    struct ShFileOpStructW {
        hwnd: *mut c_void,
        w_func: u32,
        p_from: *const u16,
        p_to: *const u16,
        f_flags: u16,
        f_any_operations_aborted: i32,
        h_name_mappings: *mut c_void,
        lpsz_progress_title: *const u16,
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHFileOperationW(op: *mut ShFileOpStructW) -> i32;
    }

    const FO_DELETE: u32 = 0x0003;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOERRORUI: u16 = 0x0400;

    /// Sends files to the Recycle Bin (FOF_ALLOWUNDO), never permanently deleting them.
    pub fn trash_paths(paths: &[String]) -> bool {
        if paths.is_empty() {
            return true;
        }
        let mut from: Vec<u16> = Vec::new();
        for p in paths {
            from.extend(p.encode_utf16());
            from.push(0);
        }
        from.push(0);
        let mut op = ShFileOpStructW {
            hwnd: std::ptr::null_mut(),
            w_func: FO_DELETE,
            p_from: from.as_ptr(),
            p_to: std::ptr::null(),
            f_flags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
            f_any_operations_aborted: 0,
            h_name_mappings: std::ptr::null_mut(),
            lpsz_progress_title: std::ptr::null(),
        };
        unsafe { SHFileOperationW(&mut op) == 0 && op.f_any_operations_aborted == 0 }
    }
}

fn is_safe_trash_target(path: &str) -> bool {
    let p = std::path::Path::new(path);
    if !p.is_absolute() || !p.exists() {
        return false;
    }
    // Never trash filesystem roots or the user's home folder itself.
    if p.parent().is_none() {
        return false;
    }
    if let Ok(home) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        if std::path::Path::new(&home) == p {
            return false;
        }
    }
    true
}

/// Moves dropped files to the recycle bin. Returns how many were moved.
#[tauri::command]
pub fn trash_files(paths: Vec<String>) -> Result<u32, String> {
    let targets: Vec<String> = paths
        .into_iter()
        .filter(|p| is_safe_trash_target(p))
        .take(4096)
        .collect();
    if targets.is_empty() {
        return Ok(0);
    }

    #[cfg(target_os = "macos")]
    {
        let moved = targets.iter().filter(|p| mac::trash_path(p)).count() as u32;
        if moved == 0 {
            return Err("无法移到废纸篓".into());
        }
        return Ok(moved);
    }

    #[cfg(windows)]
    {
        if win::trash_paths(&targets) {
            return Ok(targets.len() as u32);
        }
        return Err("无法移到回收站".into());
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let status = std::process::Command::new("gio")
            .arg("trash")
            .args(&targets)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(targets.len() as u32)
        } else {
            Err("gio trash failed".into())
        }
    }
}

pub fn start_file_drag_watcher(
    app: AppHandle,
    active_flag: Arc<AtomicBool>,
    settings: Arc<Mutex<AppSettings>>,
) {
    std::thread::spawn(move || {
        let mut active = false;
        let mut last_count: u32 = 0;
        #[cfg(target_os = "macos")]
        let mut idle_change: isize = mac::probe().change_count;
        #[cfg(target_os = "macos")]
        let mut evaluated_change: Option<isize> = None;
        #[cfg(target_os = "macos")]
        let mut evaluated_count: usize = 0;

        loop {
            std::thread::sleep(Duration::from_millis(if active { 40 } else { 70 }));

            let enabled = settings.lock().map(|s| s.trash_helper).unwrap_or(true);

            #[allow(unused_mut)]
            let mut detected = false;
            #[allow(unused_mut)]
            let mut count: u32 = 0;

            #[cfg(target_os = "macos")]
            {
                let p = mac::probe();
                if !p.left_down {
                    idle_change = p.change_count;
                    evaluated_change = None;
                } else if enabled && p.change_count != idle_change {
                    if evaluated_change != Some(p.change_count) {
                        evaluated_change = Some(p.change_count);
                        evaluated_count = mac::dragged_file_count();
                    }
                    detected = evaluated_count > 0;
                    count = evaluated_count.min(u32::MAX as usize) as u32;
                }
            }

            #[cfg(windows)]
            {
                if enabled && win::left_down() && win::shell_drag_image_visible() {
                    detected = true;
                }
            }

            if detected && !active {
                active = true;
                last_count = count;
                active_flag.store(true, Ordering::Relaxed);
                let side = crate::pet_trash_side(&app).to_string();
                let _ = app.emit(
                    "kuro-file-drag",
                    FileDragInfo {
                        active: true,
                        count,
                        side,
                    },
                );
            } else if detected && active && count != last_count {
                last_count = count;
                let side = crate::pet_trash_side(&app).to_string();
                let _ = app.emit(
                    "kuro-file-drag",
                    FileDragInfo {
                        active: true,
                        count,
                        side,
                    },
                );
            } else if !detected && active {
                active = false;
                last_count = 0;
                active_flag.store(false, Ordering::Relaxed);
                let _ = app.emit(
                    "kuro-file-drag",
                    FileDragInfo {
                        active: false,
                        count: 0,
                        side: String::new(),
                    },
                );
            }
        }
    });
}


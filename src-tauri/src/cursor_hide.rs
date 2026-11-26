//! Hides the system mouse pointer while it is "transformed" into a flying critter near the cat.
//!
//! Safety first: the frontend must keep re-sending `set_cursor_hidden(true)` while the
//! critter is active; a watchdog restores the pointer if keepalives stop (window hidden,
//! webview stalled...). The pointer is also restored on app exit.
//!
//! - macOS: `CGDisplayHideCursor` + the (widely used) `SetsCursorInBackground` connection
//!   property so a background accessory app may hide the pointer.
//! - Windows: temporarily swaps every system cursor for a blank one, restored via
//!   `SPI_SETCURSORS` (also run once at startup to heal any leftover state).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

static HIDDEN: AtomicBool = AtomicBool::new(false);
static LAST_KEEPALIVE_MS: AtomicU64 = AtomicU64::new(0);
static WATCHDOG_STARTED: AtomicBool = AtomicBool::new(false);

const KEEPALIVE_TIMEOUT_MS: u64 = 1500;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_void};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayHideCursor(display: u32) -> i32;
        fn CGDisplayShowCursor(display: u32) -> i32;
        fn _CGSDefaultConnection() -> i32;
        fn CGSSetConnectionProperty(cid: i32, target: i32, key: *const c_void, value: *const c_void) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: *const c_void;
        fn CFStringCreateWithCString(alloc: *const c_void, c_str: *const c_char, encoding: u32) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    const UTF8: u32 = 0x0800_0100;

    fn allow_background_cursor_control() {
        unsafe {
            let key = CFStringCreateWithCString(
                std::ptr::null(),
                b"SetsCursorInBackground\0".as_ptr() as *const c_char,
                UTF8,
            );
            if key.is_null() {
                return;
            }
            let cid = _CGSDefaultConnection();
            CGSSetConnectionProperty(cid, cid, key, kCFBooleanTrue);
            CFRelease(key);
        }
    }

    pub fn hide() {
        allow_background_cursor_control();
        unsafe {
            CGDisplayHideCursor(CGMainDisplayID());
        }
    }

    pub fn show() {
        allow_background_cursor_control();
        unsafe {
            CGDisplayShowCursor(CGMainDisplayID());
        }
    }

    pub fn heal_on_startup() {}
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn CreateCursor(
            hinst: *mut c_void,
            x_hotspot: i32,
            y_hotspot: i32,
            width: i32,
            height: i32,
            and_plane: *const c_void,
            xor_plane: *const c_void,
        ) -> *mut c_void;
        fn SetSystemCursor(hcur: *mut c_void, id: u32) -> i32;
        fn SystemParametersInfoW(action: u32, param: u32, pv: *mut c_void, win_ini: u32) -> i32;
    }

    const SPI_SETCURSORS: u32 = 0x0057;
    const OCR_IDS: [u32; 14] = [
        32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651,
    ];

    pub fn hide() {
        // AND mask all 1s + XOR mask all 0s = fully transparent 32x32 cursor
        let and_plane = [0xFFu8; 128];
        let xor_plane = [0u8; 128];
        for id in OCR_IDS {
            unsafe {
                let blank = CreateCursor(
                    std::ptr::null_mut(),
                    0,
                    0,
                    32,
                    32,
                    and_plane.as_ptr() as *const c_void,
                    xor_plane.as_ptr() as *const c_void,
                );
                if !blank.is_null() {
                    // SetSystemCursor takes ownership of (and destroys) `blank`
                    SetSystemCursor(blank, id);
                }
            }
        }
    }

    pub fn show() {
        unsafe {
            SystemParametersInfoW(SPI_SETCURSORS, 0, std::ptr::null_mut(), 0);
        }
    }

    pub fn heal_on_startup() {
        show();
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
mod platform {
    pub fn hide() {}
    pub fn show() {}
    pub fn heal_on_startup() {}
}

fn apply(app: &AppHandle, hidden: bool) {
    let prev = HIDDEN.swap(hidden, Ordering::SeqCst);
    if prev == hidden {
        return;
    }
    let _ = app.run_on_main_thread(move || {
        if hidden {
            platform::hide();
        } else {
            platform::show();
        }
    });
}

/// Restores the pointer immediately (used on exit, from any thread).
pub fn restore_now() {
    if HIDDEN.swap(false, Ordering::SeqCst) {
        platform::show();
    }
}

pub fn init(app: AppHandle) {
    platform::heal_on_startup();
    if WATCHDOG_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        if HIDDEN.load(Ordering::SeqCst)
            && now_ms().saturating_sub(LAST_KEEPALIVE_MS.load(Ordering::SeqCst)) > KEEPALIVE_TIMEOUT_MS
        {
            apply(&app, false);
        }
    });
}

/// Frontend: `hidden=true` must be re-sent periodically (keepalive) while the critter is shown.
#[tauri::command]
pub fn set_cursor_hidden(app: AppHandle, hidden: bool) {
    if hidden {
        LAST_KEEPALIVE_MS.store(now_ms(), Ordering::SeqCst);
    }
    apply(&app, hidden);
}

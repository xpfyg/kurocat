use crate::config::AppSettings;
use crate::input_hook;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Starts a lightweight background watcher that detects when the OS focus is inside a
/// password field (Windows UI Automation `IsPassword` + Win32 `ES_PASSWORD`; macOS native
/// `IsSecureEventInputEnabled` + `AXSecureTextField`), immediately suppressing keystroke
/// forwarding in `input_hook` and notifying the frontend to close the cat's eyes / cover BigFish's eyes.
pub fn start_password_privacy_watcher(
    app: AppHandle,
    settings: Arc<Mutex<AppSettings>>,
    paused_guard: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        #[cfg(windows)]
        let uia = win_impl::UiaDetector::new();
        #[cfg(target_os = "macos")]
        let ax = mac_impl::AxDetector::new();

        let mut active = false;
        let mut clear_streak: u8 = 0;

        loop {
            let sleep_ms = if active || input_hook::ms_since_last_input() < 3_000 {
                220
            } else {
                800
            };
            std::thread::sleep(Duration::from_millis(sleep_ms));

            let guard_enabled = !paused_guard.load(Ordering::Relaxed)
                && settings
                    .lock()
                    .map(|s| s.privacy_password_guard)
                    .unwrap_or(true);

            if !guard_enabled {
                if active {
                    active = false;
                    clear_streak = 0;
                    input_hook::set_password_privacy_active(false);
                    let _ = app.emit("mini-privacy", false);
                }
                continue;
            }

            #[cfg(windows)]
            let is_pwd = win_impl::is_focused_password_field(uia.as_ref());
            #[cfg(target_os = "macos")]
            let is_pwd = mac_impl::is_focused_password_field(ax.as_ref());
            #[cfg(all(not(windows), not(target_os = "macos")))]
            let is_pwd = false;

            if is_pwd {
                clear_streak = 0;
                if !active {
                    active = true;
                    input_hook::set_password_privacy_active(true);
                    let _ = app.emit("mini-privacy", true);
                }
            } else if active {
                // Brief 2-tick (~280ms) debounce before exiting so focus flickers inside a login form don't flash open
                clear_streak = clear_streak.saturating_add(1);
                if clear_streak >= 2 {
                    active = false;
                    clear_streak = 0;
                    input_hook::set_password_privacy_active(false);
                    let _ = app.emit("mini-privacy", false);
                }
            }
        }
    });
}

#[cfg(windows)]
mod win_impl {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, UIA_EditControlTypeId,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowLongPtrW,
        GetWindowThreadProcessId, GUITHREADINFO, GWL_STYLE,
    };

    const ES_MULTILINE: isize = 0x0004;
    const ES_PASSWORD: isize = 0x0020;
    const MAX_PASSWORD_BOX_HEIGHT_PX: i32 = 140;

    pub(super) fn is_plausible_password_rect(top: i32, bottom: i32) -> bool {
        let h = bottom.saturating_sub(top);
        // Real visible single-line password boxes are always between 8px and 140px tall.
        // Reject both empty/unimplemented (0px) MSAA/UIA proxies and tall document editors
        // (e.g. WPS Word / Word / Notepad canvases at 300-1000px).
        (8..=MAX_PASSWORD_BOX_HEIGHT_PX).contains(&h)
    }

    pub(super) fn is_classic_edit_class(class_name: &str) -> bool {
        let lower = class_name.to_ascii_lowercase();
        lower == "edit"
            || lower.starts_with("richedit")
            || lower == "tedit"
            || lower == "tmaskedit"
            || lower == "wedit"
            || (lower.starts_with("thunder") && lower.contains("textbox"))
    }

    pub struct UiaDetector {
        uia: IUIAutomation,
        com_inited: bool,
    }

    impl UiaDetector {
        pub fn new() -> Option<Self> {
            unsafe {
                let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
                let com_inited = hr.is_ok();
                let uia: IUIAutomation =
                    CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
                Some(Self { uia, com_inited })
            }
        }

        pub fn focused_is_password(&self) -> bool {
            unsafe {
                let Ok(el) = self.uia.GetFocusedElement() else {
                    return false;
                };
                let is_pwd = match el.CurrentIsPassword() {
                    Ok(b) => b.as_bool(),
                    Err(_) => false,
                };
                if !is_pwd {
                    return false;
                }
                // Guard against buggy third-party UIA/MSAA providers (e.g. WPS Office on Windows 7)
                // that falsely report IsPassword=TRUE on Document/Pane/Custom editor surfaces:
                // real password inputs (browsers, UAC, Win32, Qt, Electron, WPF) expose Edit control
                // type and single-line height (<= 140px).
                let Ok(ctrl_type) = el.CurrentControlType() else {
                    return false;
                };
                if ctrl_type != UIA_EditControlTypeId {
                    return false;
                }
                let Ok(rc) = el.CurrentBoundingRectangle() else {
                    return false;
                };
                if !is_plausible_password_rect(rc.top, rc.bottom) {
                    return false;
                }
                true
            }
        }
    }

    impl Drop for UiaDetector {
        fn drop(&mut self) {
            if self.com_inited {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    fn classic_win32_is_password() -> bool {
        unsafe {
            let fg = GetForegroundWindow();
            if fg.is_null() {
                return false;
            }
            let tid = GetWindowThreadProcessId(fg, std::ptr::null_mut());
            if tid == 0 {
                return false;
            }
            let mut info: GUITHREADINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
            if GetGUIThreadInfo(tid, &mut info) == 0 || info.hwndFocus.is_null() {
                return false;
            }
            // ES_PASSWORD (0x0020) is ONLY valid on Edit / RichEdit window classes!
            // On other Win32 controls (e.g. SysTreeView32 TVS_SHOWSELALWAYS, SysTabControl32
            // TCS_FORCELABELLEFT, Explorer/WPS widgets), bit 0x0020 has an unrelated meaning
            // and would falsely lock MiniCat in closed-eyes password mode.
            let mut cls_buf = [0u16; 128];
            let cls_len = GetClassNameW(info.hwndFocus, cls_buf.as_mut_ptr(), cls_buf.len() as i32);
            if cls_len <= 0 {
                return false;
            }
            let cls_name = String::from_utf16_lossy(&cls_buf[..cls_len as usize]);
            if !is_classic_edit_class(&cls_name) {
                return false;
            }
            let style = GetWindowLongPtrW(info.hwndFocus, GWL_STYLE);
            (style & ES_PASSWORD) != 0 && (style & ES_MULTILINE) == 0
        }
    }

    pub fn is_focused_password_field(uia: Option<&UiaDetector>) -> bool {
        if classic_win32_is_password() {
            return true;
        }
        if let Some(det) = uia {
            return det.focused_is_password();
        }
        false
    }
}

#[cfg(target_os = "macos")]
mod mac_impl {
    use std::ffi::c_void;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn IsSecureEventInputEnabled() -> u8;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateSystemWide() -> *mut c_void;
        fn AXUIElementCopyAttributeValue(
            element: *mut c_void,
            attribute: *const c_void,
            value: *mut *mut c_void,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFStringCreateWithBytes(
            alloc: *const c_void,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external_rep: u8,
        ) -> *mut c_void;
        fn CFGetTypeID(cf: *const c_void) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFEqual(cf1: *const c_void, cf2: *const c_void) -> u8;
    }

    unsafe fn make_cf_string(s: &str) -> *mut c_void {
        CFStringCreateWithBytes(
            std::ptr::null(),
            s.as_ptr(),
            s.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
            0,
        )
    }

    pub struct AxDetector {
        sys_wide: *mut c_void,
        attr_focused: *mut c_void,
        attr_subrole: *mut c_void,
        secure_subrole: *mut c_void,
    }

    impl AxDetector {
        pub fn new() -> Option<Self> {
            unsafe {
                let sys_wide = AXUIElementCreateSystemWide();
                if sys_wide.is_null() {
                    return None;
                }
                let attr_focused = make_cf_string("AXFocusedUIElement");
                let attr_subrole = make_cf_string("AXSubrole");
                let secure_subrole = make_cf_string("AXSecureTextField");
                if attr_focused.is_null() || attr_subrole.is_null() || secure_subrole.is_null() {
                    if !secure_subrole.is_null() {
                        CFRelease(secure_subrole);
                    }
                    if !attr_subrole.is_null() {
                        CFRelease(attr_subrole);
                    }
                    if !attr_focused.is_null() {
                        CFRelease(attr_focused);
                    }
                    CFRelease(sys_wide);
                    return None;
                }
                Some(Self {
                    sys_wide,
                    attr_focused,
                    attr_subrole,
                    secure_subrole,
                })
            }
        }

        unsafe fn focused_is_secure_text_field(&self) -> bool {
            if !AXIsProcessTrusted() {
                return false;
            }
            let mut is_secure = false;
            let mut focused: *mut c_void = std::ptr::null_mut();
            let err1 = AXUIElementCopyAttributeValue(self.sys_wide, self.attr_focused, &mut focused);
            if err1 == 0 && !focused.is_null() {
                let mut subrole: *mut c_void = std::ptr::null_mut();
                let err2 = AXUIElementCopyAttributeValue(focused, self.attr_subrole, &mut subrole);
                if err2 == 0 && !subrole.is_null() {
                    if CFGetTypeID(subrole) == CFStringGetTypeID()
                        && CFEqual(subrole, self.secure_subrole) != 0
                    {
                        is_secure = true;
                    }
                    CFRelease(subrole);
                }
                CFRelease(focused);
            }
            is_secure
        }
    }

    impl Drop for AxDetector {
        fn drop(&mut self) {
            unsafe {
                CFRelease(self.secure_subrole);
                CFRelease(self.attr_subrole);
                CFRelease(self.attr_focused);
                CFRelease(self.sys_wide);
            }
        }
    }

    pub fn is_focused_password_field(ax: Option<&AxDetector>) -> bool {
        unsafe {
            if IsSecureEventInputEnabled() != 0 {
                return true;
            }
            if let Some(det) = ax {
                return det.focused_is_secure_text_field();
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn windows_password_detector_initializes_and_probes_safely() {
        let det = super::win_impl::UiaDetector::new();
        assert!(det.is_some(), "CUIAutomation COM object should initialize cleanly on Windows");
        let _ = super::win_impl::is_focused_password_field(det.as_ref());
    }

    #[cfg(windows)]
    #[test]
    fn classic_edit_class_filter_rejects_non_edit_win32_controls() {
        assert!(super::win_impl::is_classic_edit_class("Edit"));
        assert!(super::win_impl::is_classic_edit_class("RICHEDIT50W"));
        assert!(super::win_impl::is_classic_edit_class("RichEdit20W"));
        assert!(!super::win_impl::is_classic_edit_class("SysTreeView32"));
        assert!(!super::win_impl::is_classic_edit_class("SysListView32"));
        assert!(!super::win_impl::is_classic_edit_class("SysTabControl32"));
        assert!(!super::win_impl::is_classic_edit_class("DirectUIHWND"));
        assert!(!super::win_impl::is_classic_edit_class("Chrome_RenderWidgetHostHWND"));
        assert!(super::win_impl::is_plausible_password_rect(100, 132)); // 32px real password box
        assert!(super::win_impl::is_plausible_password_rect(100, 180)); // 80px HiDPI password box
        assert!(!super::win_impl::is_plausible_password_rect(0, 0));    // broken empty UIA proxy
        assert!(!super::win_impl::is_plausible_password_rect(100, 720)); // 620px WPS Word document
    }
}

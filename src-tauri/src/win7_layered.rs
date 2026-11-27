#![cfg(windows)]

use crate::config::save_settings;
use crate::AppState;
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
    HBITMAP, HDC, HGDIOBJ, RGBQUAD,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    GetWindowLongPtrW, GetWindowRect, IsWindowVisible, LoadCursorW, PostMessageW, PostQuitMessage,
    RegisterClassExW, SendMessageW, SetCursor, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    TranslateMessage, UpdateLayeredWindow, GWL_EXSTYLE, HTCAPTION, HTCLIENT, HWND_NOTOPMOST,
    HWND_TOPMOST, IDC_ARROW, IDC_HAND, MA_NOACTIVATE, MSG, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, ULW_ALPHA, WM_APP, WM_CLOSE,
    WM_DESTROY, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_LBUTTONDOWN, WM_MOUSEACTIVATE,
    WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SETCURSOR, WNDCLASSEXW,
    WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP, MA_ACTIVATE,
};

const WM_APP_PRESENT: u32 = WM_APP + 1;
const WM_APP_SET_VISIBLE: u32 = WM_APP + 2;
const WM_APP_SET_POS: u32 = WM_APP + 3;
const WM_APP_SET_TOPMOST: u32 = WM_APP + 4;
const WM_APP_SET_CLICK_THROUGH: u32 = WM_APP + 5;
const WM_APP_REASSERT_TOPMOST: u32 = WM_APP + 6;
const WM_APP_SHUTDOWN: u32 = WM_APP + 7;

struct PendingFrame {
    width: u32,
    height: u32,
    bgra: Vec<u8>,
    has_frame: bool,
}

struct Win7LayeredHub {
    hwnd: AtomicIsize,
    visible: AtomicBool,
    always_on_top: AtomicBool,
    click_through: AtomicBool,
    over_cat: AtomicBool,
    dragging: AtomicBool,
    overlay_active: AtomicBool,
    present_queued: AtomicBool,
    presented_frames: AtomicIsize,
    dumped_once: AtomicBool,
    pending: Mutex<PendingFrame>,
    app: Mutex<Option<AppHandle>>,
}

static HUB: OnceLock<Win7LayeredHub> = OnceLock::new();

fn hub() -> &'static Win7LayeredHub {
    HUB.get_or_init(|| Win7LayeredHub {
        hwnd: AtomicIsize::new(0),
        visible: AtomicBool::new(true),
        always_on_top: AtomicBool::new(true),
        click_through: AtomicBool::new(false),
        over_cat: AtomicBool::new(false),
        dragging: AtomicBool::new(false),
        overlay_active: AtomicBool::new(false),
        present_queued: AtomicBool::new(false),
        presented_frames: AtomicIsize::new(0),
        dumped_once: AtomicBool::new(false),
        pending: Mutex::new(PendingFrame {
            width: 0,
            height: 0,
            bgra: Vec::new(),
            has_frame: false,
        }),
        app: Mutex::new(None),
    })
}

/// Convert straight (un-premultiplied) RGBA bytes from HTML5 Canvas 2D `getImageData()`
/// into Windows GDI premultiplied BGRA bytes required by `UpdateLayeredWindow(..., ULW_ALPHA)`.
pub fn rgba_to_premultiplied_bgra(rgba: &[u8], out_bgra: &mut [u8]) {
    debug_assert_eq!(rgba.len(), out_bgra.len());
    debug_assert_eq!(rgba.len() % 4, 0);
    for (src, dst) in rgba.chunks_exact(4).zip(out_bgra.chunks_exact_mut(4)) {
        let a = src[3];
        if a == 0 {
            dst[0] = 0;
            dst[1] = 0;
            dst[2] = 0;
            dst[3] = 0;
        } else if a == 255 {
            dst[0] = src[2];
            dst[1] = src[1];
            dst[2] = src[0];
            dst[3] = 255;
        } else {
            let a32 = a as u32;
            dst[0] = ((src[2] as u32 * a32 + 127) / 255) as u8;
            dst[1] = ((src[1] as u32 * a32 + 127) / 255) as u8;
            dst[2] = ((src[0] as u32 * a32 + 127) / 255) as u8;
            dst[3] = a;
        }
    }
}

struct DibPresenter {
    hdc_mem: HDC,
    hbmp: HBITMAP,
    old_obj: HGDIOBJ,
    bits: *mut u8,
    width: u32,
    height: u32,
}

impl DibPresenter {
    fn new() -> Self {
        Self {
            hdc_mem: std::ptr::null_mut(),
            hbmp: std::ptr::null_mut(),
            old_obj: std::ptr::null_mut(),
            bits: std::ptr::null_mut(),
            width: 0,
            height: 0,
        }
    }

    fn release(&mut self) {
        unsafe {
            if !self.hdc_mem.is_null() {
                if !self.old_obj.is_null() {
                    SelectObject(self.hdc_mem, self.old_obj);
                    self.old_obj = std::ptr::null_mut();
                }
                if !self.hbmp.is_null() {
                    DeleteObject(self.hbmp as _);
                    self.hbmp = std::ptr::null_mut();
                }
                DeleteDC(self.hdc_mem);
                self.hdc_mem = std::ptr::null_mut();
            } else if !self.hbmp.is_null() {
                DeleteObject(self.hbmp as _);
                self.hbmp = std::ptr::null_mut();
            }
        }
        self.bits = std::ptr::null_mut();
        self.width = 0;
        self.height = 0;
    }

    fn ensure_size(&mut self, w: u32, h: u32) -> bool {
        if w == 0 || h == 0 || w > 4096 || h > 4096 {
            return false;
        }
        if self.width == w
            && self.height == h
            && !self.hdc_mem.is_null()
            && !self.hbmp.is_null()
            && !self.bits.is_null()
        {
            return true;
        }
        self.release();
        unsafe {
            let hdc_screen = GetDC(std::ptr::null_mut());
            if hdc_screen.is_null() {
                return false;
            }
            let hdc_mem = CreateCompatibleDC(hdc_screen);
            let _ = ReleaseDC(std::ptr::null_mut(), hdc_screen);
            if hdc_mem.is_null() {
                return false;
            }
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    biHeight: -(h as i32), // top-down 32-bit DIB
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [RGBQUAD {
                    rgbBlue: 0,
                    rgbGreen: 0,
                    rgbRed: 0,
                    rgbReserved: 0,
                }],
            };
            let mut raw_bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let hbmp = CreateDIBSection(
                hdc_mem,
                &bmi,
                DIB_RGB_COLORS,
                &mut raw_bits,
                std::ptr::null_mut(),
                0,
            );
            if hbmp.is_null() || raw_bits.is_null() {
                if !hbmp.is_null() {
                    DeleteObject(hbmp as _);
                }
                DeleteDC(hdc_mem);
                return false;
            }
            let old_obj = SelectObject(hdc_mem, hbmp as _);
            self.hdc_mem = hdc_mem;
            self.hbmp = hbmp;
            self.old_obj = old_obj;
            self.bits = raw_bits as *mut u8;
            self.width = w;
            self.height = h;
            true
        }
    }

    fn present(&mut self, hwnd: HWND, w: u32, h: u32, bgra: &[u8]) -> bool {
        let Some(expected) = (w as usize)
            .checked_mul(h as usize)
            .and_then(|px| px.checked_mul(4))
        else {
            return false;
        };
        if bgra.len() != expected {
            return false;
        }
        if !self.ensure_size(w, h) {
            return false;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bgra.as_ptr(), self.bits, expected);
            let hdc_screen = GetDC(std::ptr::null_mut());
            if hdc_screen.is_null() {
                return false;
            }
            let pt_src = POINT { x: 0, y: 0 };
            let size = SIZE {
                cx: w as i32,
                cy: h as i32,
            };
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            };
            // Passing pptDst = NULL keeps the current screen position untouched, so frames
            // keep animating smoothly even while the user is dragging the window!
            let ok = UpdateLayeredWindow(
                hwnd,
                hdc_screen,
                std::ptr::null(),
                &size,
                self.hdc_mem,
                &pt_src,
                0,
                &blend,
                ULW_ALPHA,
            );
            let _ = ReleaseDC(std::ptr::null_mut(), hdc_screen);
            ok != 0
        }
    }
}

impl Drop for DibPresenter {
    fn drop(&mut self) {
        self.release();
    }
}

thread_local! {
    static PRESENTER: RefCell<DibPresenter> = RefCell::new(DibPresenter::new());
}

fn present_latest_on_thread(hwnd: HWND) {
    let h = hub();
    h.present_queued.store(false, Ordering::Release);
    if !h.visible.load(Ordering::Relaxed) {
        return;
    }
    let (w, h_px, buf) = {
        let guard = h.pending.lock().unwrap();
        if !guard.has_frame || guard.width == 0 || guard.height == 0 || guard.bgra.is_empty() {
            return;
        }
        (guard.width, guard.height, guard.bgra.clone())
    };
    let ok = PRESENTER.with(|cell| cell.borrow_mut().present(hwnd, w, h_px, &buf));
    if ok {
        let count = h.presented_frames.fetch_add(1, Ordering::Relaxed) + 1;
        // Optional diagnostic frame dump for automated visual verification (only when env var set)
        if count >= 6 && !h.dumped_once.load(Ordering::Relaxed) {
            if let Ok(dump_path) = std::env::var("MINICAT_WIN7_ULW_DUMP") {
                if !dump_path.trim().is_empty()
                    && !h.dumped_once.swap(true, Ordering::AcqRel)
                {
                    let mut out = Vec::with_capacity(8 + buf.len());
                    out.extend_from_slice(&w.to_le_bytes());
                    out.extend_from_slice(&h_px.to_le_bytes());
                    out.extend_from_slice(&buf);
                    let _ = std::fs::write(dump_path.trim(), out);
                }
            }
        }
    }
}

fn is_interactive_now() -> bool {
    let h = hub();
    if let Some(app) = h.app.lock().unwrap().as_ref() {
        let state = app.state::<AppState>();
        let locked = state.settings.lock().unwrap().click_through_locked;
        if locked && !crate::input_hook::is_alt_pressed() {
            return false;
        }
    }
    true
}

fn persist_hwnd_position(hwnd: HWND) {
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    unsafe {
        if GetWindowRect(hwnd, &mut rc) == 0 {
            return;
        }
    }
    let app_opt = hub().app.lock().unwrap().clone();
    if let Some(app) = app_opt {
        let state = app.state::<AppState>();
        let mut s = state.settings.lock().unwrap();
        s.x = Some(rc.left);
        s.y = Some(rc.top);
        save_settings(&s);
    }
}

unsafe extern "system" fn ulw_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_APP_PRESENT => {
            present_latest_on_thread(hwnd);
            0
        }
        WM_APP_SET_VISIBLE => {
            let show = wparam != 0;
            hub().visible.store(show, Ordering::Relaxed);
            ShowWindow(hwnd, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });
            if show {
                present_latest_on_thread(hwnd);
                if hub().always_on_top.load(Ordering::Relaxed) {
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            }
            0
        }
        WM_APP_SET_POS => {
            let x = wparam as i32;
            let y = lparam as i32;
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                x,
                y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            0
        }
        WM_APP_SET_TOPMOST => {
            let on_top = wparam != 0;
            hub().always_on_top.store(on_top, Ordering::Relaxed);
            SetWindowPos(
                hwnd,
                if on_top { HWND_TOPMOST } else { HWND_NOTOPMOST },
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            0
        }
        WM_APP_SET_CLICK_THROUGH => {
            let ignore = wparam != 0;
            hub().click_through.store(ignore, Ordering::Relaxed);
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let new_ex = if ignore {
                ex | (WS_EX_LAYERED as isize) | (WS_EX_TRANSPARENT as isize)
            } else {
                (ex | (WS_EX_LAYERED as isize)) & !(WS_EX_TRANSPARENT as isize)
            };
            if new_ex != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
            0
        }
        WM_APP_REASSERT_TOPMOST => {
            if hub().visible.load(Ordering::Relaxed) && hub().always_on_top.load(Ordering::Relaxed)
            {
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
            0
        }
        WM_APP_SHUTDOWN => {
            let _ = DestroyWindow(hwnd);
            0
        }
        WM_MOUSEACTIVATE => {
            // Only activate on right-click so opening #context-menu grants clean foreground focus
            // (allowing Esc and click-outside blur to dismiss the menu reliably on Win7); left-click
            // dragging never steals focus from editors or games.
            let mouse_msg = ((lparam >> 16) & 0xffff) as u32;
            if mouse_msg == WM_RBUTTONDOWN {
                MA_ACTIVATE as LRESULT
            } else {
                MA_NOACTIVATE as LRESULT
            }
        }
        WM_SETCURSOR => {
            if (lparam & 0xffff) == HTCLIENT as isize {
                let want_hand = hub().over_cat.load(Ordering::Relaxed)
                    && !hub().click_through.load(Ordering::Relaxed);
                let cursor_id = if want_hand { IDC_HAND } else { IDC_ARROW };
                let hcur = LoadCursorW(std::ptr::null_mut(), cursor_id);
                if !hcur.is_null() {
                    SetCursor(hcur);
                    return 1;
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_LBUTTONDOWN => {
            if !is_interactive_now() {
                return 0;
            }
            let app_opt = hub().app.lock().unwrap().clone();
            if let Some(ref app) = app_opt {
                let _ = app.emit("mini-win7-close-menu", ());
                app.state::<AppState>()
                    .dragging
                    .store(true, Ordering::Relaxed);
            }
            hub().dragging.store(true, Ordering::Relaxed);
            let _ = ReleaseCapture();
            SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION as WPARAM, 0);
            hub().dragging.store(false, Ordering::Relaxed);
            if let Some(ref app) = app_opt {
                app.state::<AppState>()
                    .dragging
                    .store(false, Ordering::Relaxed);
            }
            persist_hwnd_position(hwnd);
            0
        }
        WM_ENTERSIZEMOVE => {
            hub().dragging.store(true, Ordering::Relaxed);
            0
        }
        WM_EXITSIZEMOVE => {
            hub().dragging.store(false, Ordering::Relaxed);
            persist_hwnd_position(hwnd);
            0
        }
        WM_NCLBUTTONDBLCLK => 0,
        WM_RBUTTONDOWN => 0,
        WM_RBUTTONUP => {
            if !is_interactive_now() {
                return 0;
            }
            let px = (lparam & 0xffff) as i16 as f64;
            let py = ((lparam >> 16) & 0xffff) as i16 as f64;
            let app_opt = hub().app.lock().unwrap().clone();
            if let Some(app) = app_opt {
                let sf = app
                    .get_webview_window("main")
                    .and_then(|w| w.scale_factor().ok())
                    .unwrap_or(1.0)
                    .max(0.5);
                let _ = app.emit(
                    "mini-win7-contextmenu",
                    serde_json::json!({
                        "x": px / sf,
                        "y": py / sf,
                    }),
                );
            }
            0
        }
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            PRESENTER.with(|cell| cell.borrow_mut().release());
            hub().hwnd.store(0, Ordering::Release);
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

pub fn init(app: AppHandle, x: i32, y: i32, w: u32, h: u32, always_on_top: bool) {
    let hub_ref = hub();
    *hub_ref.app.lock().unwrap() = Some(app);
    hub_ref
        .always_on_top
        .store(always_on_top, Ordering::Relaxed);
    hub_ref.visible.store(true, Ordering::Relaxed);

    if hub_ref.hwnd.load(Ordering::Acquire) != 0 {
        set_position(x, y);
        set_always_on_top(always_on_top);
        return;
    }

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<bool>();
    let _ = std::thread::Builder::new()
        .name("minicat-win7-ulw".to_string())
        .spawn(move || {
            let class_name: Vec<u16> = "MiniCatWin7LayeredClass\0".encode_utf16().collect();
            let title: Vec<u16> = "MiniCat\0".encode_utf16().collect();
            unsafe {
                let hinst = GetModuleHandleW(std::ptr::null());
                let wc = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    style: 0,
                    lpfnWndProc: Some(ulw_wnd_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: hinst,
                    hIcon: std::ptr::null_mut(),
                    hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                    hbrBackground: std::ptr::null_mut(),
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: class_name.as_ptr(),
                    hIconSm: std::ptr::null_mut(),
                };
                let _ = RegisterClassExW(&wc);

                let mut ex_style = WS_EX_LAYERED | WS_EX_TOOLWINDOW;
                if always_on_top {
                    ex_style |= WS_EX_TOPMOST;
                }
                let hwnd = CreateWindowExW(
                    ex_style,
                    class_name.as_ptr(),
                    title.as_ptr(),
                    WS_POPUP,
                    x,
                    y,
                    w.max(1) as i32,
                    h.max(1) as i32,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    hinst,
                    std::ptr::null(),
                );
                if hwnd.is_null() {
                    let _ = ready_tx.send(false);
                    return;
                }
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                hub().hwnd.store(hwnd as isize, Ordering::Release);
                let _ = ready_tx.send(true);

                // If a frame arrived right as we initialized, present it immediately
                if hub().pending.lock().unwrap().has_frame {
                    present_latest_on_thread(hwnd);
                }

                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });

    let _ = ready_rx.recv_timeout(std::time::Duration::from_secs(3));
}

pub fn submit_rgba_frame(w: u32, h: u32, rgba: &[u8]) {
    if w == 0 || h == 0 || w > 4096 || h > 4096 {
        return;
    }
    let Some(expected) = (w as usize)
        .checked_mul(h as usize)
        .and_then(|px| px.checked_mul(4))
    else {
        return;
    };
    if rgba.len() != expected {
        return;
    }

    let hub_ref = hub();
    {
        let mut guard = hub_ref.pending.lock().unwrap();
        if guard.bgra.len() != expected {
            guard.bgra.resize(expected, 0);
        }
        rgba_to_premultiplied_bgra(rgba, &mut guard.bgra);
        guard.width = w;
        guard.height = h;
        guard.has_frame = true;
    }

    let raw_hwnd = hub_ref.hwnd.load(Ordering::Acquire);
    if raw_hwnd != 0 && !hub_ref.present_queued.swap(true, Ordering::AcqRel) {
        unsafe {
            let _ = PostMessageW(raw_hwnd as HWND, WM_APP_PRESENT, 0, 0);
        }
    }
}

pub fn hwnd() -> Option<HWND> {
    let raw = hub().hwnd.load(Ordering::Acquire);
    if raw != 0 {
        Some(raw as HWND)
    } else {
        None
    }
}

pub fn is_visible() -> bool {
    let hub_ref = hub();
    if let Some(h) = hwnd() {
        unsafe { IsWindowVisible(h) != 0 }
    } else {
        hub_ref.visible.load(Ordering::Relaxed)
    }
}

pub fn set_visible(visible: bool) {
    hub().visible.store(visible, Ordering::Relaxed);
    if let Some(h) = hwnd() {
        unsafe {
            let _ = PostMessageW(h, WM_APP_SET_VISIBLE, visible as WPARAM, 0);
        }
    }
}

pub fn set_position(x: i32, y: i32) {
    if let Some(h) = hwnd() {
        unsafe {
            let _ = PostMessageW(h, WM_APP_SET_POS, x as isize as usize, y as isize);
        }
    }
}

pub fn set_always_on_top(on_top: bool) {
    hub().always_on_top.store(on_top, Ordering::Relaxed);
    if let Some(h) = hwnd() {
        unsafe {
            let _ = PostMessageW(h, WM_APP_SET_TOPMOST, on_top as WPARAM, 0);
        }
    }
}

pub fn set_click_through(ignore: bool) {
    hub().click_through.store(ignore, Ordering::Relaxed);
    if let Some(h) = hwnd() {
        unsafe {
            let _ = PostMessageW(h, WM_APP_SET_CLICK_THROUGH, ignore as WPARAM, 0);
        }
    }
}

pub fn is_click_through() -> Option<bool> {
    let h = hwnd()?;
    let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) };
    Some((ex & (WS_EX_TRANSPARENT as isize)) != 0)
}

pub fn set_over_cat(over: bool) {
    hub().over_cat.store(over, Ordering::Relaxed);
}

pub fn set_overlay_active(active: bool) {
    hub().overlay_active.store(active, Ordering::Relaxed);
}

pub fn is_overlay_active() -> bool {
    hub().overlay_active.load(Ordering::Relaxed)
}

pub fn reassert_topmost() {
    if let Some(h) = hwnd() {
        unsafe {
            let _ = PostMessageW(h, WM_APP_REASSERT_TOPMOST, 0, 0);
        }
    }
}

pub fn shutdown() {
    if let Some(h) = hwnd() {
        unsafe {
            let _ = PostMessageW(h, WM_APP_SHUTDOWN, 0, 0);
        }
    }
}

pub fn get_rect() -> Option<(i32, i32, i32, i32)> {
    let h = hwnd()?;
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    unsafe {
        if GetWindowRect(h, &mut rc) != 0 {
            Some((rc.left, rc.top, (rc.right - rc.left).max(1), (rc.bottom - rc.top).max(1)))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn premultiplies_straight_rgba_to_bgra_accurately() {
        let rgba: [u8; 16] = [
            // Fully transparent pixel with dirty RGB -> must become (0,0,0,0)
            255, 128, 64, 0,
            // Fully opaque pixel (R=20, G=140, B=240, A=255) -> BGRA (240, 140, 20, 255)
            20, 140, 240, 255,
            // 50% translucent anti-aliased edge pixel (R=200, G=100, B=50, A=128)
            200, 100, 50, 128,
            // Soft 10% shadow pixel (R=30, G=30, B=30, A=26)
            30, 30, 30, 26,
        ];
        let mut bgra = [0u8; 16];
        rgba_to_premultiplied_bgra(&rgba, &mut bgra);

        assert_eq!(&bgra[0..4], &[0, 0, 0, 0]);
        assert_eq!(&bgra[4..8], &[240, 140, 20, 255]);
        // (50*128+127)/255 = 25, (100*128+127)/255 = 50, (200*128+127)/255 = 100
        assert_eq!(&bgra[8..12], &[25, 50, 100, 128]);
        // (30*26+127)/255 = 3
        assert_eq!(&bgra[12..16], &[3, 3, 3, 26]);
    }

    #[test]
    fn dib_presenter_updates_real_win32_layered_window_with_ulw_alpha() {
        let class_name: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "MiniCatULWUnitTest\0".encode_utf16().collect();
        unsafe {
            let hinst = GetModuleHandleW(std::ptr::null());
            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                120,
                140,
                64,
                64,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hinst,
                std::ptr::null(),
            );
            assert!(!hwnd.is_null(), "CreateWindowExW(WS_EX_LAYERED) must succeed");

            let w = 64u32;
            let h = 64u32;
            let mut rgba = vec![0u8; (w * h * 4) as usize];
            // Draw a smooth anti-aliased disc in the center, leaving corners alpha=0
            for y in 0..h {
                for x in 0..w {
                    let dx = x as f32 - 31.5;
                    let dy = y as f32 - 31.5;
                    let dist = (dx * dx + dy * dy).sqrt();
                    let a = ((20.0 - dist).clamp(0.0, 1.0) * 255.0).round() as u8;
                    let i = ((y * w + x) * 4) as usize;
                    rgba[i] = 40;
                    rgba[i + 1] = 200;
                    rgba[i + 2] = 90;
                    rgba[i + 3] = a;
                }
            }
            let mut bgra = vec![0u8; rgba.len()];
            rgba_to_premultiplied_bgra(&rgba, &mut bgra);

            let mut presenter = DibPresenter::new();
            assert!(
                presenter.present(hwnd, w, h, &bgra),
                "UpdateLayeredWindow(..., ULW_ALPHA) must succeed with 32-bit premultiplied DIBSection"
            );

            // Verify pptDst = NULL preserved initial screen coordinates (120, 140)
            let mut rc = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            assert_ne!(GetWindowRect(hwnd, &mut rc), 0);
            assert_eq!((rc.left, rc.top), (120, 140));
            assert_eq!((rc.right - rc.left, rc.bottom - rc.top), (64, 64));

            // Resize to 96x80 and verify DIB recreation + ULW_ALPHA succeeds cleanly
            let rgba2 = vec![0u8; (96 * 80 * 4) as usize];
            let mut bgra2 = vec![0u8; rgba2.len()];
            rgba_to_premultiplied_bgra(&rgba2, &mut bgra2);
            assert!(presenter.present(hwnd, 96, 80, &bgra2));
            assert_ne!(GetWindowRect(hwnd, &mut rc), 0);
            assert_eq!((rc.left, rc.top), (120, 140));
            assert_eq!((rc.right - rc.left, rc.bottom - rc.top), (96, 80));

            presenter.release();
            let _ = DestroyWindow(hwnd);
        }
    }
}

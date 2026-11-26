#![recursion_limit = "256"]

mod cats;
mod config;
mod file_drag;
mod input_hook;
mod mcp;
mod media;
mod privacy;
mod tray;
mod updater;
#[cfg(windows)]
mod win7_layered;

#[cfg(windows)]
const WIN7_OFFSCREEN_PARK_POS: i32 = -16000;

use cats::{all_cats, cat_exists, cats_path, sanitize_cat_id, CatSkinConfig};
use config::{
    config_path, load_settings, normalize_keyboard_layout, normalize_keyboard_orientation,
    save_settings, set_windows_autostart, AppSettings,
};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Size, State};

pub const BASE_WIDTH: f64 = 420.0;
pub const BASE_HEIGHT: f64 = 440.0;
pub const BASE_WIDTH_108: f64 = 540.0;
pub const BASE_HEIGHT_108: f64 = 456.0;
pub const MIN_WINDOW_WIDTH: f64 = 260.0;
pub const MIN_WINDOW_HEIGHT: f64 = 410.0;

pub fn base_dimensions(layout: &str) -> (f64, f64) {
    if layout == "108" {
        (BASE_WIDTH_108, BASE_HEIGHT_108)
    } else {
        (BASE_WIDTH, BASE_HEIGHT)
    }
}

pub fn window_dimensions(layout: &str, scale: f64) -> (f64, f64) {
    let (bw, bh) = base_dimensions(layout);
    let s = scale.clamp(0.20, 1.50);
    (
        (bw * s).round().max(MIN_WINDOW_WIDTH),
        (bh * s).round().max(MIN_WINDOW_HEIGHT),
    )
}

fn resize_window_anchored_bottom_right(
    win: &tauri::WebviewWindow,
    layout: &str,
    scale: f64,
) -> Option<(i32, i32)> {
    let (new_w, new_h) = window_dimensions(layout, scale);
    let sf = win.scale_factor().unwrap_or(1.0);

    #[cfg(windows)]
    if win_needs_win7_ulw() {
        let old_rect = win7_layered::get_rect();
        let _ = win.set_size(Size::Logical(LogicalSize::new(new_w, new_h)));
        let new_pw = (new_w * sf).round() as i32;
        let new_ph = (new_h * sf).round() as i32;
        if let Some((ox, oy, ow, oh)) = old_rect {
            let new_x = (ox + ow - new_pw).max(0);
            let new_y = (oy + oh - new_ph).max(0);
            if new_x != ox || new_y != oy {
                win7_layered::set_position(new_x, new_y);
            }
            if win7_layered::is_overlay_active() {
                let _ = win.set_position(PhysicalPosition::new(new_x, new_y));
            } else {
                let _ = win.set_position(PhysicalPosition::new(
                    WIN7_OFFSCREEN_PARK_POS,
                    WIN7_OFFSCREEN_PARK_POS,
                ));
            }
            return Some((new_x, new_y));
        }
        return None;
    }

    let old_pos = win.outer_position().ok();
    let old_size = win.outer_size().ok();
    let _ = win.set_size(Size::Logical(LogicalSize::new(new_w, new_h)));

    if let (Some(pos), Some(sz)) = (old_pos, old_size) {
        let new_pw = (new_w * sf).round() as i32;
        let new_ph = (new_h * sf).round() as i32;
        let new_x = (pos.x + sz.width as i32 - new_pw).max(0);
        let new_y = (pos.y + sz.height as i32 - new_ph).max(0);
        if new_x != pos.x || new_y != pos.y {
            let _ = win.set_position(PhysicalPosition::new(new_x, new_y));
        }
        return Some((new_x, new_y));
    }
    None
}

pub fn is_pet_visible(app: &AppHandle) -> bool {
    #[cfg(windows)]
    if win_needs_win7_ulw() {
        return win7_layered::is_visible();
    }
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(true)
}

pub fn set_pet_visible(app: &AppHandle, visible: bool) {
    let on_top = app
        .state::<AppState>()
        .settings
        .lock()
        .unwrap()
        .always_on_top;

    #[cfg(windows)]
    if win_needs_win7_ulw() {
        win7_layered::set_visible(visible);
        if !visible {
            let _ = app.emit("kuro-win7-close-menu", ());
            win7_layered::set_overlay_active(false);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_position(PhysicalPosition::new(
                    WIN7_OFFSCREEN_PARK_POS,
                    WIN7_OFFSCREEN_PARK_POS,
                ));
            }
        } else if on_top {
            win7_layered::reassert_topmost();
        }
        let _ = app.emit("kuro-win7-visibility", visible);
        return;
    }

    if let Some(win) = app.get_webview_window("main") {
        if visible {
            let _ = win.show();
            #[cfg(windows)]
            if on_top {
                win_gentle_reassert_topmost(&win);
            }
        } else {
            let _ = win.hide();
        }
    }
}

pub fn set_pet_always_on_top(app: &AppHandle, on_top: bool) {
    #[cfg(windows)]
    if win_needs_win7_ulw() {
        win7_layered::set_always_on_top(on_top);
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_always_on_top(on_top);
        #[cfg(target_os = "macos")]
        configure_macos_fullscreen_overlay(&win, on_top);
    }
}

pub fn shutdown_pet_windows() {
    #[cfg(windows)]
    if win_needs_win7_ulw() {
        win7_layered::shutdown();
    }
}

pub fn run_mcp_stdio() {
    mcp::run_stdio_mcp();
}

pub struct AppState {
    pub settings: Arc<Mutex<AppSettings>>,
    pub menu_open: Arc<AtomicBool>,
    pub dragging: Arc<AtomicBool>,
    pub mcp_enabled: Arc<AtomicBool>,
    pub update_banner_open: Arc<AtomicBool>,
    pub paused_guard: Arc<AtomicBool>,
    pub file_drag_active: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowCursorInfo {
    rel_x: f64,
    rel_y: f64,
    inside_window: bool,
    over_cat: bool,
    alt_override: bool,
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn get_cats() -> Vec<CatSkinConfig> {
    all_cats()
}

#[tauri::command]
fn get_mcp_config(state: State<'_, AppState>) -> String {
    let port = state.settings.lock().unwrap().mcp_port;
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "KuroCat.exe".to_string());
    serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": {
            "kurocat": {
                "command": exe,
                "args": ["--mcp"],
                "url": format!("http://127.0.0.1:{}/mcp", port)
            }
        }
    }))
    .unwrap_or_default()
}

#[tauri::command]
fn update_settings(app: AppHandle, state: State<'_, AppState>, mut patch: AppSettings) -> AppSettings {
    patch.scale = patch.scale.clamp(0.20, 1.50);
    let clean_breed = sanitize_cat_id(&patch.cat_breed);
    patch.cat_breed = if cat_exists(&clean_breed) {
        clean_breed
    } else {
        "black".to_string()
    };
    if patch.mcp_port == 0 {
        patch.mcp_port = 27420;
    }
    patch.keyboard_layout = normalize_keyboard_layout(&patch.keyboard_layout);
    patch.keyboard_orientation = normalize_keyboard_orientation(&patch.keyboard_orientation);
    patch.desk_theme = config::normalize_desk_theme(&patch.desk_theme);

    let (prev_autostart, prev_scale, prev_layout) = {
        let s = state.settings.lock().unwrap();
        (s.autostart, s.scale, s.keyboard_layout.clone())
    };
    if patch.autostart != prev_autostart {
        let _ = set_windows_autostart(patch.autostart);
    }

    state.mcp_enabled.store(patch.mcp_enabled, Ordering::Relaxed);

    let size_changed = (patch.scale - prev_scale).abs() > 0.005 || patch.keyboard_layout != prev_layout;
    set_pet_always_on_top(&app, patch.always_on_top);
    if let Some(win) = app.get_webview_window("main") {
        if size_changed {
            if let Some((nx, ny)) =
                resize_window_anchored_bottom_right(&win, &patch.keyboard_layout, patch.scale)
            {
                patch.x = Some(nx);
                patch.y = Some(ny);
            }
        }
    }

    {
        let mut s = state.settings.lock().unwrap();
        *s = patch.clone();
        save_settings(&s);
    }
    let _ = app.emit("kuro-settings", patch.clone());
    patch
}

#[tauri::command]
fn set_menu_open(state: State<'_, AppState>, open: bool) {
    state.menu_open.store(open, Ordering::Relaxed);
}

#[tauri::command]
fn set_dragging(state: State<'_, AppState>, dragging: bool) {
    state.dragging.store(dragging, Ordering::Relaxed);
}

/// Frontend hint: a file drag is hovering inside the pet window (webview drag-enter),
/// so keep the window receptive to the drop even where pixels are transparent.
#[tauri::command]
fn set_file_drop_active(state: State<'_, AppState>, active: bool) {
    state.file_drag_active.store(active, Ordering::Relaxed);
}

/// Which side the cat should hand its trash can toward: cat on the left half of its
/// monitor hands to the right, cat on the right half hands to the left.
pub(crate) fn pet_trash_side(app: &AppHandle) -> &'static str {
    let Some(win) = app.get_webview_window("main") else {
        return "left";
    };
    #[cfg(windows)]
    let rect = if win_needs_win7_ulw() {
        win7_layered::get_rect().map(|(x, y, w, h)| (x, y, w as i32, h as i32))
    } else {
        None
    };
    #[cfg(not(windows))]
    let rect: Option<(i32, i32, i32, i32)> = None;
    let rect = rect.or_else(|| match (win.outer_position(), win.outer_size()) {
        (Ok(p), Ok(s)) => Some((p.x, p.y, s.width as i32, s.height as i32)),
        _ => None,
    });
    let Some((x, y, w, h)) = rect else {
        return "left";
    };
    let cx = x as f64 + w as f64 * 0.5;
    let cy = y as f64 + h as f64 * 0.5;
    let monitor = app
        .monitor_from_point(cx, cy)
        .ok()
        .flatten()
        .or_else(|| win.current_monitor().ok().flatten())
        .or_else(|| win.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let mid = m.position().x as f64 + m.size().width as f64 * 0.5;
            if cx < mid {
                "right"
            } else {
                "left"
            }
        }
        None => "left",
    }
}

#[tauri::command]
fn set_update_banner_open(state: State<'_, AppState>, open: bool) {
    state.update_banner_open.store(open, Ordering::Relaxed);
}

#[tauri::command]
fn get_app_version() -> String {
    updater::CURRENT_VERSION.to_string()
}

#[tauri::command]
async fn check_for_update() -> Result<updater::UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(updater::check_latest_update)
        .await
        .map_err(|e| format!("检查更新任务异常: {}", e))?
}

#[tauri::command]
async fn install_update(app: AppHandle, info: updater::UpdateInfo) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || updater::perform_update_install(&app, info))
        .await
        .map_err(|e| format!("安装更新任务异常: {}", e))?
}

#[tauri::command]
fn open_release_page(url: String) {
    updater::open_url_in_browser(&url);
}

#[tauri::command]
fn save_window_pos(app: AppHandle, state: State<'_, AppState>) {
    #[cfg(windows)]
    if win_needs_win7_ulw() {
        if let Some((x, y, _, _)) = win7_layered::get_rect() {
            let mut s = state.settings.lock().unwrap();
            s.x = Some(x);
            s.y = Some(y);
            save_settings(&s);
        }
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(pos) = win.outer_position() {
            let mut s = state.settings.lock().unwrap();
            s.x = Some(pos.x);
            s.y = Some(pos.y);
            save_settings(&s);
        }
    }
}

#[tauri::command]
fn reset_position(app: AppHandle) {
    reset_window_position(&app);
}

#[tauri::command]
fn create_desktop_shortcut() -> Result<String, String> {
    config::create_desktop_shortcut()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    shutdown_pet_windows();
    app.exit(0);
}

pub fn apply_breed_and_save(app: &AppHandle, breed: &str) {
    let clean = sanitize_cat_id(breed);
    let normalized = if cat_exists(&clean) {
        clean
    } else {
        "black".to_string()
    };
    let state = app.state::<AppState>();
    let updated = {
        let mut s = state.settings.lock().unwrap();
        s.cat_breed = normalized;
        save_settings(&s);
        s.clone()
    };
    let _ = app.emit("kuro-settings", updated);
}

pub fn reload_and_emit_all(app: &AppHandle) {
    let disk_settings = load_settings();
    let cats = all_cats();
    let state = app.state::<AppState>();

    let (size_changed, top_changed) = {
        let mut s = state.settings.lock().unwrap();
        let sc = (s.scale - disk_settings.scale).abs() > 0.01
            || s.keyboard_layout != disk_settings.keyboard_layout;
        let tc = s.always_on_top != disk_settings.always_on_top;
        *s = disk_settings.clone();
        (sc, tc)
    };
    state
        .mcp_enabled
        .store(disk_settings.mcp_enabled, Ordering::Relaxed);

    if top_changed {
        set_pet_always_on_top(app, disk_settings.always_on_top);
    }
    if let Some(win) = app.get_webview_window("main") {
        if size_changed {
            let _ = resize_window_anchored_bottom_right(
                &win,
                &disk_settings.keyboard_layout,
                disk_settings.scale,
            );
        }
    }

    let _ = app.emit("kuro-cats", cats);
    let _ = app.emit("kuro-settings", disk_settings);
}

fn file_mtime(path: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

fn start_storage_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let c_path = cats_path();
        let s_path = config_path();
        let mut last_cats_m = file_mtime(&c_path);
        let mut last_settings_m = file_mtime(&s_path);

        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let cur_c = file_mtime(&c_path);
            let cur_s = file_mtime(&s_path);
            if cur_c != last_cats_m || cur_s != last_settings_m {
                last_cats_m = cur_c;
                last_settings_m = cur_s;
                reload_and_emit_all(&app);
            }
        }
    });
}

pub fn apply_scale_and_save(app: &AppHandle, scale: f64) {
    let clamped = scale.clamp(0.20, 1.50);
    let state = app.state::<AppState>();
    let layout = { state.settings.lock().unwrap().keyboard_layout.clone() };
    let new_pos = app
        .get_webview_window("main")
        .and_then(|win| resize_window_anchored_bottom_right(&win, &layout, clamped));
    let updated = {
        let mut s = state.settings.lock().unwrap();
        s.scale = clamped;
        if let Some((nx, ny)) = new_pos {
            s.x = Some(nx);
            s.y = Some(ny);
        }
        save_settings(&s);
        s.clone()
    };
    let _ = app.emit("kuro-settings", updated);
}

pub fn apply_keyboard_layout_and_save(app: &AppHandle, layout: &str) {
    let normalized = normalize_keyboard_layout(layout);
    let state = app.state::<AppState>();
    let cur_scale = { state.settings.lock().unwrap().scale };
    let new_pos = app
        .get_webview_window("main")
        .and_then(|win| resize_window_anchored_bottom_right(&win, &normalized, cur_scale));
    let updated = {
        let mut s = state.settings.lock().unwrap();
        s.keyboard_layout = normalized;
        if let Some((nx, ny)) = new_pos {
            s.x = Some(nx);
            s.y = Some(ny);
        }
        save_settings(&s);
        s.clone()
    };
    let _ = app.emit("kuro-settings", updated);
}

pub fn apply_keyboard_orientation_and_save(app: &AppHandle, orientation: &str) {
    let normalized = normalize_keyboard_orientation(orientation);
    let state = app.state::<AppState>();
    let updated = {
        let mut s = state.settings.lock().unwrap();
        s.keyboard_orientation = normalized;
        save_settings(&s);
        s.clone()
    };
    let _ = app.emit("kuro-settings", updated);
}

pub fn reset_window_position(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let size = win.outer_size().unwrap_or(tauri::PhysicalSize::new(420, 440));
        let sf = win.scale_factor().unwrap_or(1.0);
        #[cfg(windows)]
        let (w_px, h_px) = if win_needs_win7_ulw() {
            win7_layered::get_rect()
                .map(|(_, _, w, h)| (w, h))
                .unwrap_or((size.width as i32, size.height as i32))
        } else {
            (size.width as i32, size.height as i32)
        };
        #[cfg(not(windows))]
        let (w_px, h_px) = (size.width as i32, size.height as i32);

        let (target_x, target_y) = default_bottom_right_position(w_px, h_px, sf);
        #[cfg(windows)]
        if win_needs_win7_ulw() {
            win7_layered::set_position(target_x, target_y);
            if win7_layered::is_overlay_active() {
                let _ = win.set_position(PhysicalPosition::new(target_x, target_y));
            }
        } else {
            let _ = win.set_position(PhysicalPosition::new(target_x, target_y));
        }
        #[cfg(not(windows))]
        {
            let _ = win.set_position(PhysicalPosition::new(target_x, target_y));
        }

        let state = app.state::<AppState>();
        let mut s = state.settings.lock().unwrap();
        s.x = Some(target_x);
        s.y = Some(target_y);
        save_settings(&s);
    }
}

#[cfg(windows)]
fn default_bottom_right_position(win_w: i32, win_h: i32, _scale_factor: f64) -> (i32, i32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    unsafe {
        let sw = GetSystemMetrics(SM_CXSCREEN);
        let sh = GetSystemMetrics(SM_CYSCREEN);
        ((sw - win_w - 28).max(20), (sh - win_h - 68).max(20))
    }
}

#[cfg(target_os = "macos")]
fn default_bottom_right_position(win_w: i32, win_h: i32, scale_factor: f64) -> (i32, i32) {
    let (sw_pt, sh_pt) = input_hook::macos_hook::main_display_size();
    let sw = (sw_pt * scale_factor).round() as i32;
    let sh = (sh_pt * scale_factor).round() as i32;
    let pad_x = (28.0 * scale_factor).round() as i32;
    let pad_y = (84.0 * scale_factor).round() as i32;
    ((sw - win_w - pad_x).max(20), (sh - win_h - pad_y).max(20))
}

#[cfg(target_os = "linux")]
fn default_bottom_right_position(win_w: i32, win_h: i32, _scale_factor: f64) -> (i32, i32) {
    let (sw, sh) = input_hook::linux_hook::primary_screen_size();
    ((sw - win_w - 28).max(20), (sh - win_h - 68).max(20))
}

#[cfg(all(not(windows), not(target_os = "macos"), not(target_os = "linux")))]
fn default_bottom_right_position(_win_w: i32, _win_h: i32, _scale_factor: f64) -> (i32, i32) {
    (900, 500)
}

#[cfg(windows)]
fn get_cursor_pos(_scale_factor: f64) -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) != 0 {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

#[cfg(target_os = "macos")]
fn get_cursor_pos(scale_factor: f64) -> Option<(i32, i32)> {
    input_hook::macos_hook::cursor_pos_points().map(|(x, y)| {
        (
            (x * scale_factor).round() as i32,
            (y * scale_factor).round() as i32,
        )
    })
}

#[cfg(target_os = "linux")]
fn get_cursor_pos(_scale_factor: f64) -> Option<(i32, i32)> {
    input_hook::linux_hook::cursor_pos()
}

#[cfg(all(not(windows), not(target_os = "macos"), not(target_os = "linux")))]
fn get_cursor_pos(_scale_factor: f64) -> Option<(i32, i32)> {
    None
}

#[cfg(windows)]
fn win_is_click_through(win: &tauri::WebviewWindow) -> Option<bool> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TRANSPARENT,
    };
    let hwnd = win.hwnd().ok()?.0 as windows_sys::Win32::Foundation::HWND;
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    Some((ex & (WS_EX_TRANSPARENT as isize)) != 0)
}

#[cfg(windows)]
fn win_force_click_through(win: &tauri::WebviewWindow, ignore: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_EX_LAYERED, WS_EX_TRANSPARENT,
    };
    let Ok(raw_hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = raw_hwnd.0 as windows_sys::Win32::Foundation::HWND;
    let is_win7 = win_needs_win7_ulw();
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new_ex = if ignore {
            ex | (WS_EX_TRANSPARENT as isize) | (WS_EX_LAYERED as isize)
        } else if is_win7 {
            // Keep the offscreen/overlay WebView2 HWND free of WS_EX_LAYERED so popup overlays
            // (context menu / toast) never hit Win7's layered-alpha=0 invisibility quirk.
            ex & !(WS_EX_TRANSPARENT as isize) & !(WS_EX_LAYERED as isize)
        } else {
            ex & !(WS_EX_TRANSPARENT as isize)
        };
        if new_ex != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);
            let _ = SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
    }
}

#[cfg(windows)]
fn win_foreground_hwnd() -> windows_sys::Win32::Foundation::HWND {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow() }
}

#[cfg(windows)]
fn win_is_topmost(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOPMOST,
    };
    if hwnd.is_null() {
        return false;
    }
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    (ex & (WS_EX_TOPMOST as isize)) != 0
}

#[cfg(windows)]
fn win_is_iconic(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsIconic;
    if hwnd.is_null() {
        return false;
    }
    unsafe { IsIconic(hwnd) != 0 }
}

#[cfg(windows)]
fn win_is_ignored_shell_window(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let mut buf = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if len <= 0 {
        return false;
    }
    let class_name = String::from_utf16_lossy(&buf[..len as usize]);
    matches!(
        class_name.as_str(),
        "Shell_TrayWnd"
            | "Shell_SecondaryTrayWnd"
            | "Progman"
            | "WorkerW"
            | "Windows.UI.Core.CoreWindow"
            | "XamlExplorerHostIslandWindow"
            | "MultitaskingViewFrame"
            | "TaskListThumbnailWnd"
    )
}

#[cfg(windows)]
fn win_rects_overlap(
    a: windows_sys::Win32::Foundation::HWND,
    b: windows_sys::Win32::Foundation::HWND,
) -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let mut ra = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let mut rb = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    unsafe {
        if GetWindowRect(a, &mut ra) == 0 || GetWindowRect(b, &mut rb) == 0 {
            return true;
        }
    }
    ra.left < rb.right && ra.right > rb.left && ra.top < rb.bottom && ra.bottom > rb.top
}

/// Inspired by BongoCat ADR-0096: determine whether the foreground window is
/// currently stacked above our pet window in Windows Z-order using early-exit
/// synchronous EnumWindows (covering both WS_EX_TOPMOST fullscreen windows and
/// Shell-elevated borderless / FSO fullscreen windows on any monitor).
#[cfg(windows)]
fn win_window_is_above(
    candidate: windows_sys::Win32::Foundation::HWND,
    model: windows_sys::Win32::Foundation::HWND,
) -> bool {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows;

    if candidate.is_null() || model.is_null() || candidate == model {
        return false;
    }
    if win_is_ignored_shell_window(candidate) || !win_rects_overlap(candidate, model) {
        return false;
    }

    #[repr(C)]
    struct OrderCtx {
        candidate: HWND,
        model: HWND,
        candidate_above: bool,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut OrderCtx);
        if hwnd == ctx.candidate {
            ctx.candidate_above = true;
            0
        } else if hwnd == ctx.model {
            0
        } else {
            1
        }
    }

    let mut ctx = OrderCtx {
        candidate,
        model,
        candidate_above: false,
    };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), (&mut ctx as *mut OrderCtx) as LPARAM);
    }
    ctx.candidate_above
}

#[cfg(windows)]
pub fn win_gentle_reassert_topmost(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Ok(raw_hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = raw_hwnd.0 as windows_sys::Win32::Foundation::HWND;
    unsafe {
        let _ = SetWindowPos(
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

#[cfg(windows)]
pub fn win_is_elevated() -> bool {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{BOOL, CloseHandle, HANDLE};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(
            process_handle: HANDLE,
            desired_access: u32,
            token_handle: *mut HANDLE,
        ) -> BOOL;
        fn GetTokenInformation(
            token_handle: HANDLE,
            token_information_class: u32,
            token_information: *mut c_void,
            token_information_length: u32,
            return_length: *mut u32,
        ) -> BOOL;
    }

    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_ELEVATION_CLASS: u32 = 20;

    #[repr(C)]
    struct TokenElevation {
        token_is_elevated: u32,
    }

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 || token.is_null() {
            return false;
        }
        let mut elevation = TokenElevation {
            token_is_elevated: 0,
        };
        let mut ret_len: u32 = 0;
        let ok = GetTokenInformation(
            token,
            TOKEN_ELEVATION_CLASS,
            (&mut elevation as *mut TokenElevation).cast(),
            std::mem::size_of::<TokenElevation>() as u32,
            &mut ret_len,
        );
        let _ = CloseHandle(token);
        ok != 0 && elevation.token_is_elevated != 0
    }
}

#[cfg(windows)]
pub fn win_restart_as_admin(app: AppHandle) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: HWND,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> isize;
    }

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let current_pid = std::process::id();

    std::thread::spawn(move || {
        let to_wide = |s: &std::ffi::OsStr| -> Vec<u16> {
            s.encode_wide().chain(std::iter::once(0)).collect()
        };
        let verb = to_wide(std::ffi::OsStr::new("runas"));
        let file = to_wide(exe.as_os_str());
        let params_str = format!("--wait-pid {}", current_pid);
        let params = to_wide(std::ffi::OsStr::new(&params_str));
        let dir = exe.parent().map(|p| to_wide(p.as_os_str()));
        let dir_ptr = dir.as_ref().map_or(std::ptr::null(), |v| v.as_ptr());

        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                params.as_ptr(),
                dir_ptr,
                SW_SHOWNORMAL,
            )
        };
        if result > 32 {
            crate::input_hook::set_hooks_paused(true);
            app.exit(0);
        }
    });
}

#[cfg(windows)]
fn win_wait_for_previous_pid_if_requested() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

    const PROCESS_SYNCHRONIZE: u32 = 0x0010_0000;
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == "--wait-pid" {
            if let Some(pid_str) = args.next() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    if pid != 0 && pid != std::process::id() {
                        unsafe {
                            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
                            if !handle.is_null() {
                                let _ = WaitForSingleObject(handle, 4000);
                                let _ = CloseHandle(handle);
                            }
                        }
                        std::thread::sleep(Duration::from_millis(150));
                    }
                }
            }
            break;
        }
    }
}

#[cfg(target_os = "macos")]
pub fn configure_macos_fullscreen_overlay(win: &tauri::WebviewWindow, always_on_top: bool) {
    use std::ffi::{c_char, c_void};
    #[link(name = "objc")]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    if let Ok(raw_ns_win) = win.ns_window() {
        if raw_ns_win.is_null() {
            return;
        }
        unsafe {
            let sel_get_behavior =
                sel_registerName(b"collectionBehavior\0".as_ptr() as *const c_char);
            let sel_set_behavior =
                sel_registerName(b"setCollectionBehavior:\0".as_ptr() as *const c_char);
            let sel_set_level = sel_registerName(b"setLevel:\0".as_ptr() as *const c_char);

            let get_fn: extern "C" fn(*mut c_void, *mut c_void) -> usize =
                std::mem::transmute(objc_msgSend as *const ());
            let set_usize_fn: extern "C" fn(*mut c_void, *mut c_void, usize) =
                std::mem::transmute(objc_msgSend as *const ());
            let set_isize_fn: extern "C" fn(*mut c_void, *mut c_void, isize) =
                std::mem::transmute(objc_msgSend as *const ());

            let cur = get_fn(raw_ns_win, sel_get_behavior);
            // CanJoinAllSpaces (1 << 0) | Stationary (1 << 4) | FullScreenAuxiliary (1 << 8)
            let next = cur | (1 << 0) | (1 << 4) | (1 << 8);
            set_usize_fn(raw_ns_win, sel_set_behavior, next);
            // NSStatusWindowLevel = 25 (floats above native fullscreen apps/games), Normal = 0
            set_isize_fn(raw_ns_win, sel_set_level, if always_on_top { 25 } else { 0 });
        }
    }
}

fn is_over_interactive_silhouette(rx: f64, ry: f64, is_108: bool) -> (bool, bool) {
    // Cat body/head oval centered around (0.48, 0.49) for 65% or (0.51, 0.48) for 108-key
    let (cat_cx, cat_rx) = if is_108 { (0.51, 0.21) } else { (0.48, 0.25) };
    let dx_cat = (rx - cat_cx) / cat_rx;
    let dy_cat = (ry - 0.49) / 0.27;
    let over_cat = (dx_cat * dx_cat + dy_cat * dy_cat) <= 1.0;

    // Keyboard & mouse lower area
    let over_desk = if is_108 {
        rx >= 0.04 && rx <= 0.94 && ry >= 0.65 && ry <= 0.94
    } else {
        rx >= 0.06 && rx <= 0.92 && ry >= 0.65 && ry <= 0.91
    };

    (over_cat || over_desk, over_cat)
}

fn start_hit_test_loop(
    app: AppHandle,
    settings: Arc<Mutex<AppSettings>>,
    menu_open: Arc<AtomicBool>,
    dragging: Arc<AtomicBool>,
    update_banner_open: Arc<AtomicBool>,
    paused_guard: Arc<AtomicBool>,
    file_drag_active: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut last_ignore: Option<bool> = None;
        let mut last_cursor: (i32, i32) = (i32::MIN, i32::MIN);
        let mut last_alt_override = false;
        let mut last_effective_locked = false;
        let mut cached_visible = true;
        let mut cached_sf: f64 = 1.0;
        let mut cached_rect: Option<(i32, i32, f64, f64)> = None;
        let mut last_geom_refresh = Instant::now() - Duration::from_secs(5);
        let mut next_sleep_ms: u64 = 33;
        #[cfg(windows)]
        let mut drift_ticks: u8 = 0;
        #[cfg(windows)]
        let mut last_fg_hwnd: isize = 0;
        #[cfg(windows)]
        let mut last_topmost_check = Instant::now() - Duration::from_secs(5);
        #[cfg(windows)]
        let mut fg_changed_at: Option<Instant> = None;
        #[cfg(windows)]
        let mut fg_above_attempts: u8 = 0;
        #[cfg(windows)]
        let mut last_topmost_reassert = Instant::now() - Duration::from_secs(5);

        loop {
            std::thread::sleep(Duration::from_millis(next_sleep_ms));

            if paused_guard.load(Ordering::Relaxed) {
                next_sleep_ms = 120;
                continue;
            }
            let Some(win) = app.get_webview_window("main") else {
                next_sleep_ms = 120;
                continue;
            };
            #[cfg(windows)]
            let is_win7_ulw = win_needs_win7_ulw();
            #[cfg(not(windows))]
            let is_win7_ulw = false;

            let is_menu = menu_open.load(Ordering::Relaxed);
            let is_drag = dragging.load(Ordering::Relaxed);
            let is_banner = update_banner_open.load(Ordering::Relaxed);
            let is_file_drag = file_drag_active.load(Ordering::Relaxed);

            let need_geom_refresh = cached_rect.is_none()
                || is_drag
                || is_menu
                || is_banner
                || last_geom_refresh.elapsed() >= Duration::from_millis(500);

            if need_geom_refresh {
                cached_visible = if is_win7_ulw {
                    #[cfg(windows)]
                    {
                        win7_layered::is_visible()
                    }
                    #[cfg(not(windows))]
                    unreachable!()
                } else {
                    win.is_visible().unwrap_or(false)
                };
                if !cached_visible {
                    last_geom_refresh = Instant::now();
                    next_sleep_ms = 150;
                    continue;
                }
                cached_sf = win.scale_factor().unwrap_or(1.0);
                let next_rect = if is_win7_ulw {
                    #[cfg(windows)]
                    {
                        win7_layered::get_rect()
                            .map(|(ux, uy, uw, uh)| (ux, uy, uw.max(1) as f64, uh.max(1) as f64))
                    }
                    #[cfg(not(windows))]
                    unreachable!()
                } else {
                    match (win.outer_position(), win.outer_size()) {
                        (Ok(pos), Ok(size)) => {
                            Some((pos.x, pos.y, size.width.max(1) as f64, size.height.max(1) as f64))
                        }
                        _ => None,
                    }
                };
                if let Some(r) = next_rect {
                    cached_rect = Some(r);
                }
                last_geom_refresh = Instant::now();
            }

            if !cached_visible {
                next_sleep_ms = 150;
                continue;
            }
            let sf = cached_sf;
            let Some((cx, cy)) = get_cursor_pos(sf) else {
                next_sleep_ms = 80;
                continue;
            };
            let Some((win_x, win_y, w, h)) = cached_rect else {
                next_sleep_ms = 80;
                continue;
            };

            let rx = (cx - win_x) as f64 / w;
            let ry = (cy - win_y) as f64 / h;
            let inside = rx >= 0.0 && rx <= 1.0 && ry >= 0.0 && ry <= 1.0;
            let (locked, always_on_top, is_108, cur_scale) = {
                let s = settings.lock().unwrap();
                (
                    s.click_through_locked,
                    s.always_on_top,
                    s.keyboard_layout == "108",
                    s.scale.clamp(0.20, 1.50),
                )
            };

            // Continuous ADR-0096-style Windows Z-order guard for borderless & FSO fullscreen games:
            // checks actual topmost band membership + EnumWindows stacking order against the
            // foreground window every ~500ms (and ~60ms after foreground switches), reasserting
            // HWND_TOPMOST strictly on the window owner thread without stealing focus (SWP_NOACTIVATE).
            #[cfg(windows)]
            if always_on_top && !is_menu && !is_drag {
                let fg_raw = win_foreground_hwnd();
                let fg_id = fg_raw as isize;
                if fg_id != last_fg_hwnd {
                    last_fg_hwnd = fg_id;
                    fg_above_attempts = 0;
                    fg_changed_at = Some(Instant::now());
                }
                let prompt_due = fg_changed_at
                    .map(|t| t.elapsed() >= Duration::from_millis(60))
                    .unwrap_or(false);
                let periodic_due = last_topmost_check.elapsed() >= Duration::from_millis(500);
                if prompt_due || periodic_due {
                    fg_changed_at = None;
                    last_topmost_check = Instant::now();
                    let our_hwnd_opt = if is_win7_ulw {
                        win7_layered::hwnd()
                    } else {
                        win.hwnd()
                            .ok()
                            .map(|h| h.0 as windows_sys::Win32::Foundation::HWND)
                    };
                    if let Some(our_hwnd) = our_hwnd_opt {
                        if !win_is_iconic(our_hwnd) {
                            let lost_topmost = !win_is_topmost(our_hwnd);
                            let fg_above = !lost_topmost
                                && !fg_raw.is_null()
                                && fg_raw != our_hwnd
                                && win_window_is_above(fg_raw, our_hwnd);

                            if !lost_topmost && !fg_above {
                                fg_above_attempts = 0;
                            } else if lost_topmost {
                                if last_topmost_reassert.elapsed() >= Duration::from_millis(250) {
                                    if is_win7_ulw {
                                        win7_layered::reassert_topmost();
                                    } else {
                                        let app_for_top = app.clone();
                                        let _ = app.run_on_main_thread(move || {
                                            if let Some(w) = app_for_top.get_webview_window("main") {
                                                if w.is_visible().unwrap_or(false) {
                                                    win_gentle_reassert_topmost(&w);
                                                }
                                            }
                                        });
                                    }
                                    last_topmost_reassert = Instant::now();
                                }
                            } else if fg_above_attempts < 3 {
                                let cooldown = match fg_above_attempts {
                                    0 => Duration::from_millis(0),
                                    1 => Duration::from_millis(350),
                                    _ => Duration::from_millis(900),
                                };
                                if last_topmost_reassert.elapsed() >= cooldown {
                                    if is_win7_ulw {
                                        win7_layered::reassert_topmost();
                                    } else {
                                        let app_for_top = app.clone();
                                        let _ = app.run_on_main_thread(move || {
                                            if let Some(w) = app_for_top.get_webview_window("main") {
                                                if w.is_visible().unwrap_or(false) {
                                                    win_gentle_reassert_topmost(&w);
                                                }
                                            }
                                        });
                                    }
                                    last_topmost_reassert = Instant::now();
                                    fg_above_attempts = fg_above_attempts.saturating_add(1);
                                }
                            }
                        }
                    }
                }
            } else {
                fg_changed_at = None;
                fg_above_attempts = 0;
            }
            let alt_override = input_hook::is_alt_pressed();
            let effective_locked = locked && !alt_override;

            // Map window-relative (rx, ry) into exact pet-local (pet_rx, pet_ry),
            // since at small scales (20%..90%) the pet is anchored bottom-right inside a min-safe menu window!
            let (bw, bh) = if is_108 {
                (BASE_WIDTH_108, BASE_HEIGHT_108)
            } else {
                (BASE_WIDTH, BASE_HEIGHT)
            };
            let win_log_w = (w / sf).max(1.0);
            let win_log_h = (h / sf).max(1.0);
            let pet_w_frac = ((bw * cur_scale) / win_log_w).clamp(0.05, 1.0);
            let pet_h_frac = ((bh * cur_scale) / win_log_h).clamp(0.05, 1.0);
            let pet_x0 = 1.0 - pet_w_frac;
            let pet_y0 = 1.0 - pet_h_frac;
            let pet_rx = (rx - pet_x0) / pet_w_frac;
            let pet_ry = (ry - pet_y0) / pet_h_frac;
            let inside_pet = pet_rx >= 0.0 && pet_rx <= 1.0 && pet_ry >= 0.0 && pet_ry <= 1.0;

            let (over_interactive, raw_over_cat) = if inside_pet {
                is_over_interactive_silhouette(pet_rx, pet_ry, is_108)
            } else {
                (false, false)
            };
            // While click-through is locked (and Alt is not held), suppress petting hover so users
            // aren't misled by squinting eyes when the cat is intentionally click-through.
            let over_cat = if effective_locked { false } else { raw_over_cat };

            #[cfg(windows)]
            if is_win7_ulw {
                win7_layered::set_over_cat(over_cat);
            }

            let over_banner = is_banner && inside && ry <= 0.19;

            // On Windows 7/8 ULW mode, UpdateLayeredWindow(ULW_ALPHA) natively passes through all
            // alpha==0 pixels at the OS level, so we ONLY toggle WS_EX_TRANSPARENT on ulw_hwnd when
            // click-through is explicitly locked (`effective_locked`).
            let should_ignore = if is_menu || is_drag || over_banner {
                false
            } else if effective_locked {
                true
            } else if is_file_drag && inside {
                // Accept the OS file drop anywhere inside the pet window while the trash can is out
                false
            } else if is_win7_ulw {
                false
            } else {
                !over_interactive
            };

            if last_ignore != Some(should_ignore) {
                #[cfg(windows)]
                if is_win7_ulw {
                    win7_layered::set_click_through(should_ignore);
                } else {
                    let _ = win.set_ignore_cursor_events(should_ignore);
                }
                #[cfg(not(windows))]
                {
                    let _ = win.set_ignore_cursor_events(should_ignore);
                }
                last_ignore = Some(should_ignore);
                #[cfg(windows)]
                {
                    drift_ticks = 0;
                }
            } else {
                // Self-heal Windows WS_EX_TRANSPARENT if DWM / Wallpaper Engine / Show-Desktop drifted it
                #[cfg(windows)]
                {
                    let actual_opt = if is_win7_ulw {
                        win7_layered::is_click_through()
                    } else {
                        win_is_click_through(&win)
                    };
                    if let Some(actual_transparent) = actual_opt {
                        if actual_transparent != should_ignore {
                            drift_ticks = drift_ticks.saturating_add(1);
                            if drift_ticks >= 4 {
                                if is_win7_ulw {
                                    win7_layered::set_click_through(should_ignore);
                                } else {
                                    win_force_click_through(&win, should_ignore);
                                    let _ = win.set_ignore_cursor_events(should_ignore);
                                }
                                drift_ticks = 0;
                            }
                        } else {
                            drift_ticks = 0;
                        }
                    }
                }
            }

            let cursor_moved = (cx, cy) != last_cursor;
            if cursor_moved
                || alt_override != last_alt_override
                || effective_locked != last_effective_locked
            {
                last_cursor = (cx, cy);
                last_alt_override = alt_override;
                last_effective_locked = effective_locked;
                let _ = app.emit(
                    "kuro-cursor",
                    WindowCursorInfo {
                        rel_x: pet_rx,
                        rel_y: pet_ry,
                        inside_window: inside_pet,
                        over_cat,
                        alt_override,
                    },
                );
            }

            // Adaptive polling: responsive ~30Hz while hovering/moving/interacting,
            // relaxed ~12.5Hz when cursor is idle outside the pet window.
            next_sleep_ms = if cursor_moved || inside || is_menu || is_drag || is_banner || alt_override || is_file_drag {
                33
            } else {
                80
            };
        }
    });
}

#[cfg(windows)]
fn win_needs_win7_ulw() -> bool {
    use std::sync::OnceLock;
    static NEEDS_ULW: OnceLock<bool> = OnceLock::new();
    *NEEDS_ULW.get_or_init(|| {
        for var in ["KUROCAT_WIN7_ULW", "KUROCAT_WIN7_MASK"] {
            if let Ok(v) = std::env::var(var) {
                let t = v.trim();
                if t == "1" || t.eq_ignore_ascii_case("true") {
                    return true;
                }
                if t == "0" || t.eq_ignore_ascii_case("false") {
                    return false;
                }
            }
        }
        // Query real OS version via ntdll!RtlGetVersion (immune to compatibility manifest lies).
        // Windows 7 = 6.1, Windows 8 = 6.2, Windows 8.1 = 6.3, Windows 10/11 = 10.0+.
        #[repr(C)]
        struct RtlOsVersionInfoW {
            dw_os_version_info_size: u32,
            dw_major_version: u32,
            dw_minor_version: u32,
            dw_build_number: u32,
            dw_platform_id: u32,
            sz_csd_version: [u16; 128],
        }
        #[link(name = "ntdll")]
        extern "system" {
            fn RtlGetVersion(lpVersionInformation: *mut RtlOsVersionInfoW) -> i32;
        }
        unsafe {
            let mut info: RtlOsVersionInfoW = std::mem::zeroed();
            info.dw_os_version_info_size = std::mem::size_of::<RtlOsVersionInfoW>() as u32;
            if RtlGetVersion(&mut info) == 0 {
                return info.dw_major_version < 10;
            }
        }
        false
    })
}

/// Build a rounded GDI HRGN from `[left, top, right, bottom, corner_radius_px]` tuples
/// for on-demand DOM overlays (`#context-menu` and `#update-toast`) on Windows 7/8.
#[cfg(windows)]
fn build_rounded_overlay_hrgn(rects: &[i32]) -> windows_sys::Win32::Graphics::Gdi::HRGN {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRoundRectRgn, DeleteObject, HRGN, RGN_OR,
    };

    let mut final_rgn: HRGN = std::ptr::null_mut();
    for chunk in rects.chunks_exact(5) {
        let (l, t, r, b, radius) = (chunk[0], chunk[1], chunk[2], chunk[3], chunk[4]);
        if r <= l || b <= t {
            continue;
        }
        let w = r - l;
        let h = b - t;
        let diam = (radius.max(0) * 2).min(w).min(h);
        unsafe {
            let ov = CreateRoundRectRgn(l, t, r + 1, b + 1, diam, diam);
            if ov.is_null() {
                continue;
            }
            if final_rgn.is_null() {
                final_rgn = ov;
            } else {
                CombineRgn(final_rgn, final_rgn, ov, RGN_OR);
                DeleteObject(ov as _);
            }
        }
    }
    final_rgn
}

#[tauri::command]
fn is_win7_ulw_mode() -> bool {
    #[cfg(windows)]
    {
        return win_needs_win7_ulw();
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
fn win7_present_frame(request: tauri::ipc::Request<'_>) {
    #[cfg(windows)]
    {
        if !win_needs_win7_ulw() {
            return;
        }
        let w = request
            .headers()
            .get("x-w")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        let h = request
            .headers()
            .get("x-h")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        if w == 0 || h == 0 || w > 4096 || h > 4096 {
            return;
        }
        if let tauri::ipc::InvokeBody::Raw(bytes) = request.body() {
            win7_layered::submit_rgba_frame(w, h, bytes);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = request;
    }
}

#[tauri::command]
fn win7_sync_overlay(window: tauri::WebviewWindow, rects: Vec<i32>, focus_menu: bool) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Gdi::{DeleteObject, SetWindowRgn};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetForegroundWindow, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOSIZE,
            SWP_NOZORDER,
        };
        if !win_needs_win7_ulw() {
            return;
        }
        let Ok(raw_hwnd) = window.hwnd() else {
            return;
        };
        let main_hwnd = raw_hwnd.0 as windows_sys::Win32::Foundation::HWND;

        let rgn = build_rounded_overlay_hrgn(&rects);
        if rgn.is_null() {
            win7_layered::set_overlay_active(false);
            unsafe {
                let _ = SetWindowRgn(main_hwnd, std::ptr::null_mut(), 0);
                let _ = SetWindowPos(
                    main_hwnd,
                    std::ptr::null_mut(),
                    WIN7_OFFSCREEN_PARK_POS,
                    WIN7_OFFSCREEN_PARK_POS,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            return;
        }

        // Ensure WebView2 overlay HWND is opaque & clickable on Win7 (no WS_EX_LAYERED/TRANSPARENT)
        win_force_click_through(&window, false);
        let Some((ux, uy, _, _)) = win7_layered::get_rect() else {
            unsafe {
                DeleteObject(rgn as _);
            }
            return;
        };
        win7_layered::set_overlay_active(true);
        unsafe {
            if SetWindowRgn(main_hwnd, rgn, 1) == 0 {
                DeleteObject(rgn as _);
            }
            let flags = if focus_menu {
                SWP_NOSIZE
            } else {
                SWP_NOSIZE | SWP_NOACTIVATE
            };
            let _ = SetWindowPos(main_hwnd, HWND_TOPMOST, ux, uy, 0, 0, flags);
            if focus_menu {
                let _ = SetForegroundWindow(main_hwnd);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, rects, focus_menu);
    }
}

#[cfg(windows)]
fn win_configure_local_webview2_runtime() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };
    let mut found_local_rt = false;
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_none() {
        for candidate in ["WebView2Runtime", "WebView2"] {
            let rt = dir.join(candidate);
            if rt.join("msedgewebview2.exe").is_file() {
                std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &rt);
                found_local_rt = true;
                break;
            }
        }
    }
    // Isolate Fixed-Version WebView2 (v109 for Win7) user data folder so it never collides
    // with a newer system WebView2 (Chromium 13x/14x) profile when tested or co-installed.
    if (found_local_rt || cfg!(feature = "win7"))
        && std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none()
    {
        let udf = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .map(|base| base.join("KuroCat").join("EBWebView-Win7"))
            .unwrap_or_else(|| dir.join("WebView2Data"));
        let _ = std::fs::create_dir_all(&udf);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &udf);
    }
    if win_needs_win7_ulw() {
        // Dark surface matching `#context-menu` / `#update-toast` so rounded overlays blend cleanly.
        if std::env::var_os("WEBVIEW2_DEFAULT_BACKGROUND_COLOR").is_none() {
            std::env::set_var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF18191E");
        }
        // Keep offscreen-parked WebView2 rendering smoothly at 30-60 FPS without Chromium occlusion throttling!
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let mut merged = existing.trim().to_string();
        for flag in [
            "--autoplay-policy=no-user-gesture-required",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ] {
            if !merged.contains(flag) {
                if !merged.is_empty() {
                    merged.push(' ');
                }
                merged.push_str(flag);
            }
        }
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
    }
}

#[cfg(target_os = "linux")]
fn linux_configure_display_env() {
    // Prevent WebKitGTK 4.1 DMABUF blank/black transparent window issues on KylinOS/Mesa/NVIDIA/VMs
    // while keeping RGBA compositing transparency intact.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // Prefer X11/XWayland when DISPLAY is available so bottom-right window placement,
    // XShape click-through, and zero-root XRecord global input work reliably across desktop environments.
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("DISPLAY").map(|v| !v.is_empty()).unwrap_or(false)
        && std::env::var_os("GDK_BACKEND").is_none()
        && std::env::var_os("KUROCAT_WAYLAND").is_none()
    {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    {
        win_wait_for_previous_pid_if_requested();
        win_configure_local_webview2_runtime();
    }
    #[cfg(target_os = "linux")]
    {
        linux_configure_display_env();
    }

    let mut initial_settings = load_settings();
    // Always start unlocked so users who accidentally toggled click-through lock can never be permanently trapped across restarts/upgrades
    if initial_settings.click_through_locked {
        initial_settings.click_through_locked = false;
        save_settings(&initial_settings);
    }
    let settings_arc = Arc::new(Mutex::new(initial_settings.clone()));
    let menu_open = Arc::new(AtomicBool::new(false));
    let dragging = Arc::new(AtomicBool::new(false));
    let mcp_enabled = Arc::new(AtomicBool::new(initial_settings.mcp_enabled));
    let update_banner_open = Arc::new(AtomicBool::new(false));
    let paused_guard = Arc::new(AtomicBool::new(false));
    let file_drag_active = Arc::new(AtomicBool::new(false));
    let file_drag_for_setup = file_drag_active.clone();

    let settings_for_setup = settings_arc.clone();
    let menu_for_setup = menu_open.clone();
    let drag_for_setup = dragging.clone();
    let mcp_for_setup = mcp_enabled.clone();
    let banner_for_setup = update_banner_open.clone();
    let paused_for_setup = paused_guard.clone();

    tauri::Builder::default()
        .manage(AppState {
            settings: settings_arc,
            menu_open,
            dragging,
            mcp_enabled,
            update_banner_open,
            paused_guard,
            file_drag_active,
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let s = settings_for_setup.lock().unwrap().clone();

            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            if let Some(win) = app.get_webview_window("main") {
                let (win_w, win_h) = window_dimensions(&s.keyboard_layout, s.scale);
                let _ = win.set_size(Size::Logical(LogicalSize::new(win_w, win_h)));
                let sz = win.outer_size().unwrap_or(tauri::PhysicalSize::new(420, 440));
                let sf = win.scale_factor().unwrap_or(1.0);
                let (target_x, target_y) = if let (Some(x), Some(y)) = (s.x, s.y) {
                    (x, y)
                } else {
                    default_bottom_right_position(sz.width as i32, sz.height as i32, sf)
                };

                #[cfg(windows)]
                if win_needs_win7_ulw() {
                    // On Windows 7/8: spawn our dedicated Win32 UpdateLayeredWindow (ULW_ALPHA)
                    // 256-level anti-aliased presenter window at (target_x, target_y), and park the
                    // WebView2 offscreen renderer at (-16000, -16000) so there is ZERO white box!
                    win_force_click_through(&win, false);
                    let _ = win.set_always_on_top(s.always_on_top);
                    let _ = win.set_position(PhysicalPosition::new(
                        WIN7_OFFSCREEN_PARK_POS,
                        WIN7_OFFSCREEN_PARK_POS,
                    ));
                    win7_layered::init(
                        handle.clone(),
                        target_x,
                        target_y,
                        sz.width,
                        sz.height,
                        s.always_on_top,
                    );
                } else {
                    let _ = win.set_always_on_top(s.always_on_top);
                    let _ = win.set_position(PhysicalPosition::new(target_x, target_y));
                }

                #[cfg(not(windows))]
                {
                    let _ = win.set_always_on_top(s.always_on_top);
                    #[cfg(target_os = "macos")]
                    {
                        let _ = win.set_visible_on_all_workspaces(true);
                        configure_macos_fullscreen_overlay(&win, s.always_on_top);
                    }
                    #[cfg(target_os = "linux")]
                    {
                        let _ = win.set_visible_on_all_workspaces(true);
                        let _ = win.set_skip_taskbar(true);
                    }
                    let _ = win.set_position(PhysicalPosition::new(target_x, target_y));
                }
            }

            tray::setup_tray(&handle, &s)?;
            input_hook::start_global_hooks(handle.clone());
            media::start_media_watcher(handle.clone());
            privacy::start_password_privacy_watcher(
                handle.clone(),
                settings_for_setup.clone(),
                paused_for_setup.clone(),
            );
            file_drag::start_file_drag_watcher(
                handle.clone(),
                file_drag_for_setup.clone(),
                settings_for_setup.clone(),
            );
            start_hit_test_loop(
                handle.clone(),
                settings_for_setup,
                menu_for_setup,
                drag_for_setup,
                banner_for_setup,
                paused_for_setup,
                file_drag_for_setup,
            );
            start_storage_watcher(handle.clone());
            updater::start_background_update_checker(handle.clone());

            let http_handle = handle.clone();
            let mcp_port = if s.mcp_port == 0 { 27420 } else { s.mcp_port };
            mcp::start_http_mcp_server(mcp_port, mcp_for_setup, move || {
                reload_and_emit_all(&http_handle);
            });

            if std::env::args().any(|a| a == "--demo") {
                let demo_handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1200));
                    let keys: &[u32] = &[0x46, 0x53, 0x41, 0x45, 0x20, 0xA0, 0x4B];
                    for &vk in keys {
                        let _ = demo_handle.emit(
                            "kuro-input",
                            serde_json::json!({ "kind": "keyDown", "vk": vk, "scan": 0, "repeat": false }),
                        );
                        std::thread::sleep(Duration::from_millis(100));
                        let _ = demo_handle.emit(
                            "kuro-input",
                            serde_json::json!({ "kind": "keyUp", "vk": vk, "scan": 0 }),
                        );
                    }
                    let _ = demo_handle.emit(
                        "kuro-input",
                        serde_json::json!({ "kind": "mouseMove", "x": 400, "y": 400, "nx": 0.25, "ny": 0.4 }),
                    );
                    let _ = demo_handle.emit(
                        "kuro-input",
                        serde_json::json!({ "kind": "mouseDown", "button": "left" }),
                    );
                    let _ = demo_handle.emit(
                        "kuro-input",
                        serde_json::json!({ "kind": "keyDown", "vk": 0x4B, "scan": 0, "repeat": false }),
                    );
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            get_cats,
            get_mcp_config,
            get_app_version,
            update_settings,
            set_menu_open,
            set_dragging,
            set_update_banner_open,
            set_file_drop_active,
            file_drag::trash_files,
            is_win7_ulw_mode,
            win7_present_frame,
            win7_sync_overlay,
            save_window_pos,
            reset_position,
            create_desktop_shortcut,
            check_for_update,
            install_update,
            open_release_page,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running KuroCat");
}

#[cfg(all(test, windows))]
mod windows_zorder_tests {
    use super::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    #[test]
    fn detects_and_recovers_topmost_zorder_without_stealing_focus() {
        let class_name: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "KuroCatZOrderTest\0".encode_utf16().collect();
        unsafe {
            let hinst = GetModuleHandleW(std::ptr::null());
            let ex = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            let model = CreateWindowExW(
                ex,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                100,
                100,
                200,
                200,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hinst,
                std::ptr::null(),
            );
            let fg = CreateWindowExW(
                ex,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                120,
                120,
                200,
                200,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hinst,
                std::ptr::null(),
            );
            assert!(!model.is_null() && !fg.is_null());
            assert!(win_is_topmost(model));
            assert!(win_is_topmost(fg));

            // Place simulated foreground topmost window above model
            SetWindowPos(
                fg,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            assert!(
                win_window_is_above(fg, model),
                "expected fg topmost window to be detected above model"
            );

            // Reassert model to HWND_TOPMOST (same call as win_gentle_reassert_topmost)
            SetWindowPos(
                model,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            assert!(
                !win_window_is_above(fg, model),
                "expected model to sit above fg after HWND_TOPMOST reassert"
            );

            // Move fg away so rectangles no longer overlap (e.g. another monitor)
            SetWindowPos(fg, HWND_TOPMOST, 2000, 2000, 200, 200, SWP_NOACTIVATE);
            assert!(
                !win_window_is_above(fg, model),
                "non-overlapping fg window should never trigger topmost reorder"
            );

            let _ = DestroyWindow(fg);
            let _ = DestroyWindow(model);
        }

        // Verify elevation query runs safely without panicking
        let _ = win_is_elevated();
    }

    #[test]
    fn win7_rounded_overlay_region_clips_menu_and_toast_cleanly() {
        use windows_sys::Win32::Graphics::Gdi::{DeleteObject, PtInRegion};
        // Context menu card (radius 12) + update toast pill (radius 20)
        let rects = vec![
            10, 10, 224, 310, 12,
            60, 8, 340, 42, 20,
        ];
        unsafe {
            let rgn = build_rounded_overlay_hrgn(&rects);
            assert!(!rgn.is_null(), "CreateRoundRectRgn + CombineRgn should produce valid HRGN");
            assert_ne!(PtInRegion(rgn, 100, 150), 0, "inside context menu");
            assert_ne!(PtInRegion(rgn, 200, 24), 0, "inside update toast");
            assert_eq!(PtInRegion(rgn, 10, 10), 0, "sharp 12px corner tip should be rounded off");
            assert_eq!(PtInRegion(rgn, 350, 200), 0, "empty area outside overlays must be clipped away");
            DeleteObject(rgn as _);
        }
    }
}

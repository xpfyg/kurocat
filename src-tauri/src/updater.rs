use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

// 只依赖 GitHub releases/latest 的 HTTP 重定向，完全不碰 REST API，
// 这样不会被匿名 API 配额（每 IP 每小时 60 次）限流。
const REPO_LATEST_PAGE: &str = "https://github.com/xpfyg/minicat/releases/latest";
const REPO_LATEST_DOWNLOAD: &str = "https://github.com/xpfyg/minicat/releases/latest/download";
const REPO_RELEASES_PAGE: &str = "https://github.com/xpfyg/minicat/releases";

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 两次自动检查之间的最小间隔：24 小时。手动触发（托盘"检查更新"）不受此限制。
const AUTO_CHECK_COOLDOWN_SECS: u64 = 24 * 3600;

/// 自动检查成功/失败后，在下一次应用启动时仍要给的最短退避：4 小时。
/// （配合 24h 主要冷却，避免网络抖动时反复打 GitHub。）
const AUTO_CHECK_MIN_BACKOFF_SECS: u64 = 4 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_url: String,
    pub asset_name: Option<String>,
    pub download_url: Option<String>,
    pub asset_sha256: Option<String>,
    pub asset_size: Option<u64>,
    pub install_kind: String,
    pub notes_summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub stage: String,
    pub message: String,
    pub info: Option<UpdateInfo>,
}

// ---------------------------------------------------------------------------
// 版本号比较（保持原有语义与单测）
// ---------------------------------------------------------------------------

pub fn parse_semver(raw: &str) -> (u64, u64, u64) {
    let clean = raw.trim().trim_start_matches(['v', 'V']);
    let main = clean.split('-').next().unwrap_or(clean);
    let mut parts = main.split('.');
    let major = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    (major, minor, patch)
}

pub fn is_newer_version(latest: &str, current: &str) -> bool {
    parse_semver(latest) > parse_semver(current)
}

fn current_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 安装类型探测 + 资产命名约定 → 下载 URL
// ---------------------------------------------------------------------------

fn is_msix_exe_path(exe: &std::path::Path) -> bool {
    let lower = exe.to_string_lossy().to_ascii_lowercase();
    if lower.contains("\\windowsapps\\") || lower.contains("/windowsapps/") {
        return true;
    }
    exe.parent()
        .map(|dir| dir.join("AppxManifest.xml").exists())
        .unwrap_or(false)
}

pub fn is_msix_store_package() -> bool {
    #[cfg(windows)]
    {
        if let Ok(exe) = std::env::current_exe() {
            return is_msix_exe_path(&exe);
        }
    }
    false
}

fn detect_install_kind() -> &'static str {
    #[cfg(all(windows, feature = "win7"))]
    {
        return "windows-win7";
    }
    #[cfg(all(windows, not(feature = "win7")))]
    {
        if let Ok(exe) = std::env::current_exe() {
            if is_msix_exe_path(&exe) {
                return "windows-msix";
            }
            if let Some(dir) = exe.parent() {
                if dir.join("uninstall.exe").exists() {
                    return "windows-nsis";
                }
            }
        }
        return "windows-portable";
    }
    #[cfg(target_os = "macos")]
    {
        return "macos-app";
    }
    #[cfg(target_os = "linux")]
    {
        if cfg!(target_arch = "aarch64") {
            return "linux-deb-arm64";
        }
        return "linux-deb-amd64";
    }
    #[cfg(all(not(windows), not(target_os = "macos"), not(target_os = "linux")))]
    {
        return "manual";
    }
}

/// 返回 (asset_filename, download_url)。
/// 这里只按命名约定构造，不依赖 GitHub API 的 assets 数组。
fn pick_asset_by_convention(latest_tag: &str, install_kind: &str) -> Option<(String, String)> {
    let ver_clean = latest_tag.trim_start_matches(['v', 'V']).to_string();
    let tag = latest_tag.trim().to_string();
    let url = |name: &str| format!("{}/{}", REPO_LATEST_DOWNLOAD, name);

    let want_108 = cfg!(feature = "layout-108");
    let _ = want_108; // 目前 Release 里没有 108key 变体，保留占位

    match install_kind {
        "windows-nsis" | "windows-portable" => {
            let name = format!("MiniCat-{}-x64-setup.exe", ver_clean);
            Some((name.clone(), url(&name)))
        }
        "windows-win7" => {
            let name = format!("MiniCat-{}-win7.zip", ver_clean);
            Some((name.clone(), url(&name)))
        }
        "macos-app" => {
            // universal .app.tar.gz 优先（自更新走 tar.gz 解压，dmg 留给用户手动）
            let name = format!("MiniCat-{}-macos-universal.app.tar.gz", tag);
            Some((name.clone(), url(&name)))
        }
        "linux-deb-arm64" => {
            let name = format!("MiniCat-{}-linux-arm64.deb", tag);
            Some((name.clone(), url(&name)))
        }
        "linux-deb-amd64" => {
            let name = format!("MiniCat-{}-linux-amd64.deb", tag);
            Some((name.clone(), url(&name)))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// fetch_latest_tag_name：跟随 releases/latest 的重定向，从最终 URL 里抠出 tag
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn fetch_latest_tag_name() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // 用 Invoke-WebRequest 跟随最多 10 次重定向，然后从最终 ResponseUri 里取 tag。
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; \
         try {{ \
           $resp = Invoke-WebRequest -UseBasicParsing -MaximumRedirection 10 \
             -Uri '{url}' -Headers @{{'User-Agent'='MiniCat/{ver}'}} -TimeoutSec 15; \
           $uri = $resp.BaseResponse.ResponseUri.AbsoluteUri; \
         }} catch {{ \
           if ($_.Exception.Response) {{ \
             $uri = $_.Exception.Response.ResponseUri.AbsoluteUri; \
           }} else {{ \
             throw \
           }} \
         }} \
         if ($uri -match '/releases/tag/([vV]?[0-9][0-9.]+)') {{ \
           $matches[1]; \
         }} elseif ($uri -match '/tag/([vV]?[0-9][0-9.]+)') {{ \
           $matches[1]; \
         }} else {{ \
           throw \"无法从重定向地址解析版本号: $uri\" \
         }}",
        url = REPO_LATEST_PAGE,
        ver = CURRENT_VERSION
    );

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("无法启动网络检测: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "连接 GitHub 检查更新失败，请检查网络或代理".to_string()
        } else {
            format!("检查更新失败: {}", stderr.lines().next().unwrap_or(&stderr))
        });
    }

    let tag = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if tag.is_empty() {
        return Err("GitHub 返回空响应".to_string());
    }
    Ok(tag)
}

#[cfg(not(windows))]
fn fetch_latest_tag_name() -> Result<String, String> {
    use std::process::Command;

    let curl_bin = if cfg!(target_os = "macos") {
        "/usr/bin/curl"
    } else {
        "curl"
    };

    // -L 跟随重定向；只用 -o /dev/null 丢弃响应体，拿 -w 格式化的最终 URL。
    let output = Command::new(curl_bin)
        .args([
            "-sSL",
            "--connect-timeout",
            "10",
            "--max-time",
            "20",
            "-H",
            &format!("User-Agent: MiniCat/{}", CURRENT_VERSION),
            "-o",
            "/dev/null",
            "-w",
            "%{url_effective}",
            REPO_LATEST_PAGE,
        ])
        .output()
        .map_err(|e| format!("无法调用 curl 检查更新: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "连接 GitHub 检查更新失败，请检查网络或代理".to_string()
        } else {
            format!("检查更新失败: {}", stderr)
        });
    }

    let final_url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    extract_tag_from_release_url(&final_url)
}

fn extract_tag_from_release_url(url: &str) -> Result<String, String> {
    // https://github.com/xpfyg/minicat/releases/tag/v4.8.3  → v4.8.3
    let lowered = url.trim().to_ascii_lowercase();
    let candidates = ["/releases/tag/", "/tag/"];
    for needle in &candidates {
        if let Some(idx) = lowered.find(needle) {
            let start = idx + needle.len();
            let tail = &url[start..];
            let end = tail
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == 'v' || c == 'V'))
                .unwrap_or(tail.len());
            let tag = tail[..end].to_string();
            if !tag.is_empty() {
                return Ok(tag);
            }
        }
    }
    Err(format!("无法从 GitHub 重定向地址解析版本号: {}", url))
}

// ---------------------------------------------------------------------------
// 对外检查入口
// ---------------------------------------------------------------------------

pub fn check_latest_update() -> Result<UpdateInfo, String> {
    if is_msix_store_package() {
        return Ok(UpdateInfo {
            current_version: CURRENT_VERSION.to_string(),
            latest_version: CURRENT_VERSION.to_string(),
            has_update: false,
            release_url: REPO_RELEASES_PAGE.to_string(),
            asset_name: None,
            download_url: None,
            asset_sha256: None,
            asset_size: None,
            install_kind: "windows-msix".to_string(),
            notes_summary: "当前为 Microsoft Store 版本，应用更新由 Microsoft Store 自动管理。".to_string(),
        });
    }

    let latest_tag = fetch_latest_tag_name()?;
    let latest_clean = latest_tag.trim_start_matches(['v', 'V']).to_string();
    let has_update = is_newer_version(&latest_clean, CURRENT_VERSION);
    let install_kind = detect_install_kind();
    let (asset_name, download_url) = pick_asset_by_convention(&latest_tag, install_kind)
        .unwrap_or_else(|| (String::new(), REPO_RELEASES_PAGE.to_string()));

    Ok(UpdateInfo {
        current_version: CURRENT_VERSION.to_string(),
        latest_version: latest_clean,
        has_update,
        release_url: format!(
            "https://github.com/xpfyg/minicat/releases/tag/{}",
            latest_tag
        ),
        asset_name: if asset_name.is_empty() { None } else { Some(asset_name) },
        download_url: if download_url == REPO_RELEASES_PAGE {
            None
        } else {
            Some(download_url)
        },
        asset_sha256: None, // 不走 GitHub API 就拿不到 digest；手动安装路径不受影响
        asset_size: None,
        install_kind: install_kind.to_string(),
        notes_summary: String::new(), // 同上
    })
}

// ---------------------------------------------------------------------------
// 后台自动检查（带冷却，每日至多一次）
// ---------------------------------------------------------------------------

fn cooldown_marker_path() -> PathBuf {
    std::env::temp_dir().join("minicat-last-auto-update-check")
}

fn read_last_check_unix() -> Option<u64> {
    let data = std::fs::read_to_string(cooldown_marker_path()).ok()?;
    data.trim().parse::<u64>().ok()
}

fn write_last_check_now() {
    let _ = std::fs::write(
        cooldown_marker_path(),
        current_unix_secs().to_string().as_bytes(),
    );
}

/// 距离上一次自动检查是否已经超过冷却时长。
/// 没有记录时返回 true（允许立即检查一次）。
fn auto_check_due() -> bool {
    match read_last_check_unix() {
        None => true,
        Some(last) => current_unix_secs().saturating_sub(last) >= AUTO_CHECK_MIN_BACKOFF_SECS,
    }
}

pub fn start_background_update_checker(app: AppHandle) {
    if is_msix_store_package() {
        return;
    }
    std::thread::spawn(move || {
        // 启动时静默，先等桌面完全绘制好。
        std::thread::sleep(std::time::Duration::from_secs(8));

        // 冷却未到就直接跳过，不打扰用户；手动托盘检查不受这个约束。
        if !auto_check_due() {
            return;
        }

        write_last_check_now();

        // 用宽松重试：一次失败再等 4h 自动退避（下次启动再试）。
        let _ = check_latest_update().map(|info| {
            if info.has_update {
                emit_progress(
                    &app,
                    "available",
                    format!("发现新版本 v{}", info.latest_version),
                    Some(info),
                );
            }
        });

        // 检查完就结束线程，不再常驻轮询。下次启动自动按冷却判断。
    });
}

// ---------------------------------------------------------------------------
// 进度通知 / 浏览器
// ---------------------------------------------------------------------------

fn emit_progress(app: &AppHandle, stage: &str, message: impl Into<String>, info: Option<UpdateInfo>) {
    let _ = app.emit(
        "mini-update-status",
        UpdateProgressEvent {
            stage: stage.to_string(),
            message: message.into(),
            info,
        },
    );
}

pub fn open_url_in_browser(url: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd.exe")
            .args(["/C", "start", "", url])
            .creation_flags(0x08000000)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

// ---------------------------------------------------------------------------
// 安装路径（保持不变：下载 + 校验 + 替换 + 重启）
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn download_and_verify_windows(url: &str, dest: &PathBuf, expected_sha256: Option<&str>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let url_esc = url.replace('\'', "''");
    let dst_esc = dest.to_string_lossy().replace('\'', "''");
    let sha_esc = expected_sha256.unwrap_or("").replace('\'', "''");

    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; \
         $ProgressPreference = 'SilentlyContinue'; \
         $dst = '{dst}'; \
         Invoke-WebRequest -UseBasicParsing -Uri '{url}' -Headers @{{'User-Agent'='MiniCat/{ver}'}} -OutFile $dst -TimeoutSec 180; \
         if (-not (Test-Path $dst) -or (Get-Item $dst).Length -lt 500000) {{ throw '下载文件不完整' }}; \
         $exp = '{sha}'; \
         if ($exp -ne '') {{ \
           $actual = (Get-FileHash -Path $dst -Algorithm SHA256).Hash.ToLowerInvariant(); \
           if ($actual -ne $exp.ToLowerInvariant()) {{ Remove-Item $dst -Force -ErrorAction SilentlyContinue; throw \"SHA-256 校验失败: $actual\" }} \
         }}",
        dst = dst_esc,
        url = url_esc,
        ver = CURRENT_VERSION,
        sha = sha_esc,
    );

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("启动下载失败: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "下载安装包失败".to_string()
        } else {
            err.lines().next().unwrap_or(&err).to_string()
        });
    }
    Ok(())
}

#[cfg(windows)]
fn install_windows_update(app: &AppHandle, info: &UpdateInfo) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    if info.install_kind == "windows-win7"
        || info
            .asset_name
            .as_deref()
            .map(|n| n.to_ascii_lowercase().ends_with(".zip"))
            .unwrap_or(false)
    {
        let target_url = info.download_url.as_deref().unwrap_or(&info.release_url);
        open_url_in_browser(target_url);
        emit_progress(
            app,
            "up_to_date",
            format!("已在浏览器打开 v{} Win7 兼容整合包下载页", info.latest_version),
            Some(info.clone()),
        );
        return Ok(());
    }

    let url = info
        .download_url
        .as_deref()
        .ok_or_else(|| "未找到匹配的 Windows 更新包".to_string())?;
    let asset_name = info
        .asset_name
        .as_deref()
        .unwrap_or("MiniCat-update.exe");

    emit_progress(
        app,
        "downloading",
        format!("正在下载 v{}...", info.latest_version),
        Some(info.clone()),
    );

    let temp_dir = std::env::temp_dir().join("minicat-updates");
    let _ = std::fs::create_dir_all(&temp_dir);
    let safe_name = asset_name.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let target_file = temp_dir.join(safe_name);

    download_and_verify_windows(url, &target_file, info.asset_sha256.as_deref())?;

    emit_progress(
        app,
        "installing",
        format!("校验通过，正在安装 v{} 并重启...", info.latest_version),
        Some(info.clone()),
    );

    let is_setup_installer = asset_name.to_ascii_lowercase().ends_with("-setup.exe");

    if is_setup_installer {
        // Launch Tauri NSIS installer in passive auto-relaunch update mode (/P /R /UPDATE)
        Command::new(&target_file)
            .args(["/P", "/R", "/UPDATE"])
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    } else {
        // Portable single .exe atomic swap + relaunch after this process exits
        let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let pid = std::process::id();
        let src_esc = target_file.to_string_lossy().replace('\'', "''");
        let dst_esc = current_exe.to_string_lossy().replace('\'', "''");
        let swap_script = format!(
            "for ($i = 0; $i -lt 40; $i++) {{ \
               if (-not (Get-Process -Id {pid} -ErrorAction SilentlyContinue)) {{ break }} \
               Start-Sleep -Milliseconds 200 \
             }}; \
             Start-Sleep -Milliseconds 250; \
             Copy-Item -LiteralPath '{src}' -Destination '{dst}' -Force; \
             Remove-Item -LiteralPath '{src}' -Force -ErrorAction SilentlyContinue; \
             Start-Process -FilePath '{dst}'",
            pid = pid,
            src = src_esc,
            dst = dst_esc,
        );

        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &swap_script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("启动替换脚本失败: {}", e))?;
    }

    let app_clone = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(450));
        app_clone.exit(0);
    });

    Ok(())
}

#[cfg(target_os = "macos")]
fn find_current_macos_app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for ancestor in exe.ancestors() {
        if ancestor.extension().and_then(|s| s.to_str()) == Some("app") {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn install_macos_update(app: &AppHandle, info: &UpdateInfo) -> Result<(), String> {
    use std::process::Command;

    let url = info
        .download_url
        .as_deref()
        .ok_or_else(|| "未找到匹配的 macOS 更新包".to_string())?;
    let asset_name = info
        .asset_name
        .as_deref()
        .unwrap_or("MiniCat-macos-universal.app.tar.gz");

    if !asset_name.to_ascii_lowercase().ends_with(".tar.gz") {
        open_url_in_browser(url);
        return Ok(());
    }

    let app_bundle = find_current_macos_app_bundle()
        .unwrap_or_else(|| PathBuf::from("/Applications/MiniCat.app"));

    emit_progress(
        app,
        "downloading",
        format!("正在下载 macOS v{}...", info.latest_version),
        Some(info.clone()),
    );

    let temp_dir = std::env::temp_dir().join(format!("minicat-update-{}", info.latest_version));
    let _ = std::fs::remove_dir_all(&temp_dir);
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let archive_path = temp_dir.join("MiniCat-update.app.tar.gz");

    let dl = Command::new("/usr/bin/curl")
        .args([
            "-fsSL",
            "--connect-timeout",
            "15",
            "--max-time",
            "240",
            "-H",
            &format!("User-Agent: MiniCat/{}", CURRENT_VERSION),
            "-o",
            archive_path.to_str().unwrap_or("/tmp/MiniCat-update.app.tar.gz"),
            url,
        ])
        .output()
        .map_err(|e| format!("下载失败: {}", e))?;

    if !dl.status.success() {
        return Err("下载 macOS 更新包失败".to_string());
    }

    // SHA-256 可选：没有就跳过，有就强校验
    if let Some(expected_sha) = info.asset_sha256.as_deref() {
        emit_progress(
            app,
            "verifying",
            "正在校验安装包完整性...",
            Some(info.clone()),
        );
        let shasum = Command::new("/usr/bin/shasum")
            .args(["-a", "256", archive_path.to_str().unwrap_or("")])
            .output()
            .map_err(|e| format!("校验失败: {}", e))?;
        let out_str = String::from_utf8_lossy(&shasum.stdout);
        let actual = out_str.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        if actual != expected_sha.to_ascii_lowercase() {
            return Err("安装包 SHA-256 校验未通过".to_string());
        }
    }

    let extract_dir = temp_dir.join("extracted");
    std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
    let untar = Command::new("/usr/bin/tar")
        .args([
            "-xzf",
            archive_path.to_str().unwrap_or(""),
            "-C",
            extract_dir.to_str().unwrap_or(""),
        ])
        .output()
        .map_err(|e| format!("解压失败: {}", e))?;
    if !untar.status.success() {
        return Err("解压更新包失败".to_string());
    }

    let new_app = std::fs::read_dir(&extract_dir)
        .ok()
        .and_then(|mut it| {
            it.find_map(|entry| {
                let p = entry.ok()?.path();
                if p.extension().and_then(|s| s.to_str()) == Some("app") {
                    Some(p)
                } else {
                    None
                }
            })
        })
        .ok_or_else(|| "更新包内未找到 .app 程序".to_string())?;

    let _ = Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine", new_app.to_str().unwrap_or("")])
        .status();

    emit_progress(
        app,
        "installing",
        format!("正在安装 v{} 并重启...", info.latest_version),
        Some(info.clone()),
    );

    let pid = std::process::id();
    let dst_str = app_bundle.to_string_lossy().replace('\'', "'\\''");
    let src_str = new_app.to_string_lossy().replace('\'', "'\\''");
    let tmp_str = temp_dir.to_string_lossy().replace('\'', "'\\''");
    let swap_sh = format!(
        "for i in $(seq 1 40); do kill -0 {pid} 2>/dev/null || break; sleep 0.2; done; \
         sleep 0.25; \
         rm -rf '{dst}.bak'; \
         if [ -d '{dst}' ]; then mv '{dst}' '{dst}.bak'; fi; \
         if mv '{src}' '{dst}'; then \
           rm -rf '{dst}.bak' '{tmp}'; \
           /usr/bin/xattr -dr com.apple.quarantine '{dst}' 2>/dev/null || true; \
           /usr/bin/open -n '{dst}'; \
         else \
           if [ -d '{dst}.bak' ]; then mv '{dst}.bak' '{dst}'; fi; \
           /usr/bin/open '{url}'; \
         fi",
        pid = pid,
        dst = dst_str,
        src = src_str,
        tmp = tmp_str,
        url = info.release_url.replace('\'', "'\\''"),
    );

    Command::new("/bin/sh")
        .args(["-c", &swap_sh])
        .spawn()
        .map_err(|e| format!("启动更新脚本失败: {}", e))?;

    let app_clone = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(450));
        app_clone.exit(0);
    });

    Ok(())
}

pub fn perform_update_install(app: &AppHandle, info: UpdateInfo) -> Result<(), String> {
    if is_msix_store_package() || info.install_kind == "windows-msix" {
        emit_progress(
            app,
            "up_to_date",
            "当前为 Microsoft Store 版本，请通过 Microsoft Store 获取更新",
            Some(info),
        );
        return Ok(());
    }

    if !info.has_update {
        emit_progress(
            app,
            "up_to_date",
            format!("已是最新版本 v{}", info.current_version),
            Some(info),
        );
        return Ok(());
    }

    #[cfg(windows)]
    {
        return install_windows_update(app, &info);
    }

    #[cfg(target_os = "macos")]
    {
        return install_macos_update(app, &info);
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let target_url = info.download_url.as_deref().unwrap_or(&info.release_url);
        open_url_in_browser(target_url);
        emit_progress(
            app,
            "up_to_date",
            format!("已在浏览器打开 v{} 安装包下载页", info.latest_version),
            Some(info),
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 单测
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_comparison_works() {
        assert!(is_newer_version("4.4.0", "4.3.0"));
        assert!(is_newer_version("v4.10.0", "4.4.0"));
        assert!(is_newer_version("5.0.0", "4.9.9"));
        assert!(!is_newer_version("4.4.0", "4.4.0"));
        assert!(!is_newer_version("v4.3.9", "4.4.0"));
    }

    #[test]
    fn extract_tag_from_github_release_urls() {
        let ok_cases = [
            ("https://github.com/xpfyg/minicat/releases/tag/v4.8.3", "v4.8.3"),
            ("https://github.com/xpfyg/minicat/releases/tag/V4.8.3#assets", "V4.8.3"),
            ("https://github.com/xpfyg/minicat/releases/tag/4.8.3", "4.8.3"),
            ("https://github.com/xpfyg/minicat/tag/v4.0.0-rc1", "v4.0.0-rc1"),
        ];
        for (url, expected) in ok_cases {
            assert_eq!(
                extract_tag_from_release_url(url).unwrap_or_default(),
                expected,
                "url={}",
                url
            );
        }
        let bad = [
            "https://github.com/xpfyg/minicat/releases/latest",
            "https://example.com/",
            "",
        ];
        for url in bad {
            assert!(extract_tag_from_release_url(url).is_err(), "url={}", url);
        }
    }

    #[test]
    fn asset_convention_matches_known_platforms() {
        let win = pick_asset_by_convention("v5.0.0", "windows-nsis").unwrap();
        assert_eq!(win.0, "MiniCat-5.0.0-x64-setup.exe");
        assert!(win.1.contains("releases/latest/download"));

        let mac = pick_asset_by_convention("v5.0.0", "macos-app").unwrap();
        assert_eq!(mac.0, "MiniCat-v5.0.0-macos-universal.app.tar.gz");

        let win7 = pick_asset_by_convention("v5.0.0", "windows-win7").unwrap();
        assert_eq!(win7.0, "MiniCat-5.0.0-win7.zip");

        let none = pick_asset_by_convention("v5.0.0", "unknown-kind");
        assert!(none.is_none());

        assert!(is_msix_exe_path(std::path::Path::new(
            r"C:\Program Files\WindowsApps\9FBD0BA0.minicat_5.0.0.0_x64__abc\MiniCat.exe"
        )));
        assert!(!is_msix_exe_path(std::path::Path::new(
            r"C:\Users\alice\AppData\Local\MiniCat\MiniCat.exe"
        )));
    }
}

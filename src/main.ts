import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { KuroCatEngine, type KeyboardOrientation } from './catEngine';
import { catAudio } from './audio';
import { DEFAULT_BUILTIN_CATS, type CatSkinConfig } from './catSkins';
import type { KeyboardLayoutId } from './keyboardLayout';
import { DESK_THEMES } from './deskThemes';

interface AppSettings {
  x: number | null;
  y: number | null;
  scale: number;
  alwaysOnTop: boolean;
  clickThroughLocked: boolean;
  showKeyBubbles: boolean;
  soundEnabled: boolean;
  autostart: boolean;
  catBreed: string;
  mcpEnabled: boolean;
  mcpPort: number;
  keyboardLayout: KeyboardLayoutId;
  keyboardOrientation: KeyboardOrientation;
  privacyPasswordGuard: boolean;
  deskTheme: string;
  flyingToys: boolean;
  trashHelper: boolean;
}

interface FileDragInfo {
  active: boolean;
  count: number;
  side: string;
}

type InputEvent =
  | { kind: 'keyDown'; vk: number; scan: number; repeat: boolean }
  | { kind: 'keyUp'; vk: number; scan: number }
  | { kind: 'mouseDown'; button: string }
  | { kind: 'mouseUp'; button: string }
  | { kind: 'mouseWheel'; delta: number }
  | { kind: 'mouseMove'; x: number; y: number; nx: number; ny: number }
  | { kind: 'privacyTyping' };

interface WindowCursorInfo {
  relX: number;
  relY: number;
  insideWindow: boolean;
  overCat: boolean;
  altOverride?: boolean;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  assetName: string | null;
  downloadUrl: string | null;
  assetSha256: string | null;
  assetSize: number | null;
  installKind: string;
  notesSummary: string;
}

interface UpdateProgressEvent {
  stage: string;
  message: string;
  info: UpdateInfo | null;
}

let appVersion = '5.0.0';
let latestUpdateInfo: UpdateInfo | null = null;
let updateBusy = false;
let dismissedVersion: string | null = null;
let toastAutoHideTimer: number | null = null;
let sliderDragging = false;
let altOverride = false;
let lastKnownLockState: boolean | null = null;
let syncWin7OverlayFn: ((focusMenu?: boolean) => void) | null = null;

let settings: AppSettings = {
  x: null,
  y: null,
  scale: 1,
  alwaysOnTop: true,
  clickThroughLocked: false,
  showKeyBubbles: true,
  soundEnabled: true,
  autostart: false,
  catBreed: 'black',
  mcpEnabled: true,
  mcpPort: 27420,
  keyboardLayout: '65',
  keyboardOrientation: 'cat',
  privacyPasswordGuard: true,
  deskTheme: 'classic',
  flyingToys: true,
  trashHelper: true,
};

let catList: CatSkinConfig[] = [...DEFAULT_BUILTIN_CATS];

const canvas = document.getElementById('pet-canvas') as HTMLCanvasElement;
const menuEl = document.getElementById('context-menu') as HTMLDivElement;
const breedPillsEl = document.getElementById('breed-pills') as HTMLDivElement;
const themePillsEl = document.getElementById('theme-pills') as HTMLDivElement | null;
const scaleSliderEl = document.getElementById('scale-slider') as HTMLInputElement;
const scaleValueEl = document.getElementById('scale-value') as HTMLButtonElement;
const updateToastEl = document.getElementById('update-toast') as HTMLDivElement;
const updateToastTextEl = document.getElementById('update-toast-text') as HTMLSpanElement;
const btnToastInstallEl = document.getElementById('btn-toast-install') as HTMLButtonElement;
const btnToastOpenEl = document.getElementById('btn-toast-open') as HTMLButtonElement;
const btnToastCloseEl = document.getElementById('btn-toast-close') as HTMLButtonElement;
const engine = new KuroCatEngine(canvas);

function renderBreedPills(): void {
  if (!breedPillsEl) return;
  breedPillsEl.innerHTML = '';
  for (const cat of catList) {
    const btn = document.createElement('button');
    btn.className = 'breed-pill';
    btn.dataset.breed = cat.id;
    const emoji = cat.emoji ? `${cat.emoji} ` : '🐱 ';
    btn.textContent = `${emoji}${cat.name}`;
    const accent = cat.accentColor || (cat.id === 'ragdoll' ? '#7ac7ff' : '#c8f538');
    btn.style.setProperty('--pill-accent', accent);
    btn.classList.toggle('active', cat.id === settings.catBreed);
    breedPillsEl.appendChild(btn);
  }
}

function renderThemePills(): void {
  if (!themePillsEl) return;
  themePillsEl.innerHTML = '';
  for (const theme of DESK_THEMES) {
    const btn = document.createElement('button');
    btn.className = 'theme-pill';
    btn.dataset.desktheme = theme.id;
    btn.title = `${theme.name} 键盘 + 鼠标`;
    const sw = document.createElement('span');
    sw.className = 'theme-swatch';
    sw.style.background = `linear-gradient(135deg, ${theme.keyTop} 0 50%, ${theme.swatch} 50% 100%)`;
    btn.appendChild(sw);
    btn.appendChild(document.createTextNode(theme.name));
    btn.classList.toggle('active', theme.id === (settings.deskTheme || 'classic'));
    themePillsEl.appendChild(btn);
  }
}

function updateScaleSliderVisual(scaleVal: number): void {
  const pctNum = Math.round(Math.max(20, Math.min(150, scaleVal * 100)));
  if (scaleSliderEl) {
    scaleSliderEl.value = String(pctNum);
    const fillPct = ((pctNum - 20) / (150 - 20)) * 100;
    scaleSliderEl.style.setProperty('--pct', `${fillPct.toFixed(1)}%`);
  }
  if (scaleValueEl) {
    scaleValueEl.textContent = `${pctNum}%`;
  }
}

function syncMenuUI(): void {
  const setCheck = (id: string, on: boolean) => {
    const el = document.getElementById(id);
    if (el) el.textContent = on ? '✓' : '';
  };
  setCheck('chk-privacy', settings.privacyPasswordGuard !== false);
  setCheck('chk-bubbles', settings.showKeyBubbles);
  setCheck('chk-lock', settings.clickThroughLocked);
  setCheck('chk-sound', settings.soundEnabled);
  setCheck('chk-top', settings.alwaysOnTop);
  setCheck('chk-autostart', settings.autostart);
  setCheck('chk-mcp', settings.mcpEnabled);
  setCheck('chk-flying', settings.flyingToys !== false);
  setCheck('chk-trash', settings.trashHelper !== false);

  if (!sliderDragging) {
    updateScaleSliderVisual(settings.scale);
  }

  const kbLayout: KeyboardLayoutId = settings.keyboardLayout === '108' ? '108' : '65';
  const kbOrient: KeyboardOrientation = settings.keyboardOrientation === 'viewer' ? 'viewer' : 'cat';
  document.querySelectorAll<HTMLButtonElement>('[data-kblayout]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.kblayout === kbLayout);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-kborient]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.kborient === kbOrient);
  });

  const activeCat = catList.find((c) => c.id === settings.catBreed) ?? catList[0];
  renderBreedPills();
  renderThemePills();

  const headerEl = document.getElementById('menu-header');
  if (headerEl && activeCat) {
    const emoji = activeCat.emoji || '🐱';
    headerEl.textContent = `${emoji} MiniCat ${activeCat.name}`;
    headerEl.style.color = activeCat.accentColor || '#c8f538';
  }

  engine.showKeyBubbles = settings.showKeyBubbles;
  engine.setCatAppearance(activeCat?.id || 'black', activeCat);
  engine.setKeyboardConfig(kbLayout, kbOrient);
  engine.setDeskTheme(settings.deskTheme || 'classic');
  engine.setFlyingToysEnabled(settings.flyingToys !== false);
  if (settings.trashHelper === false) engine.setFileDrag(false);
  if (!sliderDragging) {
    engine.setRenderScale(settings.scale);
  }
  catAudio.setEnabled(settings.soundEnabled);
}

function closeContextMenu(): void {
  if (!menuEl.classList.contains('hidden')) {
    menuEl.classList.add('hidden');
    void invoke('set_menu_open', { open: false });
    syncWin7OverlayFn?.(false);
  }
}

function openContextMenu(clientX: number, clientY: number): void {
  syncMenuUI();
  menuEl.classList.remove('hidden');
  void invoke('set_menu_open', { open: true });

  const rect = menuEl.getBoundingClientRect();
  const maxX = Math.max(8, window.innerWidth - rect.width - 8);
  const maxY = Math.max(8, window.innerHeight - rect.height - 8);
  menuEl.style.left = `${Math.max(8, Math.min(clientX, maxX))}px`;
  menuEl.style.top = `${Math.max(8, Math.min(clientY, maxY))}px`;
  syncWin7OverlayFn?.(true);
}

async function applySettingsPatch(patch: Partial<AppSettings>): Promise<void> {
  settings = { ...settings, ...patch };
  syncMenuUI();
  settings = await invoke<AppSettings>('update_settings', { patch: settings });
  syncMenuUI();
}

async function copyMcpConfig(): Promise<void> {
  const hint = document.getElementById('mcp-copy-hint');
  try {
    const jsonText = await invoke<string>('get_mcp_config');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(jsonText);
    } else {
      const ta = document.createElement('textarea');
      ta.value = jsonText;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (hint) {
      hint.textContent = '✓ 已复制';
      hint.classList.add('copied');
      setTimeout(() => {
        hint.textContent = 'AI 捏猫';
        hint.classList.remove('copied');
      }, 1800);
    }
  } catch (err) {
    console.error('Failed to copy MCP config:', err);
  }
}

async function createDesktopShortcut(): Promise<void> {
  const hint = document.getElementById('shortcut-hint');
  try {
    await invoke<string>('create_desktop_shortcut');
    if (hint) {
      hint.textContent = '✓ 已创建';
      hint.classList.add('copied');
      setTimeout(() => {
        hint.textContent = 'MiniCat';
        hint.classList.remove('copied');
      }, 1800);
    }
  } catch (err) {
    console.error('Failed to create desktop shortcut:', err);
  }
}

function setUpdateHint(text: string, mode: 'default' | 'ready' | 'error' = 'default'): void {
  const hint = document.getElementById('update-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.classList.remove('update-ready', 'update-error');
  if (mode === 'ready') hint.classList.add('update-ready');
  else if (mode === 'error') hint.classList.add('update-error');
}

function hideUpdateToast(): void {
  if (toastAutoHideTimer !== null) {
    window.clearTimeout(toastAutoHideTimer);
    toastAutoHideTimer = null;
  }
  if (!updateToastEl.classList.contains('hidden')) {
    updateToastEl.classList.add('hidden');
    void invoke('set_update_banner_open', { open: false });
    syncWin7OverlayFn?.(false);
  }
}

function showUpdateToast(
  text: string,
  options: { showInstall?: boolean; showOpen?: boolean; autoHideMs?: number; busy?: boolean } = {},
): void {
  if (toastAutoHideTimer !== null) {
    window.clearTimeout(toastAutoHideTimer);
    toastAutoHideTimer = null;
  }
  updateToastTextEl.textContent = text;
  btnToastInstallEl.classList.toggle('hidden', !options.showInstall);
  btnToastInstallEl.disabled = Boolean(options.busy);
  btnToastOpenEl.classList.toggle('hidden', !options.showOpen);
  updateToastEl.classList.remove('hidden');
  void invoke('set_update_banner_open', { open: true });
  requestAnimationFrame(() => syncWin7OverlayFn?.(false));

  if (options.autoHideMs && options.autoHideMs > 0) {
    toastAutoHideTimer = window.setTimeout(() => {
      hideUpdateToast();
    }, options.autoHideMs);
  }
}

function handleUpdateProgressEvent(ev: UpdateProgressEvent, fromManual = false): void {
  if (ev.info) {
    latestUpdateInfo = ev.info;
    appVersion = ev.info.currentVersion || appVersion;
  }

  switch (ev.stage) {
    case 'checking':
      updateBusy = true;
      setUpdateHint('检测中...');
      showUpdateToast('🔍 正在检查新版本...', { busy: true });
      break;
    case 'available':
      updateBusy = false;
      if (latestUpdateInfo?.hasUpdate) {
        const ver = latestUpdateInfo.latestVersion;
        setUpdateHint(`⬆ v${ver}`, 'ready');
        if (fromManual || dismissedVersion !== ver) {
          showUpdateToast(`✨ 发现新版本 v${ver}`, {
            showInstall: Boolean(latestUpdateInfo.downloadUrl),
            showOpen: !latestUpdateInfo.downloadUrl,
          });
        }
      }
      break;
    case 'up_to_date':
      updateBusy = false;
      setUpdateHint(`✓ v${appVersion}`);
      showUpdateToast(`✓ 已是最新版本 v${appVersion}`, { autoHideMs: 2600 });
      break;
    case 'downloading':
    case 'verifying':
    case 'installing':
      updateBusy = true;
      setUpdateHint('更新中...', 'ready');
      showUpdateToast(`⏳ ${ev.message}`, { busy: true });
      break;
    case 'error':
      updateBusy = false;
      setUpdateHint('检查失败', 'error');
      showUpdateToast(`⚠ ${ev.message}`, {
        showOpen: true,
        autoHideMs: 5200,
      });
      break;
  }
}

async function triggerInstallUpdate(): Promise<void> {
  if (updateBusy || !latestUpdateInfo || !latestUpdateInfo.hasUpdate) return;
  updateBusy = true;
  closeContextMenu();
  showUpdateToast(`⏳ 正在下载 v${latestUpdateInfo.latestVersion}...`, { busy: true });
  setUpdateHint('下载中...', 'ready');
  try {
    await invoke('install_update', { info: latestUpdateInfo });
  } catch (err) {
    updateBusy = false;
    const msg = typeof err === 'string' ? err : String(err);
    setUpdateHint('更新失败', 'error');
    showUpdateToast(`⚠ ${msg}`, { showOpen: true, autoHideMs: 6500 });
  }
}

async function triggerManualUpdateCheck(): Promise<void> {
  if (updateBusy) return;
  // If we already know an update is ready, clicking the menu item immediately starts installing it!
  if (latestUpdateInfo?.hasUpdate && latestUpdateInfo.downloadUrl) {
    await triggerInstallUpdate();
    return;
  }
  updateBusy = true;
  setUpdateHint('检测中...');
  closeContextMenu();
  showUpdateToast('🔍 正在检查新版本...', { busy: true });
  try {
    const info = await invoke<UpdateInfo>('check_for_update');
    handleUpdateProgressEvent(
      {
        stage: info.hasUpdate ? 'available' : 'up_to_date',
        message: info.hasUpdate
          ? `发现新版本 v${info.latestVersion}`
          : `已是最新版本 v${info.currentVersion}`,
        info,
      },
      true,
    );
  } catch (err) {
    const msg = typeof err === 'string' ? err : String(err);
    handleUpdateProgressEvent({ stage: 'error', message: msg, info: null }, true);
  }
}

async function bootstrap(): Promise<void> {
  engine.start();

  // Hide Windows-only desktop shortcut button on macOS
  if (/Mac/i.test(navigator.platform) || /Macintosh/i.test(navigator.userAgent)) {
    const shortcutBtn = document.getElementById('btn-desktop-shortcut');
    if (shortcutBtn) shortcutBtn.style.display = 'none';
  }

  try {
    const [loadedSettings, loadedCats, loadedVer] = await Promise.all([
      invoke<AppSettings>('get_settings'),
      invoke<CatSkinConfig[]>('get_cats'),
      invoke<string>('get_app_version'),
    ]);
    settings = loadedSettings;
    lastKnownLockState = settings.clickThroughLocked;
    if (Array.isArray(loadedCats) && loadedCats.length > 0) {
      catList = loadedCats;
    }
    if (loadedVer) {
      appVersion = loadedVer;
      setUpdateHint(`v${appVersion}`);
    }
    syncMenuUI();
  } catch (err) {
    console.error('Failed to load settings or cats:', err);
  }

  await listen<UpdateProgressEvent>('kuro-update-status', (ev) => {
    handleUpdateProgressEvent(ev.payload, false);
  });

  btnToastInstallEl.addEventListener('click', (e) => {
    e.stopPropagation();
    void triggerInstallUpdate();
  });

  btnToastOpenEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const url = latestUpdateInfo?.releaseUrl || 'https://github.com/xpfyg/kurocat/releases/latest';
    void invoke('open_release_page', { url });
  });

  btnToastCloseEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (latestUpdateInfo?.hasUpdate) {
      dismissedVersion = latestUpdateInfo.latestVersion;
    }
    hideUpdateToast();
  });

  if (scaleSliderEl) {
    scaleSliderEl.addEventListener('pointerdown', () => {
      sliderDragging = true;
    });
    scaleSliderEl.addEventListener('input', () => {
      sliderDragging = true;
      const nextScale = Math.max(0.2, Math.min(1.5, Number(scaleSliderEl.value) / 100));
      updateScaleSliderVisual(nextScale);
      engine.setRenderScale(nextScale);
    });
    const commitSliderScale = () => {
      sliderDragging = false;
      const nextScale = Math.max(0.2, Math.min(1.5, Number(scaleSliderEl.value) / 100));
      void applySettingsPatch({ scale: nextScale });
    };
    scaleSliderEl.addEventListener('change', commitSliderScale);
    scaleSliderEl.addEventListener('pointerup', () => {
      sliderDragging = false;
    });
  }

  if (scaleValueEl) {
    scaleValueEl.addEventListener('click', (e) => {
      e.stopPropagation();
      sliderDragging = false;
      updateScaleSliderVisual(1.0);
      void applySettingsPatch({ scale: 1.0 });
    });
  }

  await listen<AppSettings>('kuro-settings', (ev) => {
    const prevLock = lastKnownLockState;
    settings = ev.payload;
    lastKnownLockState = settings.clickThroughLocked;
    syncMenuUI();
    if (prevLock !== null && prevLock !== settings.clickThroughLocked) {
      if (settings.clickThroughLocked) {
        showUpdateToast('🔒 已锁定穿透（按住 Alt 点击或 ^ 托盘解锁）', { autoHideMs: 4200 });
      } else {
        showUpdateToast('🔓 已解除穿透，可直接拖动或右键', { autoHideMs: 2200 });
      }
    }
  });

  await listen<CatSkinConfig[]>('kuro-cats', (ev) => {
    if (Array.isArray(ev.payload) && ev.payload.length > 0) {
      catList = ev.payload;
      syncMenuUI();
    }
  });

  await listen<InputEvent>('kuro-input', (ev) => {
    const p = ev.payload;
    switch (p.kind) {
      case 'keyDown':
        engine.onKeyDown(p.vk, p.repeat);
        break;
      case 'keyUp':
        engine.onKeyUp(p.vk);
        break;
      case 'mouseMove':
        engine.onGlobalMouseMove(p.nx, p.ny);
        break;
      case 'mouseDown':
        engine.onMouseDown(p.button);
        break;
      case 'mouseUp':
        engine.onMouseUp(p.button);
        break;
      case 'mouseWheel':
        engine.onMouseWheel();
        break;
      case 'privacyTyping':
        engine.onPrivacyTyping();
        break;
    }
  });

  await listen<boolean>('kuro-privacy', (ev) => {
    engine.setPrivacyMode(Boolean(ev.payload));
  });

  await listen<boolean>('kuro-media', (ev) => {
    engine.setMusicPlaying(Boolean(ev.payload));
  });

  // While the cursor is "transformed" into a flying critter, hide the real system pointer.
  // Rust restores it automatically if these keepalives stop (watchdog) or the app exits.
  let cursorHidden = false;
  let lastCursorKeepalive = 0;
  window.setInterval(() => {
    const want =
      settings.flyingToys !== false &&
      menuEl.classList.contains('hidden') &&
      engine.isCritterActive();
    const now = performance.now();
    if (want !== cursorHidden || (want && now - lastCursorKeepalive > 500)) {
      cursorHidden = want;
      lastCursorKeepalive = now;
      void invoke('set_cursor_hidden', { hidden: want });
    }
  }, 100);

  // Drag files anywhere -> the cat pulls a trash can from behind its back; drop on it -> recycle bin.
  let watcherDragActive = false;
  let webviewDragInside = false;
  const fallbackTrashSide = (): 'left' | 'right' =>
    window.screenX + window.innerWidth / 2 < window.screen.width / 2 ? 'right' : 'left';

  await listen<FileDragInfo>('kuro-file-drag', (ev) => {
    const p = ev.payload;
    watcherDragActive = Boolean(p.active);
    if (settings.trashHelper === false) return;
    if (p.active) {
      engine.setFileDrag(true, p.count, p.side === 'right' ? 'right' : 'left');
    } else if (!webviewDragInside) {
      engine.setFileDrag(false);
    }
  });

  try {
    await getCurrentWebview().onDragDropEvent(async (event) => {
      if (settings.trashHelper === false) return;
      const payload = event.payload;
      if (payload.type === 'enter') {
        webviewDragInside = true;
        void invoke('set_file_drop_active', { active: true });
        engine.setFileDrag(true, payload.paths.length, watcherDragActive ? undefined : fallbackTrashSide());
        engine.setFileDragCount(payload.paths.length);
      } else if (payload.type === 'leave') {
        webviewDragInside = false;
        void invoke('set_file_drop_active', { active: false });
        if (!watcherDragActive) engine.setFileDrag(false);
      } else if (payload.type === 'drop') {
        webviewDragInside = false;
        void invoke('set_file_drop_active', { active: false });
        const dpr = Math.max(window.devicePixelRatio || 1, 1);
        const pt = engine.clientToLogical(payload.position.x / dpr, payload.position.y / dpr);
        const overCan = engine.isPointOverTrash(pt.x, pt.y) || engine.isCursorOverTrash();
        if (overCan && payload.paths.length > 0) {
          try {
            const moved = await invoke<number>('trash_files', { paths: payload.paths });
            if (moved > 0) {
              engine.onTrashSwallowed(moved);
            }
          } catch (err) {
            console.error('Failed to move files to recycle bin:', err);
            showUpdateToast(`⚠ ${typeof err === 'string' ? err : '无法移到回收站'}`, { autoHideMs: 3200 });
          }
        }
        engine.setFileDrag(false);
      }
    });
  } catch (err) {
    console.error('Drag & drop listener unavailable:', err);
  }

  await listen<WindowCursorInfo>('kuro-cursor', (ev) => {
    const c = ev.payload;
    altOverride = Boolean(c.altOverride);
    engine.onWindowCursor(c.relX, c.relY, c.overCat);
    const interactive = !settings.clickThroughLocked || altOverride;
    canvas.classList.toggle('pet-hover', c.overCat && interactive);
  });

  // Left-click drag to reposition transparent window
  canvas.addEventListener('mousedown', async (e) => {
    if (e.button === 0) {
      closeContextMenu();
      if (settings.clickThroughLocked && !altOverride && !e.altKey) return;
      canvas.classList.add('pet-dragging');
      void invoke('set_dragging', { dragging: true });
      try {
        await getCurrentWindow().startDragging();
      } finally {
        canvas.classList.remove('pet-dragging');
        void invoke('set_dragging', { dragging: false });
        void invoke('save_window_pos');
      }
    }
  });

  // Right-click opens sleek dark glass settings menu
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (settings.clickThroughLocked && !altOverride && !e.altKey) return;
    openContextMenu(e.clientX, e.clientY);
  });

  window.addEventListener('blur', () => closeContextMenu());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
  });

  menuEl.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>(
      '[data-action], [data-scale], [data-breed], [data-kblayout], [data-kborient], [data-desktheme]',
    );
    if (!target) return;

    const deskThemeAttr = target.dataset.desktheme;
    if (deskThemeAttr) {
      void applySettingsPatch({ deskTheme: deskThemeAttr });
      return;
    }

    const kbLayoutAttr = target.dataset.kblayout;
    if (kbLayoutAttr === '65' || kbLayoutAttr === '108') {
      void applySettingsPatch({ keyboardLayout: kbLayoutAttr });
      closeContextMenu();
      return;
    }

    const kbOrientAttr = target.dataset.kborient;
    if (kbOrientAttr === 'cat' || kbOrientAttr === 'viewer') {
      void applySettingsPatch({ keyboardOrientation: kbOrientAttr });
      closeContextMenu();
      return;
    }

    const breedAttr = target.dataset.breed;
    if (breedAttr) {
      void applySettingsPatch({ catBreed: breedAttr });
      closeContextMenu();
      return;
    }

    const scaleAttr = target.dataset.scale;
    if (scaleAttr) {
      void applySettingsPatch({ scale: Number(scaleAttr) });
      closeContextMenu();
      return;
    }

    switch (target.dataset.action) {
      case 'toggle-privacy':
        void applySettingsPatch({ privacyPasswordGuard: !(settings.privacyPasswordGuard !== false) });
        break;
      case 'toggle-bubbles':
        void applySettingsPatch({ showKeyBubbles: !settings.showKeyBubbles });
        break;
      case 'toggle-lock':
        void applySettingsPatch({ clickThroughLocked: !settings.clickThroughLocked });
        closeContextMenu();
        break;
      case 'toggle-sound':
        void applySettingsPatch({ soundEnabled: !settings.soundEnabled });
        break;
      case 'toggle-top':
        void applySettingsPatch({ alwaysOnTop: !settings.alwaysOnTop });
        break;
      case 'toggle-autostart':
        void applySettingsPatch({ autostart: !settings.autostart });
        break;
      case 'toggle-flying':
        void applySettingsPatch({ flyingToys: !(settings.flyingToys !== false) });
        break;
      case 'toggle-trash':
        void applySettingsPatch({ trashHelper: !(settings.trashHelper !== false) });
        break;
      case 'toggle-mcp':
        void applySettingsPatch({ mcpEnabled: !settings.mcpEnabled });
        break;
      case 'copy-mcp':
        void copyMcpConfig();
        break;
      case 'desktop-shortcut':
        void createDesktopShortcut();
        break;
      case 'check-update':
        void triggerManualUpdateCheck();
        break;
      case 'reset-pos':
        void invoke('reset_position');
        closeContextMenu();
        break;
      case 'quit':
        void invoke('quit_app');
        break;
    }
  });

  // On Windows 7/8 (where Microsoft WebView2 does not support DirectComposition alpha),
  // stream the live 2D Canvas RGBA pixels via zero-copy binary IPC to a native Win32
  // UpdateLayeredWindow(ULW_ALPHA) presenter window for true 256-level per-pixel anti-aliased
  // transparency (zero white box, zero jagged edges) on both Aero and Win7 Basic desktops.
  try {
    const useWin7Ulw = await invoke<boolean>('is_win7_ulw_mode');
    if (useWin7Ulw) {
      document.documentElement.classList.add('win7-ulw-mode');
      const petCtx = canvas.getContext('2d');
      let win7Visible = true;
      let frameBusy = false;
      let lastPresentMs = 0;
      let lastFrameKey = '';
      let lastOverlayKey = '';

      const syncWin7Overlay = (focusMenu = false) => {
        const dpr = Math.max(window.devicePixelRatio || 1, 1);
        const physW = Math.max(1, Math.round(window.innerWidth * dpr));
        const physH = Math.max(1, Math.round(window.innerHeight * dpr));
        const rects: number[] = [];

        if (menuEl && !menuEl.classList.contains('hidden')) {
          const r = menuEl.getBoundingClientRect();
          if (r.width > 2 && r.height > 2) {
            rects.push(
              Math.max(0, Math.floor(r.left * dpr)),
              Math.max(0, Math.floor(r.top * dpr)),
              Math.min(physW, Math.ceil(r.right * dpr)),
              Math.min(physH, Math.ceil(r.bottom * dpr)),
              Math.round(12 * dpr),
            );
          }
        }
        if (updateToastEl && !updateToastEl.classList.contains('hidden')) {
          const r = updateToastEl.getBoundingClientRect();
          if (r.width > 2 && r.height > 2) {
            const top = Math.max(0, Math.floor(r.top * dpr));
            const bot = Math.min(physH, Math.ceil(r.bottom * dpr));
            rects.push(
              Math.max(0, Math.floor(r.left * dpr)),
              top,
              Math.min(physW, Math.ceil(r.right * dpr)),
              bot,
              Math.max(8, Math.round((bot - top) / 2)),
            );
          }
        }

        const key = rects.join(',');
        if (!focusMenu && key === lastOverlayKey) return;
        lastOverlayKey = key;
        void invoke('win7_sync_overlay', { rects, focusMenu });
      };
      syncWin7OverlayFn = syncWin7Overlay;

      await listen<{ x: number; y: number }>('kuro-win7-contextmenu', (ev) => {
        openContextMenu(ev.payload.x, ev.payload.y);
      });
      await listen('kuro-win7-close-menu', () => {
        closeContextMenu();
      });
      await listen<boolean>('kuro-win7-visibility', (ev) => {
        win7Visible = Boolean(ev.payload);
        if (win7Visible) {
          lastFrameKey = '';
        }
      });

      const presentWin7Frame = () => {
        if (!win7Visible || frameBusy || !petCtx) return;
        const now = performance.now();
        if (now - lastPresentMs < 28) return;
        const w = canvas.width;
        const h = canvas.height;
        if (w < 8 || h < 8) return;

        const imgData = petCtx.getImageData(0, 0, w, h);
        const u32 = new Uint32Array(
          imgData.data.buffer,
          imgData.data.byteOffset,
          imgData.data.byteLength >>> 2,
        );
        let hash = 2166136261 >>> 0;
        hash = Math.imul(hash ^ w, 16777619) >>> 0;
        hash = Math.imul(hash ^ h, 16777619) >>> 0;
        for (let i = 0; i < u32.length; i++) {
          hash = Math.imul(hash ^ u32[i], 16777619) >>> 0;
        }
        const key = `${w}x${h}:${hash}`;
        if (key === lastFrameKey) return;

        lastFrameKey = key;
        lastPresentMs = now;
        frameBusy = true;
        const payload = new Uint8Array(
          imgData.data.buffer,
          imgData.data.byteOffset,
          imgData.data.byteLength,
        );
        void invoke('win7_present_frame', payload, {
          headers: { 'x-w': String(w), 'x-h': String(h) },
        }).finally(() => {
          frameBusy = false;
        });
      };

      engine.onAfterRender = presentWin7Frame;
      // Kick initial presentation immediately & keep overlay bounds in sync if toast/menu resizes
      setTimeout(presentWin7Frame, 30);
      setInterval(() => syncWin7Overlay(false), 200);
    }
  } catch {
    // Non-Win7 or unsupported: keep native transparency untouched
  }
}

void bootstrap();

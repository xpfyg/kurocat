import { MiniCatEngine, type CatMood, type KeyboardOrientation } from '../../src/catEngine';
import { catAudio } from '../../src/audio';
import type { KeyboardLayoutId } from '../../src/keyboardLayout';
import { BUILTIN_WEB_CATS } from './builtinCats';
import { initDownloadStats } from './downloads';
import { keyboardEventToVk } from './webKeyMap';
import { DESK_THEMES } from '../../src/deskThemes';

const GITHUB_REPO = 'xpfyg/minicat';
const DEFAULT_RELEASE_TAG = 'v4.8.3';

interface ReleaseAsset {
  name: string;
  url: string;
  sizeText: string;
}

type ReleaseAssetMap = Record<'win65' | 'macos', ReleaseAsset>;

function releaseAssetUrl(name: string): string {
  // GitHub 的 latest/download 会 302 到最新 Release 的真实附件，直接触发下载。
  return `https://github.com/${GITHUB_REPO}/releases/latest/download/${name}`;
}

function buildDefaultAssets(): ReleaseAssetMap {
  const winName = 'MiniCat-x64-setup.exe';
  const macName = 'MiniCat-macos-universal.dmg';
  return {
    win65: { name: winName, url: releaseAssetUrl(winName), sizeText: '1.62 MB' },
    macos: { name: macName, url: releaseAssetUrl(macName), sizeText: '5.50 MB' },
  };
}

function formatBytesMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function applyReleaseUI(tag: string, assets: ReleaseAssetMap): void {
  const navPill = document.getElementById('nav-ver-pill');
  if (navPill) navPill.textContent = tag;

  const heroVer = document.getElementById('hero-release-label');
  if (heroVer) heroVer.textContent = `最新版本 ${tag}`;

  const heroTargets = {
    win65: ['hero-win-dl', 'hero-win-dl-label', 'Windows'],
    macos: ['hero-mac-dl', 'hero-mac-dl-label', 'macOS'],
  } as const;

  (Object.keys(assets) as Array<keyof ReleaseAssetMap>).forEach((key) => {
    const item = assets[key];
    const [heroId, labelId, platform] = heroTargets[key];
    const heroBtn = document.getElementById(heroId) as HTMLAnchorElement | null;
    const heroLabel = document.getElementById(labelId);
    if (heroBtn) heroBtn.href = item.url;
    if (heroLabel) heroLabel.textContent = `下载 ${platform} 版（${item.sizeText}）`;

    const nameEl = document.querySelector(`[data-asset-name="${key}"]`);
    const sizeEl = document.querySelector(`[data-asset-size="${key}"]`);
    const primaryEl = document.querySelector(`[data-dl-primary="${key}"]`) as HTMLAnchorElement | null;
    if (nameEl) nameEl.textContent = item.name;
    if (sizeEl) sizeEl.textContent = item.sizeText;
    if (primaryEl) primaryEl.href = item.url;
  });
}

async function syncGithubMetadata(): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4500);
  try {
    const [repoRes, relRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${GITHUB_REPO}`, { signal: controller.signal }),
      fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { signal: controller.signal }),
    ]);

    if (repoRes.ok) {
      const repo = await repoRes.json();
      if (typeof repo.stargazers_count === 'number') {
        const sep = document.getElementById('github-stats-sep');
        const txt = document.getElementById('github-stats-text');
        if (sep && txt) {
          sep.style.display = '';
          txt.style.display = '';
          txt.textContent = `★ ${repo.stargazers_count} Stars`;
        }
      }
    }

    if (relRes.ok) {
      const rel = await relRes.json();
      const tag: string | undefined = rel.tag_name;
      const ghAssets: Array<{ name: string; browser_download_url: string; size: number }> = Array.isArray(rel.assets)
        ? rel.assets
        : [];
      const winAsset = ghAssets.find((asset) => asset.name.endsWith('-x64-setup.exe') && !asset.name.includes('108key'));
      const macAsset = ghAssets.find((asset) => asset.name.endsWith('-macos-universal.dmg'));

      if (tag && winAsset && macAsset) {
        applyReleaseUI(tag, {
          win65: { name: winAsset.name, url: releaseAssetUrl('MiniCat-x64-setup.exe'), sizeText: formatBytesMB(winAsset.size) },
          macos: { name: macAsset.name, url: releaseAssetUrl('MiniCat-macos-universal.dmg'), sizeText: formatBytesMB(macAsset.size) },
        });
      }
    }
  } catch {
    // GitHub 不可用时保留默认 Release 直链。
  } finally {
    window.clearTimeout(timer);
  }
}

function initPlayground(): void {
  const canvas = document.getElementById('minicat-canvas') as HTMLCanvasElement | null;
  const viewport = document.getElementById('canvas-viewport') as HTMLDivElement | null;
  if (!canvas || !viewport) return;

  const engine = new MiniCatEngine(canvas, { embedded: true });
  let currentLayout: KeyboardLayoutId = '65';
  let currentOrient: KeyboardOrientation = 'cat';
  let currentSkinId = 'black';
  let autoDemoRunning = true;
  let autoDemoTimer: number | null = null;

  const statusPill = document.getElementById('stage-status-pill');
  const updateStatusPill = () => {
    if (!statusPill) return;
    const layoutText = currentLayout === '108' ? '108 全尺寸' : '65% 紧凑';
    const orientText = currentOrient === 'viewer' ? '面向观众' : '面向猫咪';
    statusPill.textContent = `${layoutText} · ${orientText}`;
  };

  engine.setCatAppearance('black', BUILTIN_WEB_CATS[0]);
  engine.setKeyboardConfig(currentLayout, currentOrient);
  engine.start();
  updateStatusPill();

  // Mood preview row (desktop app switches moods automatically; the site lets visitors try each one)
  const moodRow = document.getElementById('mood-row');
  const setMoodPreview = (mood: CatMood | null) => {
    engine.setMoodPreview(mood);
    document.querySelectorAll('[data-mood]').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.mood === (mood ?? 'auto'));
    });
  };
  const setMoodRowEnabled = (enabled: boolean) => {
    moodRow?.classList.toggle('is-disabled', !enabled);
    if (!enabled) setMoodPreview(null);
  };
  document.querySelectorAll('[data-mood]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = (btn as HTMLElement).dataset.mood;
      if (!raw || raw === 'auto') {
        setMoodPreview(null);
        return;
      }
      setMoodPreview(raw as CatMood);
    });
  });

  const ro = new ResizeObserver(() => engine.resize());
  ro.observe(viewport);

  // Build 6 skin buttons
  const skinHost = document.getElementById('skin-pills');
  if (skinHost) {
    BUILTIN_WEB_CATS.forEach((skin) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `skin-btn${skin.id === currentSkinId ? ' active' : ''}`;
      btn.dataset.skinId = skin.id;
      btn.textContent = `${skin.emoji || '🐱'} ${skin.name}`;
      btn.addEventListener('click', () => {
        currentSkinId = skin.id;
        engine.setCatAppearance(skin.id, skin);
        setMoodRowEnabled(skin.id !== 'dafeiyu');
        skinHost.querySelectorAll('.skin-btn').forEach((el) => {
          el.classList.toggle('active', (el as HTMLElement).dataset.skinId === skin.id);
        });
      });
      skinHost.appendChild(btn);
    });
  }

  // Layout & Orientation buttons
  const setLayout = (layout: KeyboardLayoutId) => {
    currentLayout = layout;
    engine.setKeyboardConfig(currentLayout, currentOrient);
    document.querySelectorAll('[data-layout]').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.layout === layout);
    });
    updateStatusPill();
  };

  const setOrient = (orient: KeyboardOrientation) => {
    currentOrient = orient;
    engine.setKeyboardConfig(currentLayout, currentOrient);
    document.querySelectorAll('[data-orient]').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.orient === orient);
    });
    updateStatusPill();
  };

  document.querySelectorAll('[data-layout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = (btn as HTMLElement).dataset.layout === '108' ? '108' : '65';
      setLayout(val);
    });
  });

  document.querySelectorAll('[data-orient]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = (btn as HTMLElement).dataset.orient === 'viewer' ? 'viewer' : 'cat';
      setOrient(val);
    });
  });

  // Feature card button to jump & test 108-key
  const try108Btn = document.getElementById('try-108-btn');
  if (try108Btn) {
    try108Btn.addEventListener('click', () => {
      setLayout('108');
      setOrient('viewer');
      document.getElementById('playground')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      startAutoDemo();
    });
  }

  // Feature card button to switch live playground directly to BigFish (鲸鱼娘)
  const tryDafeiyuBtn = document.getElementById('try-dafeiyu-btn');
  if (tryDafeiyuBtn) {
    tryDafeiyuBtn.addEventListener('click', () => {
      const fish = BUILTIN_WEB_CATS.find((c) => c.id === 'dafeiyu');
      if (fish) {
        currentSkinId = fish.id;
        engine.setCatAppearance(fish.id, fish);
        setMoodRowEnabled(false);
        skinHost?.querySelectorAll('.skin-btn').forEach((el) => {
          el.classList.toggle('active', (el as HTMLElement).dataset.skinId === fish.id);
        });
      }
      setLayout('65');
      setOrient('viewer');
      document.getElementById('playground')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      startAutoDemo();
    });
  }

  // Backdrop switcher (Dark / Light desktop wallpaper preview)
  document.querySelectorAll('[data-backdrop]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn as HTMLElement).dataset.backdrop === 'light' ? 'light' : 'dark';
      viewport.classList.toggle('backdrop-light', mode === 'light');
      viewport.classList.toggle('backdrop-dark', mode === 'dark');
      document.querySelectorAll('[data-backdrop]').forEach((b) => {
        b.classList.toggle('active', (b as HTMLElement).dataset.backdrop === mode);
      });
    });
  });

  // Bubbles & Purr toggles
  const btnBubbles = document.getElementById('btn-bubbles');
  if (btnBubbles) {
    btnBubbles.addEventListener('click', () => {
      engine.showKeyBubbles = !engine.showKeyBubbles;
      btnBubbles.classList.toggle('active', engine.showKeyBubbles);
    });
  }

  let purrEnabled = true;
  const btnPurr = document.getElementById('btn-purr');
  if (btnPurr) {
    btnPurr.addEventListener('click', () => {
      purrEnabled = !purrEnabled;
      catAudio.setEnabled(purrEnabled);
      btnPurr.classList.toggle('active', purrEnabled);
    });
  }

  // Interactive Lo-Fi Music Demo toggle (synthesizes cozy Web Audio BGM + triggers cat headphones & sway)
  const createLoFiDemoPlayer = () => {
    let ctx: AudioContext | null = null;
    let master: GainNode | null = null;
    let timer: number | null = null;
    let step = 0;

    // Dreamy lo-fi chord progression (Fmaj7 -> Em7 -> Dm9 -> Cmaj9) in Hz
    const chords: number[][] = [
      [174.61, 220.0, 261.63, 329.63],
      [164.81, 196.0, 246.94, 293.66],
      [146.83, 220.0, 261.63, 329.63],
      [130.81, 196.0, 246.94, 293.66],
    ];
    // Sparse warm kalimba-like melody notes aligned to 8th-note steps (16 steps per 4-chord cycle)
    const melody: Array<number | null> = [
      523.25, null, 659.25, 587.33,
      493.88, null, 587.33, null,
      440.0, 523.25, 659.25, null,
      587.33, null, 523.25, null,
    ];

    const ensureCtx = () => {
      if (!ctx) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return false;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0;
        const warmth = ctx.createBiquadFilter();
        warmth.type = 'lowpass';
        warmth.frequency.value = 1650;
        warmth.Q.value = 0.7;
        master.connect(warmth);
        warmth.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      return Boolean(ctx && master);
    };

    const playNote = (
      freq: number,
      dur: number,
      vol: number,
      type: OscillatorType,
      when: number,
    ) => {
      if (!ctx || !master) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, when);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(vol, when + 0.035);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(gain);
      gain.connect(master);
      osc.start(when);
      osc.stop(when + dur + 0.04);
    };

    const playSoftKick = (when: number) => {
      if (!ctx || !master) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(115, when);
      osc.frequency.exponentialRampToValueAtTime(42, when + 0.14);
      gain.gain.setValueAtTime(0.28, when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.22);
      osc.connect(gain);
      gain.connect(master);
      osc.start(when);
      osc.stop(when + 0.25);
    };

    const tick = () => {
      if (!ctx || !master) return;
      const now = ctx.currentTime + 0.02;
      const idx = step % 16;

      // Play warm Rhodes chord at the start of every 4 steps
      if (idx % 4 === 0) {
        const chord = chords[(idx / 4) % chords.length];
        chord.forEach((f, i) => {
          playNote(f, 1.55, 0.085, 'triangle', now + i * 0.018);
        });
      }

      // Soft lo-fi kick on beats 0 and 2 of each bar
      if (idx % 4 === 0 || idx % 4 === 2) {
        playSoftKick(now);
      }

      // Gentle bell melody on top
      const mel = melody[idx];
      if (mel) {
        playNote(mel, 0.72, 0.075, 'sine', now);
      }

      step += 1;
    };

    return {
      start() {
        if (!ensureCtx() || !ctx || !master) return;
        const now = ctx.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(0.22, now, 0.14);
        step = 0;
        tick();
        if (timer !== null) window.clearInterval(timer);
        timer = window.setInterval(tick, 385);
      },
      stop() {
        if (timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
        if (ctx && master) {
          const now = ctx.currentTime;
          master.gain.cancelScheduledValues(now);
          master.gain.setTargetAtTime(0.0001, now, 0.12);
        }
      },
    };
  };

  const lofiPlayer = createLoFiDemoPlayer();
  let musicDemoPlaying = false;
  const btnMusicDemo = document.getElementById('btn-music-demo');
  if (btnMusicDemo) {
    btnMusicDemo.addEventListener('click', () => {
      musicDemoPlaying = !musicDemoPlaying;
      btnMusicDemo.classList.toggle('active', musicDemoPlaying);
      btnMusicDemo.textContent = musicDemoPlaying ? '🎧 听歌中' : '🎧 听歌';
      if (musicDemoPlaying) {
        // Clear any pinned mood preview so real musicPlaying drives headphones + relaxed sway naturally
        setMoodPreview(null);
        lofiPlayer.start();
      } else {
        lofiPlayer.stop();
      }
      engine.setMusicPlaying(musicDemoPlaying);
    });
  }

  // Password privacy interactive demo (manual toggle OR focusing the real <input type="password">)
  const btnPrivacy = document.getElementById('btn-privacy-demo');
  const pwdInput = document.getElementById('web-pwd-test') as HTMLInputElement | null;
  let manualPrivacyPinned = false;
  let pwdInputFocused = false;
  const syncPrivacyState = () => {
    const active = manualPrivacyPinned || pwdInputFocused;
    engine.setPrivacyMode(active);
    if (btnPrivacy) {
      btnPrivacy.classList.toggle('active', active);
      btnPrivacy.textContent = active ? '🙈 密码防偷窥中' : '🔒 密码防偷窥';
    }
  };
  if (btnPrivacy) {
    btnPrivacy.addEventListener('click', () => {
      manualPrivacyPinned = !manualPrivacyPinned;
      if (manualPrivacyPinned && autoDemoRunning) stopAutoDemo();
      syncPrivacyState();
    });
  }
  if (pwdInput) {
    pwdInput.addEventListener('focus', () => {
      pwdInputFocused = true;
      if (autoDemoRunning) stopAutoDemo();
      syncPrivacyState();
    });
    pwdInput.addEventListener('blur', () => {
      pwdInputFocused = false;
      syncPrivacyState();
    });
    pwdInput.addEventListener('keydown', () => {
      engine.onPrivacyTyping();
    });
  }

  // Scale slider (20% - 150%)
  const scaleSlider = document.getElementById('web-scale-slider') as HTMLInputElement | null;
  const scaleValBtn = document.getElementById('web-scale-val');
  const applyScalePct = (pct: number) => {
    const clamped = Math.max(20, Math.min(150, Math.round(pct)));
    engine.setRenderScale(clamped / 100);
    if (scaleSlider) scaleSlider.value = String(clamped);
    if (scaleValBtn) scaleValBtn.textContent = `${clamped}%`;
  };
  if (scaleSlider) {
    scaleSlider.addEventListener('input', () => applyScalePct(Number(scaleSlider.value)));
  }
  if (scaleValBtn) {
    scaleValBtn.addEventListener('click', () => applyScalePct(100));
  }

  // Auto-demo choreography (stops immediately when user starts typing/clicking)
  const btnAutoDemo = document.getElementById('btn-auto-demo');
  const DEMO_SCRIPT: Array<{ type: 'key'; vk: number; hold: number; gap: number } | { type: 'mouse'; btn: 'left' | 'right'; hold: number; gap: number }> = [
    { type: 'key', vk: 0x4b, hold: 90, gap: 165 }, // K
    { type: 'key', vk: 0x55, hold: 85, gap: 155 }, // U
    { type: 'key', vk: 0x52, hold: 90, gap: 160 }, // R
    { type: 'key', vk: 0x4f, hold: 85, gap: 170 }, // O
    { type: 'key', vk: 0x43, hold: 90, gap: 160 }, // C
    { type: 'key', vk: 0x41, hold: 85, gap: 155 }, // A
    { type: 'key', vk: 0x54, hold: 95, gap: 220 }, // T
    { type: 'key', vk: 0x20, hold: 90, gap: 260 }, // Space
    { type: 'mouse', btn: 'left', hold: 240, gap: 360 },
    { type: 'mouse', btn: 'right', hold: 240, gap: 420 },
    { type: 'key', vk: 0x48, hold: 80, gap: 150 }, // H
    { type: 'key', vk: 0x49, hold: 85, gap: 180 }, // I
    { type: 'key', vk: 0x0d, hold: 110, gap: 680 }, // Enter
  ];
  let demoStep = 0;

  const stopAutoDemo = () => {
    autoDemoRunning = false;
    if (autoDemoTimer !== null) {
      window.clearTimeout(autoDemoTimer);
      autoDemoTimer = null;
    }
    if (btnAutoDemo) {
      btnAutoDemo.classList.remove('active');
      btnAutoDemo.textContent = '▶ 自动演示';
    }
  };

  const runDemoTick = () => {
    if (!autoDemoRunning) return;
    const item = DEMO_SCRIPT[demoStep % DEMO_SCRIPT.length];
    demoStep += 1;
    if (item.type === 'key') {
      engine.onKeyDown(item.vk, false);
      window.setTimeout(() => engine.onKeyUp(item.vk), item.hold);
    } else {
      engine.onMouseDown(item.btn);
      window.setTimeout(() => engine.onMouseUp(item.btn), item.hold);
    }
    autoDemoTimer = window.setTimeout(runDemoTick, item.gap);
  };

  const startAutoDemo = () => {
    if (autoDemoTimer !== null) window.clearTimeout(autoDemoTimer);
    autoDemoRunning = true;
    setMoodPreview(null);
    if (btnAutoDemo) {
      btnAutoDemo.classList.add('active');
      btnAutoDemo.textContent = '⏸ 停止演示';
    }
    autoDemoTimer = window.setTimeout(runDemoTick, 240);
  };

  if (btnAutoDemo) {
    btnAutoDemo.addEventListener('click', () => {
      if (autoDemoRunning) stopAutoDemo();
      else startAutoDemo();
    });
  }

  // Dedicated L/R Mouse Demo button (great for mobile visitors!)
  const btnMouseDemo = document.getElementById('btn-mouse-demo');
  if (btnMouseDemo) {
    btnMouseDemo.addEventListener('click', () => {
      stopAutoDemo();
      engine.onMouseDown('left');
      window.setTimeout(() => {
        engine.onMouseUp('left');
        window.setTimeout(() => {
          engine.onMouseDown('right');
          window.setTimeout(() => engine.onMouseUp('right'), 320);
        }, 120);
      }, 320);
    });
  }

  // Real physical keyboard interaction
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (engine.privacyMode) {
      if (autoDemoRunning) stopAutoDemo();
      engine.onPrivacyTyping();
      return;
    }
    const vk = keyboardEventToVk(e);
    if (vk !== null) {
      if (autoDemoRunning) stopAutoDemo();
      engine.onKeyDown(vk, e.repeat);
    }
  });

  window.addEventListener('keyup', (e) => {
    const vk = keyboardEventToVk(e);
    if (vk !== null) {
      engine.onKeyUp(vk);
    }
  });

  // Map a client point into normalized cat-logical coordinates (matches the engine's own view transform)
  const toCatRel = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const { w: lw, h: lh } = engine.getLogicalSize();
    const l = engine.clientToLogical(clientX - rect.left, clientY - rect.top);
    return { relX: l.x / lw, relY: l.y / lh, lx: l.x, ly: l.y };
  };

  // Real mouse move / petting / eye-tracking / L/R/M clicks on stage
  viewport.addEventListener('pointermove', (e) => {
    const rect = viewport.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
    engine.onGlobalMouseMove(nx, ny);
    engine.setCursorPresent(true);

    const { relX, relY } = toCatRel(e.clientX, e.clientY);

    // Cat head/body zone in normalized logical space
    const overHead = relX >= 0.30 && relX <= 0.72 && relY >= 0.14 && relY <= 0.52;
    viewport.classList.toggle('petting', overHead);
    engine.onWindowCursor(relX, relY, overHead);
  });

  viewport.addEventListener('pointerleave', () => {
    viewport.classList.remove('petting');
    engine.setCursorPresent(false);
    engine.onWindowCursor(0.5, 0.5, false);
  });

  // While the cursor is a flying critter, hide the real pointer so it truly "becomes" the critter
  engine.onAfterRender = () => {
    viewport.classList.toggle('critter-cursor', engine.isCritterActive());
    viewport.classList.toggle('trash-pointer', engine.isCursorOverTrash());
  };

  // Keyboard + mouse theme sets
  const themeHost = document.getElementById('desk-theme-pills');
  if (themeHost) {
    DESK_THEMES.forEach((theme) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `chip-btn mood-chip${theme.id === 'classic' ? ' active' : ''}`;
      btn.dataset.deskTheme = theme.id;
      btn.title = `${theme.name} 键盘 + 鼠标`;
      const sw = document.createElement('span');
      sw.className = 'theme-swatch';
      sw.style.background = `linear-gradient(135deg, ${theme.keyTop} 0 50%, ${theme.swatch} 50% 100%)`;
      btn.appendChild(sw);
      btn.appendChild(document.createTextNode(theme.name));
      btn.addEventListener('click', () => {
        engine.setDeskTheme(theme.id);
        themeHost.querySelectorAll('[data-desk-theme]').forEach((el) => {
          el.classList.toggle('active', (el as HTMLElement).dataset.deskTheme === theme.id);
        });
      });
      themeHost.appendChild(btn);
    });
  }

  // Trash can demo: simulated drag (button) or real files dragged onto the page.
  // On the web nothing is deleted — the desktop app moves dropped files to the recycle bin.
  const btnTrashDemo = document.getElementById('btn-trash-demo');
  let trashDemoOn = false;
  const setTrashDemo = (on: boolean) => {
    trashDemoOn = on;
    engine.setFileDrag(on, on ? 3 : 0, 'right');
    if (btnTrashDemo) {
      btnTrashDemo.classList.toggle('active', on);
      btnTrashDemo.textContent = on ? '🗑️ 点垃圾桶丢入' : '🗑️ 回收';
    }
  };
  if (btnTrashDemo) {
    btnTrashDemo.addEventListener('click', () => {
      if (autoDemoRunning) stopAutoDemo();
      setTrashDemo(!trashDemoOn);
    });
  }

  // Draggable trash icon overlay: drag it into the stage to trigger the trash-toss action
  const trashToss = document.getElementById('trash-toss') as HTMLButtonElement | null;
  if (trashToss) {
    const trashTossHint = document.getElementById('trash-toss-hint');
    let tossing = false;
    let startLeft = 0;
    let startTop = 0;
    let grabX = 0;
    let grabY = 0;

    const resetToss = () => {
      trashToss.style.transform = '';
      trashToss.classList.remove('is-dragging', 'is-over');
    };

    trashToss.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (autoDemoRunning) stopAutoDemo();
      tossing = true;
      const rect = trashToss.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      grabX = e.clientX - rect.left;
      grabY = e.clientY - rect.top;
      trashToss.setPointerCapture(e.pointerId);
      trashToss.classList.add('is-dragging');
      engine.setFileDrag(true, 3);
      const { relX, relY } = toCatRel(e.clientX, e.clientY);
      engine.onWindowCursor(relX, relY, false);
    });

    trashToss.addEventListener('pointermove', (e) => {
      if (!tossing) return;
      const vr = viewport.getBoundingClientRect();
      const w = trashToss.offsetWidth;
      const h = trashToss.offsetHeight;
      const x = Math.max(vr.left + 4, Math.min(vr.right - w - 4, e.clientX - grabX));
      const y = Math.max(vr.top + 4, Math.min(vr.bottom - h - 4, e.clientY - grabY));
      trashToss.style.transform = `translate(${x - startLeft}px, ${y - startTop}px)`;
      const { relX, relY } = toCatRel(e.clientX, e.clientY);
      engine.onWindowCursor(relX, relY, false);
      trashToss.classList.toggle('is-over', engine.isCursorOverTrash());
    });

    const endToss = (e: PointerEvent, cancelled: boolean) => {
      if (!tossing) return;
      tossing = false;
      const vr = viewport.getBoundingClientRect();
      const inside =
        e.clientX >= vr.left && e.clientX <= vr.right && e.clientY >= vr.top && e.clientY <= vr.bottom;
      if (!cancelled && inside) {
        engine.onTrashSwallowed(3);
        trashToss.classList.add('is-done');
        if (trashTossHint) trashTossHint.textContent = '♻️ 已回收';
        window.setTimeout(() => {
          trashToss.classList.remove('is-done');
          if (trashTossHint) trashTossHint.textContent = '拖纸团进垃圾桶 → 回收站';
        }, 1400);
      }
      if (!trashDemoOn) engine.setFileDrag(false);
      resetToss();
    };

    trashToss.addEventListener('pointerup', (e) => endToss(e, false));
    trashToss.addEventListener('pointercancel', (e) => endToss(e, true));
  }

  let pageDragDepth = 0;
  const dragHasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!dragHasFiles(e)) return;
    pageDragDepth += 1;
    const n = e.dataTransfer?.items?.length || 1;
    if (autoDemoRunning) stopAutoDemo();
    engine.setFileDrag(true, n, 'right');
  });
  window.addEventListener('dragleave', (e) => {
    if (!dragHasFiles(e)) return;
    pageDragDepth = Math.max(0, pageDragDepth - 1);
    if (pageDragDepth === 0 && !trashDemoOn) engine.setFileDrag(false);
  });
  window.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (inside) {
      const { relX, relY } = toCatRel(e.clientX, e.clientY);
      engine.onWindowCursor(relX, relY, false);
    } else {
      engine.onWindowCursor(0.5, -1.5, false);
    }
    if (e.dataTransfer) e.dataTransfer.dropEffect = engine.isCursorOverTrash() ? 'move' : 'none';
  });
  window.addEventListener('drop', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    pageDragDepth = 0;
    const { lx, ly } = toCatRel(e.clientX, e.clientY);
    const n = e.dataTransfer?.files?.length || 1;
    if (engine.isPointOverTrash(lx, ly)) {
      engine.onTrashSwallowed(n);
    }
    engine.setFileDrag(false);
  });

  viewport.addEventListener('pointerdown', (e) => {
    if (trashDemoOn) {
      const { lx, ly } = toCatRel(e.clientX, e.clientY);
      if (engine.isPointOverTrash(lx, ly)) {
        engine.onTrashSwallowed(3);
        setTrashDemo(false);
        return;
      }
    }
    if (autoDemoRunning) stopAutoDemo();
    const btnName = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    engine.onMouseDown(btnName);
  });

  window.addEventListener('pointerup', (e) => {
    const btnName = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    engine.onMouseUp(btnName);
  });

  viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  viewport.addEventListener('wheel', () => {
    engine.onMouseWheel();
  }, { passive: true });

  // Kick off gentle live demo on load!
  startAutoDemo();
}

function initMcpCodeTabs(): void {
  const snippets: Record<string, { raw: string; html: string }> = {
    win: {
      raw: `{\n  "mcpServers": {\n    "minicat": {\n      "command": "C:\\\\Users\\\\<你的用户名>\\\\AppData\\\\Local\\\\MiniCat\\\\MiniCat.exe",\n      "args": ["--mcp"]\n    }\n  }\n}`,
      html: `<span class="c-dim">// Windows Stdio 模式（Claude / Cursor / Antigravity 通用）</span>\n{\n  <span class="c-key">"mcpServers"</span>: {\n    <span class="c-key">"minicat"</span>: {\n      <span class="c-key">"command"</span>: <span class="c-str">"C:\\\\Users\\\\&lt;你的用户名&gt;\\\\AppData\\\\Local\\\\MiniCat\\\\MiniCat.exe"</span>,\n      <span class="c-key">"args"</span>: [<span class="c-str">"--mcp"</span>]\n    }\n  }\n}`,
    },
    mac: {
      raw: `{\n  "mcpServers": {\n    "minicat": {\n      "command": "/Applications/MiniCat.app/Contents/MacOS/MiniCat",\n      "args": ["--mcp"]\n    }\n  }\n}`,
      html: `<span class="c-dim">// macOS Stdio 模式（零依赖直连 App 内置二进制）</span>\n{\n  <span class="c-key">"mcpServers"</span>: {\n    <span class="c-key">"minicat"</span>: {\n      <span class="c-key">"command"</span>: <span class="c-str">"/Applications/MiniCat.app/Contents/MacOS/MiniCat"</span>,\n      <span class="c-key">"args"</span>: [<span class="c-str">"--mcp"</span>]\n    }\n  }\n}`,
    },
    http: {
      raw: `{\n  "mcpServers": {\n    "minicat": {\n      "url": "http://127.0.0.1:27420/mcp"\n    }\n  }\n}`,
      html: `<span class="c-dim">// 本机 Streamable HTTP 模式（桌宠运行时直接连接）</span>\n{\n  <span class="c-key">"mcpServers"</span>: {\n    <span class="c-key">"minicat"</span>: {\n      <span class="c-key">"url"</span>: <span class="c-str">"http://127.0.0.1:27420/mcp"</span>\n    }\n  }\n}`,
    },
  };

  let active = 'win';
  const codeEl = document.getElementById('mcp-code');
  const copyBtn = document.getElementById('copy-mcp-btn');

  const render = (key: string) => {
    active = key;
    if (codeEl) codeEl.innerHTML = snippets[key].html;
  };
  render('win');

  document.querySelectorAll('[data-mcp-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = (btn as HTMLElement).dataset.mcpTab || 'win';
      document.querySelectorAll('[data-mcp-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      render(key);
    });
  });

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(snippets[active].raw).then(() => {
        copyBtn.textContent = '已复制 ✓';
        window.setTimeout(() => {
          copyBtn.textContent = '复制配置';
        }, 1600);
      });
    });
  }

  // macOS xattr copy
  const xattrBtn = document.getElementById('copy-xattr-btn');
  if (xattrBtn) {
    xattrBtn.addEventListener('click', () => {
      navigator.clipboard.writeText('xattr -cr /Applications/MiniCat.app').then(() => {
        xattrBtn.textContent = '已复制 ✓';
        window.setTimeout(() => {
          xattrBtn.textContent = '复制命令';
        }, 1600);
      });
    });
  }

  // Prompt chips copy
  document.querySelectorAll('.prompt-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = (chip as HTMLElement).dataset.prompt || '';
      const em = chip.querySelector('em');
      navigator.clipboard.writeText(prompt).then(() => {
        if (em) {
          em.textContent = '已复制 ✓';
          window.setTimeout(() => {
            em.textContent = '复制';
          }, 1500);
        }
      });
    });
  });
}

function bindModal(modal: HTMLElement, openers: HTMLElement[]): { open: (trigger?: HTMLElement) => void } {
  let lastTrigger: HTMLElement | null = null;

  const close = () => {
    modal.hidden = true;
    document.body.style.overflow = '';
    lastTrigger?.focus();
  };

  const open = (trigger?: HTMLElement) => {
    if (trigger) lastTrigger = trigger;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    modal.querySelector<HTMLButtonElement>('[data-modal-close]')?.focus();
  };

  openers.forEach((trigger) => {
    trigger.addEventListener('click', () => open(trigger));
  });

  modal.querySelectorAll('[data-modal-close]').forEach((el) => {
    el.addEventListener('click', close);
  });

  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) close();
  });

  return { open };
}

function initPanModal(): void {
  const modal = document.getElementById('pan-modal');
  const copyBtn = document.getElementById('pan-copy-btn');
  const openers = Array.from(document.querySelectorAll<HTMLElement>('[data-pan-open]'));
  if (!modal || openers.length === 0) return;

  bindModal(modal, openers);

  const shareText =
    '我用夸克网盘给你分享了「小猫键盘」，点击链接或复制整段内容，打开「夸克APP」即可获取。\n链接：https://pan.quark.cn/s/d0c3ab148872';

  copyBtn?.addEventListener('click', async () => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(shareText);
      copied = true;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = shareText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand('copy');
      textarea.remove();
    }
    const original = '复制整段文案';
    copyBtn.textContent = copied ? '已复制 ✓' : '复制失败，请长按链接';
    window.setTimeout(() => {
      copyBtn.textContent = original;
    }, 1800);
  });
}

function initRewardModal(): void {
  const modal = document.getElementById('reward-modal');
  if (!modal) return;

  const openers = Array.from(document.querySelectorAll<HTMLElement>('[data-reward-open]'));
  const skipWrap = document.getElementById('reward-skip-wrap');
  const skipLink = document.getElementById('reward-skip-dl') as HTMLAnchorElement | null;
  const { open } = bindModal(modal, []);

  const resetSkip = () => {
    if (skipWrap) skipWrap.style.display = 'none';
    if (skipLink) {
      skipLink.href = '#';
      skipLink.textContent = '先不打赏，直接下载 →';
    }
  };

  openers.forEach((trigger) => {
    trigger.addEventListener('click', () => {
      resetSkip();
      open(trigger);
    });
  });

  document.querySelectorAll<HTMLAnchorElement>('[data-reward-download]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      const href = trigger.getAttribute('href');
      if (!href) return;
      event.preventDefault();

      const platform = trigger.dataset.platform;
      if (skipLink) {
        skipLink.href = href;
        skipLink.textContent = platform ? `先不打赏，直接下载 ${platform} 版 →` : '先不打赏，直接下载 →';
      }
      skipWrap?.removeAttribute('hidden');
      if (skipWrap) skipWrap.style.display = 'flex';
      open(trigger);
    });
  });

  skipLink?.addEventListener('click', () => {
    modal.hidden = true;
    document.body.style.overflow = '';
  });
}

function initPolish(): void {
  // Pointer specular highlight on stage cards
  document.querySelectorAll('.stage-card').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const ev = e as PointerEvent;
      const rect = card.getBoundingClientRect();
      (card as HTMLElement).style.setProperty('--mx', `${ev.clientX - rect.left}px`);
      (card as HTMLElement).style.setProperty('--my', `${ev.clientY - rect.top}px`);
    });
  });

  // Scroll reveal (low threshold so tall sections on mobile & hash jumps never stay hidden)
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) entry.target.classList.add('visible');
      });
    },
    { threshold: 0.01 }
  );
  document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));

  if (window.location.hash) {
    const target = document.querySelector(window.location.hash);
    if (target) {
      target.classList.add('visible');
      target.closest('.reveal')?.classList.add('visible');
    }
  }
}

applyReleaseUI(DEFAULT_RELEASE_TAG, buildDefaultAssets());
initPlayground();
initMcpCodeTabs();
initPanModal();
initRewardModal();
initPolish();
void syncGithubMetadata();
void initDownloadStats();

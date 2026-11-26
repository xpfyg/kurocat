import {
  KEYBOARD_KEYS_65,
  KEYBOARD_KEYS_108,
  getKeyboardLayout,
  type KeySpec,
  type KeyboardLayoutId,
  formatBubbleForVk,
  resolveKeyByVk,
} from './keyboardLayout';
import { catAudio } from './audio';
import { resolveCustomSkin, type CatSkinConfig, type ResolvedSkin } from './catSkins';
import { DaFeiYuRenderer, type DaFeiYuLayout } from './dafeiyuRenderer';
import { getDeskTheme, type DeskTheme } from './deskThemes';
import { CRITTER_FLAP_SPEED, CRITTER_KINDS, drawCritter, type CritterKind } from './critters';

export const LOGICAL_W = 420;
export const LOGICAL_H = 440;
export type CatBreed = 'black' | 'ragdoll' | 'dafeiyu';
export type KeyboardOrientation = 'cat' | 'viewer';

interface Vec2 {
  x: number;
  y: number;
}

interface SmearFrame {
  sx: number;
  sy: number;
  px: number;
  py: number;
  alpha: number;
}

type PawMode = 'idle' | 'curled' | 'poke' | 'mouse' | 'swat' | 'hold';

interface PawState {
  side: 'left' | 'right';
  shoulderNormY: number; // vertical fraction along spine (0=ear tips, 1=base)
  shoulderHalfX: number;
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  mode: PawMode;
  idleWeight: number;
  curlWeight: number;
  pokeTime: number;
  impactSquash: number;
  lastActiveAt: number;
  smears: SmearFrame[];
}

interface KeyBubble {
  id: number;
  label: string;
  isSpace: boolean;
  x: number;
  targetX: number;
  y: number;
  targetY: number;
  rot: number;
  createdAt: number;
  lifetime: number;
}

interface KeyAnim {
  pressed: boolean;
  pressAmount: number;
  lastHitAt: number;
}

export type CatMood = 'neutral' | 'curious' | 'happy' | 'relaxed' | 'annoyed' | 'sleepy';

interface MusicNoteParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  rot: number;
  rotVel: number;
  size: number;
  glyph: string;
  color: string;
}

interface TypingSpark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: string;
}

// Continuous-typing mood tuning: short thinking pauses keep the streak alive,
// but a real break resets it.
const WORK_ANNOY_SECONDS = 16;
const WORK_TYPING_GAP_MS = 1200;
const WORK_STREAK_BREAK_MS = 4200;

// Extra moods: a nearby cursor makes the cat curious, petting makes it happy,
// and a long stretch without any input makes it sleepy.
const MOOD_SLEEP_IDLE_MS = 45000;
const MOOD_CURIOUS_RADIUS = 120;
const MOOD_CURIOUS_HOLD_MS = 2600;
const MOOD_MIN_DWELL_MS = 350;
const MOOD_ENTER_THRESHOLD = 0.6;
const MOOD_EXIT_THRESHOLD = 0.35;

// Exact measured pixel silhouette half-width profile from original video 0.3s (compact chubby sitting cat!)
// t = 0.0 (ear tips) -> t = 1.0 (bottom base flush on keyboard)
const BODY_SLICES: Array<{ t: number; hw: number }> = [
  { t: 0.12, hw: 49 }, // forehead / ear base
  { t: 0.21, hw: 56 }, // eye line
  { t: 0.30, hw: 60 }, // chubby cheeks widest
  { t: 0.38, hw: 52 }, // gentle neck indent
  { t: 0.47, hw: 54 }, // upper chest
  { t: 0.57, hw: 62 }, // mid chest
  { t: 0.68, hw: 70 }, // plump belly
  { t: 0.79, hw: 73 }, // widest soft thighs!
  { t: 0.90, hw: 69 }, // lower thigh curve
  { t: 0.97, hw: 58 }, // tapers softly inward at base!
  { t: 1.00, hw: 46 }, // cozy bottom rest
];

export class KuroCatEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private lastTime = 0;
  private elapsed = 0;

  public showKeyBubbles = true;
  public privacyMode = false;
  public onAfterRender: (() => void) | null = null;
  public catBreed: CatBreed = 'black';
  public customSkin: ResolvedSkin | null = null;
  public keyboardLayout: KeyboardLayoutId = '65';
  public keyboardOrientation: KeyboardOrientation = 'cat';
  private renderScale = 1.0;
  private embedded = false;
  private dafeiyu = new DaFeiYuRenderer();
  private privacyClose = 0;
  private privacyTypingAt = -10000;
  private lastMouseNX = 0.5;
  private lastDt = 1 / 60;
  private lastDtForFx = 1 / 60;

  // Mood system: music relaxes the cat, endless typing makes it grumpy, petting makes it
  // happy, a nearby cursor sparks curiosity, and a long idle stretch makes it sleepy.
  public mood: CatMood = 'neutral';
  private musicPlaying = false;
  private workTypingSec = 0;
  private relaxAmount = 0;
  private annoyAmount = 0;
  private headphoneAmount = 0;
  private tailWagPhase = 0;
  // Idle tail swish (a decaying traveling wave every few seconds)
  private tailFlick = 0;
  private tailFlickSign = 1;
  private nextTailFlickAt = 2.5;

  // Keyboard + mouse look
  private deskTheme: DeskTheme = getDeskTheme('classic');

  // Flying critter cursor toy: near the cat the cursor turns into a little flier the cat hunts
  public flyingToysEnabled = true;
  private cursorPresent = true;
  private critterActive = false;
  private critterAmount = 0;
  private critterHunt = 0;
  private critterKind: CritterKind = 'butterfly';
  private critterKindIdx = Math.floor(Math.random() * CRITTER_KINDS.length);
  private critterX = 0;
  private critterY = 0;
  private critterVX = 0;
  private critterVY = 0;
  private critterFacing = 1;
  private critterFlap = 0;
  private critterDodgeX = 0;
  private critterDodgeY = 0;
  private critterLastMoveAt = -10000;
  private lastCursorLX = -9999;
  private lastCursorLY = -9999;
  private nextSwatAt = 0;
  private critterFx: Array<{ x: number; y: number; vx: number; vy: number; age: number; life: number; color: string }> = [];

  // Trash can helper: appears while files are dragged; drop to send them to the recycle bin
  private trashWanted = false;
  private trashSide: 1 | -1 = -1;
  private trashCount = 1;
  private trashAmount = 0;
  private trashReach = 0;
  private trashAimY = 0;
  private trashScale = 1;
  private trashLid = 0;
  private trashHover = false;
  private trashGulpT = -1;
  private trashGulpCount = 0;
  private trashWobble = 0;
  private trashHoldUntil = 0;
  private trashPapers: Array<{ x: number; y: number; vx: number; vy: number; rot: number; age: number }> = [];
  private trashFx: Array<{ x: number; y: number; age: number; text: string }> = [];
  private happyAmount = 0;
  private curiousAmount = 0;
  private sleepyAmount = 0;
  private moodPreview: CatMood | null = null;
  private moodChangedAt = -10000;
  private breathPhase = 0;
  private musicNotes: MusicNoteParticle[] = [];
  private moodGlyphs: MusicNoteParticle[] = [];
  private typingSparks: TypingSpark[] = [];
  private nextMusicNoteAt = 0;
  private nextMoodGlyphAt = 0;

  public setMusicPlaying(active: boolean): void {
    if (active && !this.musicPlaying) {
      this.workTypingSec = 0;
    }
    this.musicPlaying = active;
  }

  public setMoodPreview(mood: CatMood | null): void {
    // The whale has its own expression tiers; keep the preview API inert for it.
    this.moodPreview = this.catBreed === 'dafeiyu' ? null : mood;
  }

  public setDeskTheme(id: string): void {
    this.deskTheme = getDeskTheme(id);
  }

  public getDeskThemeId(): string {
    return this.deskTheme.id;
  }

  /** Hosts can report that the pointer left the stage entirely (web playground). */
  public setCursorPresent(present: boolean): void {
    this.cursorPresent = present;
    if (!present) this.critterActive = false;
  }

  public setFlyingToysEnabled(enabled: boolean): void {
    this.flyingToysEnabled = enabled;
    if (!enabled) this.critterActive = false;
  }

  /** True while the cursor is showing as a flying critter (lets hosts hide the real pointer). */
  public isCritterActive(): boolean {
    return this.critterActive && this.critterAmount > 0.3;
  }

  /**
   * Files are being dragged somewhere on screen: pull the trash can out from behind the cat.
   * `side` = which way to hand it ('right' when the cat sits on the left half of the screen).
   */
  public setFileDrag(active: boolean, count = 0, side?: 'left' | 'right'): void {
    if (active) {
      // Hand-off side follows the cursor (left / right of the cat) — see updateTrash().
      void side;
      this.trashWanted = true;
      if (count > 0) this.trashCount = count;
    } else if (this.trashWanted) {
      this.trashWanted = false;
      // Short grace period so a drop event arriving right after mouse-up still lands in the can
      this.trashHoldUntil = Math.max(this.trashHoldUntil, performance.now() + 450);
    }
  }

  public setFileDragCount(count: number): void {
    if (count > 0) this.trashCount = count;
  }

  public isTrashOut(): boolean {
    return this.trashAmount > 0.55;
  }

  public isPointOverTrash(lx: number, ly: number): boolean {
    if (this.trashAmount < 0.55) return false;
    const g = this.getTrashGeom();
    if (g.behind) return false;
    const halfW = g.w * 0.5 + 18;
    const top = g.y - g.h * 0.5 - 30 * g.s;
    const bottom = g.y + g.h * 0.5 + 16;
    return Math.abs(lx - g.x) <= halfW && ly >= top && ly <= bottom;
  }

  /** Whether the live cursor currently hovers the trash can opening. */
  public isCursorOverTrash(): boolean {
    return this.trashHover;
  }

  /** Files were moved to the recycle bin: gulp animation + little "recycled" badge. */
  public onTrashSwallowed(count: number): void {
    const g = this.getTrashGeom();
    this.trashGulpT = 0;
    this.trashGulpCount = count;
    this.trashWobble = 1;
    this.trashHoldUntil = performance.now() + 1250;
    const n = Math.max(1, Math.min(5, count));
    for (let i = 0; i < n; i++) {
      this.trashPapers.push({
        x: g.x + (Math.random() - 0.5) * g.w * 0.6,
        y: g.y - g.h * 0.5 - 34 - i * 12,
        vx: (Math.random() - 0.5) * 30,
        vy: -40 - Math.random() * 40,
        rot: (Math.random() - 0.5) * 1.2,
        age: 0,
      });
    }
    this.trashFx.push({ x: g.x, y: g.y - g.h * 0.5 - 18, age: 0, text: `♻ +${count}` });
    this.earTwitchLeft = 1;
    this.earTwitchRight = 0.8;
    this.spawnMoodGlyph('happy');
  }

  /** Maps CSS pixel coordinates (relative to the canvas) to the engine's logical space. */
  public clientToLogical(cssX: number, cssY: number): { x: number; y: number } {
    const cssW = Math.max(1, this.embedded ? this.canvas.clientWidth || 420 : window.innerWidth);
    const dpr = this.canvas.width / cssW;
    const vt = this.getViewTransform();
    return {
      x: (cssX * dpr - vt.ox) / vt.s,
      y: (cssY * dpr - vt.oy) / vt.s,
    };
  }

  private getViewTransform(): { ox: number; oy: number; s: number } {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (this.embedded) {
      const baseFit = Math.min((cw * 0.86) / this.logicalW, (ch * 0.86) / this.logicalH);
      const effectiveMul = this.renderScale <= 1.0 ? this.renderScale : 1.0 + (this.renderScale - 1.0) * 0.30;
      const s = baseFit * effectiveMul;
      return { ox: (cw - this.logicalW * s) * 0.5, oy: (ch - this.logicalH * s) * 0.52, s };
    }
    const cssW = Math.max(1, window.innerWidth);
    const dpr = cw / cssW;
    const fitScale = Math.min(cw / this.logicalW, ch / this.logicalH);
    const s = Math.min(fitScale, this.renderScale * dpr);
    return { ox: cw - this.logicalW * s, oy: ch - this.logicalH * s, s };
  }

  public setPrivacyMode(active: boolean): void {
    this.privacyMode = active;
    this.dafeiyu.onPrivacyModeChanged(active);
    if (active) {
      this.bubbles.length = 0;
      this.moodGlyphs.length = 0;
      for (const anim of this.keyAnims.values()) {
        anim.pressed = false;
        anim.pressAmount = 0;
      }
    }
  }

  public onPrivacyTyping(): void {
    this.privacyTypingAt = performance.now();
    if (this.catBreed === 'dafeiyu') {
      this.dafeiyu.onPrivacyTyping();
    }
  }

  public setRenderScale(scale: number): void {
    this.renderScale = Math.max(0.2, Math.min(1.5, scale));
  }

  public getLogicalSize(): { w: number; h: number } {
    return { w: this.logicalW, h: this.logicalH };
  }

  private syncLayoutPositions(): void {
    const isBigFish = this.catBreed === 'dafeiyu';
    if (this.keyboardLayout === '108') {
      this.logicalW = 540;
      this.logicalH = 456;
      this.catCenterX = 278;
      this.catTopY = 66;
      this.catBaseY = 292;
      this.kbCenterX = 290;
      this.kbCenterY = 356;
      this.kbWidth = 398;
      this.kbHeight = 96;
      this.kbTiltRad = (2.4 * Math.PI) / 180;
      this.mouseBaseX = isBigFish ? 54 : 46;
      this.mouseBaseY = isBigFish ? 332 : 342;
    } else {
      this.logicalW = 420;
      this.logicalH = 440;
      this.catCenterX = 196;
      this.catTopY = 82;
      this.catBaseY = 308;
      this.kbCenterX = isBigFish ? 234 : 214;
      this.kbCenterY = 353;
      this.kbWidth = 266;
      this.kbHeight = 74;
      this.kbTiltRad = (3.4 * Math.PI) / 180;
      this.mouseBaseX = isBigFish ? 72 : 46;
      this.mouseBaseY = isBigFish ? 322 : 338;
    }
  }

  public setCatAppearance(breedId: string, skin?: CatSkinConfig | null): void {
    if (breedId === 'dafeiyu') {
      this.catBreed = 'dafeiyu';
      this.customSkin = null;
    } else if ((breedId === 'black' || breedId === 'ragdoll') && (!skin || skin.builtin)) {
      this.catBreed = breedId;
      this.customSkin = null;
    } else if (skin) {
      this.catBreed = 'black';
      this.customSkin = resolveCustomSkin(skin);
    } else {
      this.catBreed = 'black';
      this.customSkin = null;
    }
    this.syncLayoutPositions();
  }

  public setKeyboardConfig(layout: KeyboardLayoutId, orientation: KeyboardOrientation): void {
    const nextLayout: KeyboardLayoutId = layout === '108' ? '108' : '65';
    const nextOrientation: KeyboardOrientation = orientation === 'viewer' ? 'viewer' : 'cat';
    const layoutChanged = this.keyboardLayout !== nextLayout;
    this.keyboardLayout = nextLayout;
    this.keyboardOrientation = nextOrientation;

    this.syncLayoutPositions();

    if (layoutChanged) {
      this.leftPaw.pos = { x: this.catCenterX - 18, y: this.catBaseY };
      this.leftPaw.target = { x: this.catCenterX - 18, y: this.catBaseY };
      this.rightPaw.pos = { x: this.catCenterX + 18, y: this.catBaseY };
      this.rightPaw.target = { x: this.catCenterX + 18, y: this.catBaseY };
    }
  }

  private buildDaFeiYuLayout(): DaFeiYuLayout {
    const mx = this.mouseBaseX + this.mouseOffsetX;
    const my = this.mouseBaseY + this.mouseOffsetY;
    const isCatFacing = this.keyboardOrientation === 'cat';
    const localBtnX = this.mouseLeftDown ? -6.5 : this.mouseRightDown ? 6.5 : 0;
    const localBtnY = -10.5;
    const ang = this.kbTiltRad + (isCatFacing ? Math.PI : 0);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    return {
      logicalW: this.logicalW,
      kbCenterX: this.kbCenterX,
      kbCenterY: this.kbCenterY,
      kbWidth: this.kbWidth,
      kbHeight: this.kbHeight,
      kbTiltRad: this.kbTiltRad,
      mouseBtnX: mx + localBtnX * c - localBtnY * s,
      mouseBtnY: my + localBtnX * s + localBtnY * c,
      mouseNX: this.lastMouseNX,
      mouseLeft: this.mouseLeftDown,
      mouseRight: this.mouseRightDown,
      mouseActiveAt: this.lastMouseMoveAt,
      petEnergy: this.petEnergy,
      privacyMode: this.privacyMode,
      privacyTypingAt: this.privacyTypingAt,
      is108: this.keyboardLayout === '108',
    };
  }

  // Dynamic logical proportions (65% compact = 420x440; 108-key full-size = 540x456)
  private logicalW = 420;
  private logicalH = 440;
  private catCenterX = 196;
  private catTopY = 82;
  private catBaseY = 308;
  private readonly catHeight = 226;

  // Mechanical keyboard deck below the sitting cat
  private kbCenterX = 214;
  private kbCenterY = 353;
  private kbWidth = 266;
  private kbHeight = 74;
  private kbTiltRad = (3.4 * Math.PI) / 180;

  // True-scale white oval mouse to the left of keyboard
  private mouseBaseX = 46;
  private mouseBaseY = 338;
  private mouseOffsetX = 0;
  private mouseOffsetY = 0;
  private mouseTargetOffsetX = 0;
  private mouseTargetOffsetY = 0;
  private mouseLeftDown = false;
  private mouseRightDown = false;
  private mouseMiddleDown = false;
  private mouseLeftPress = 0;
  private mouseRightPress = 0;
  private mouseMiddlePress = 0;
  private mouseScrollFlash = 0;
  private lastMouseMoveAt = -10000;
  private mouseBadges: Array<{
    id: number;
    label: string;
    color: string;
    x: number;
    y: number;
    createdAt: number;
    lifetime: number;
  }> = [];

  // Cursor & 100% live eye tracking + 2.5D head turn
  private cursorRelX = 0.5;
  private cursorRelY = 0.5;
  private cursorOverCat = false;
  private eyeLookX = 0;
  private eyeLookY = 0;
  private faceTurnX = 0;

  // Spine-shear deformation state (exact measured flexible cat spine + playful typing body/head sway!)
  private spineLean = 0;    // -1 (mouse lean: head shifts -46px left while hips stay anchored!) .. +1
  private headTilt = 0;
  private typingHunch = 0;  // 0..1 lowers head & rounds posture slightly when typing
  private typingSway = 0;   // -1..+1 lively left-right torso & head sway while typing!
  private typingSwayVel = 0;
  private typingGroovePhase = 0;
  private lastKeyBias = 0;
  private strikeRock = 0;
  private strikeRockVel = 0;
  private bodyBob = 0;
  private kbBounce = 0;

  // Blinking, petting, ear micro-twitch, typing rhythm
  private nextBlinkAt = 2.8;
  private blinkProgress = 0;
  private isBlinking = false;

  private lastPetCursorX: number | null = null;
  private lastPetCursorY: number | null = null;
  private petEnergy = 0;
  private squintAmount = 0;
  private earTwitchLeft = 0;
  private earTwitchRight = 0;
  private nextEarFlickAt = 1.8;
  private recentKeyTimes: number[] = [];
  private typingEnergy = 0;
  private lastAnyKeyAt = -10000;

  // Paws
  private leftPaw: PawState;
  private rightPaw: PawState;
  private lastSpacePaw: 'left' | 'right' = 'left';

  // Keys & bubbles
  private keyAnims = new Map<string, KeyAnim>();
  private bubbles: KeyBubble[] = [];
  private nextBubbleId = 1;
  private kbCacheCanvas: HTMLCanvasElement | null = null;
  private kbCacheKey = '';
  private kbCacheLogW = 0;
  private kbCacheLogH = 0;

  constructor(canvas: HTMLCanvasElement, options?: { embedded?: boolean }) {
    this.canvas = canvas;
    this.embedded = Boolean(options?.embedded);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not initialize 2D canvas context');
    this.ctx = ctx;

    for (const k of KEYBOARD_KEYS_65) {
      this.keyAnims.set(k.id, { pressed: false, pressAmount: 0, lastHitAt: -10000 });
    }
    for (const k of KEYBOARD_KEYS_108) {
      if (!this.keyAnims.has(k.id)) {
        this.keyAnims.set(k.id, { pressed: false, pressAmount: 0, lastHitAt: -10000 });
      }
    }

    this.leftPaw = {
      side: 'left',
      shoulderNormY: 0.50,
      shoulderHalfX: -32,
      pos: { x: this.catCenterX - 18, y: this.catBaseY },
      vel: { x: 0, y: 0 },
      target: { x: this.catCenterX - 18, y: this.catBaseY },
      mode: 'idle',
      idleWeight: 1,
      curlWeight: 0,
      pokeTime: 1,
      impactSquash: 0,
      lastActiveAt: -10000,
      smears: [],
    };

    this.rightPaw = {
      side: 'right',
      shoulderNormY: 0.50,
      shoulderHalfX: 32,
      pos: { x: this.catCenterX + 18, y: this.catBaseY },
      vel: { x: 0, y: 0 },
      target: { x: this.catCenterX + 18, y: this.catBaseY },
      mode: 'idle',
      idleWeight: 1,
      curlWeight: 0,
      pokeTime: 1,
      impactSquash: 0,
      lastActiveAt: -10000,
      smears: [],
    };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  public resize(): void {
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const cssW = Math.max(1, this.embedded ? (this.canvas.clientWidth || 420) : window.innerWidth);
    const cssH = Math.max(1, this.embedded ? (this.canvas.clientHeight || 440) : window.innerHeight);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  private isRenderActive(now: number): boolean {
    return (
      now - this.lastAnyKeyAt < 1800 ||
      now - this.lastMouseMoveAt < 1200 ||
      now - this.privacyTypingAt < 1500 ||
      this.cursorOverCat ||
      this.isBlinking ||
      this.bubbles.length > 0 ||
      this.mouseBadges.length > 0 ||
      this.typingSparks.length > 0 ||
      this.typingEnergy > 0.04 ||
      this.petEnergy > 0.04 ||
      this.annoyAmount > 0.04 ||
      this.relaxAmount > 0.04 ||
      this.earTwitchLeft > 0.01 ||
      this.earTwitchRight > 0.01 ||
      (this.headphoneAmount > 0.01 && this.headphoneAmount < 0.99) ||
      this.musicNotes.length > 0 ||
      this.tailFlick > 0.01 ||
      this.happyAmount > 0.04 ||
      this.curiousAmount > 0.04 ||
      this.critterAmount > 0.01 ||
      this.critterFx.length > 0 ||
      this.trashWanted ||
      this.trashAmount > 0.001 ||
      this.trashPapers.length > 0 ||
      this.trashFx.length > 0 ||
      this.leftPaw.mode !== 'idle' ||
      this.rightPaw.mode !== 'idle' ||
      this.leftPaw.smears.length > 0 ||
      this.rightPaw.smears.length > 0
    );
  }

  public start(): void {
    this.lastTime = performance.now();
    const tick = (now: number) => {
      this.rafId = requestAnimationFrame(tick);
      if (document.hidden) {
        this.lastTime = now;
        return;
      }
      // Adaptive FPS cap: ~60fps when actively typing/moving/animating (prevents 120/144/240Hz
      // oversampling CPU/GPU burn), and ~20fps during calm idle breathing.
      const minFrameMs = this.isRenderActive(now) ? 15.5 : 48;
      const elapsedMs = now - this.lastTime;
      if (elapsedMs < minFrameMs) {
        return;
      }
      const dt = Math.min(0.08, Math.max(0.001, elapsedMs / 1000));
      this.lastTime = now;
      this.update(dt, now);
      this.render();
      if (this.onAfterRender) {
        this.onAfterRender();
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  public stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  // ---- Flexible spine coordinate system (exact match to measured 0.3s -> 2.2s shear!) ----

  private spinePoint(t: number, breath: number): Vec2 {
    // t in [0..1]: 0 = ear tips, 1 = seated base on desk
    const u = Math.max(0, Math.min(1, 1 - t)); // 0 at hips, 1 at head
    const shearCurve = u * u * (3 - 2 * u); // smoothstep from hips up to head!
    // Measured mouse-lean shift (-46px at head) + lively typing left-right body/head sway (+-25px)!
    const leanAmp = this.keyboardLayout === '108' ? 76 : 46;
    const leanX =
      (this.spineLean * leanAmp + this.typingSway * 25 + this.strikeRock * 10) * shearCurve;
    // Gentle music sway when relaxed, tiny frustrated tremble when typing too long.
    const moodSwayX =
      (this.relaxAmount * Math.sin(this.elapsed * 2.2) * 4.5 +
        this.annoyAmount * Math.sin(this.elapsed * 15) * 1.3) *
      shearCurve;
    const swayDipY = Math.abs(this.typingSway) * 4.0 * shearCurve;
    const hunchY = (this.typingHunch * 13 + this.bodyBob * 4.8 + breath) * shearCurve + swayDipY;
    // Slight forward drop when leaning deeply to the mouse
    const leanDropY = Math.abs(this.spineLean) * 6 * shearCurve;
    return {
      x: this.catCenterX + leanX + moodSwayX,
      y: this.catTopY + t * this.catHeight + hunchY + leanDropY,
    };
  }

  private getLiveShoulder(paw: PawState, breath: number): Vec2 {
    const sp = this.spinePoint(paw.shoulderNormY, breath);
    return {
      x: sp.x + paw.shoulderHalfX,
      y: sp.y,
    };
  }

  private getLiveCurledPawPos(paw: PawState, breath: number): Vec2 {
    // Bent forearm elbow -> cute curled paw sitting near lower belly (matches 8.3s / 10.6s!)
    const sp = this.spinePoint(0.84, breath);
    const bob = Math.sin(this.elapsed * 12 + (paw.side === 'left' ? 0 : Math.PI)) * (1.5 + this.typingEnergy * 2.0);
    const xOff = paw.side === 'left' ? -24 : 24;
    return {
      x: sp.x + xOff,
      y: sp.y + bob,
    };
  }

  // ---- Input event handlers ----

  public onKeyDown(vk: number, repeat: boolean): void {
    if (this.privacyMode) {
      if (!repeat) this.onPrivacyTyping();
      return;
    }
    const now = performance.now();
    const spec = resolveKeyByVk(vk, this.keyboardLayout);
    if (!spec) return;

    const anim = this.keyAnims.get(spec.id);
    if (anim) {
      anim.pressed = true;
      anim.pressAmount = 1;
      anim.lastHitAt = now;
    }

    if (repeat) return;

    this.lastAnyKeyAt = now;
    this.recentKeyTimes.push(now);
    if (this.recentKeyTimes.length > 26) this.recentKeyTimes.shift();

    this.bodyBob = Math.min(1.15, this.bodyBob + 0.65 * (1 + this.annoyAmount * 0.4));
    this.kbBounce = Math.min(1, this.kbBounce + 0.45 * (1 + this.annoyAmount * 0.55));

    if (this.catBreed === 'dafeiyu') {
      const pt = this.getKeyWorldCenter(spec);
      this.dafeiyu.onKeyDown(vk, pt, this.buildDaFeiYuLayout(), repeat);
      if (this.showKeyBubbles) {
        const label = formatBubbleForVk(vk, spec);
        if (label) {
          this.spawnBubble(label, spec.id === 'space', pt.x, now);
        }
      }
      return;
    }

    if (Math.random() < 0.24) {
      if (Math.random() < 0.5) this.earTwitchLeft = Math.max(this.earTwitchLeft, 0.85);
      else this.earTwitchRight = Math.max(this.earTwitchRight, 0.85);
    }

    const layout = getKeyboardLayout(this.keyboardLayout);
    const isCatFacing = this.keyboardOrientation === 'cat';
    const keyColCenter = spec.uStart + spec.uWidth * 0.5;
    const screenKeyCol = isCatFacing ? layout.totalUnits - keyColCenter : keyColCenter;
    const midCol = layout.totalUnits * 0.5;
    const keyBias = Math.max(-1, Math.min(1, (screenKeyCol - midCol) / (layout.totalUnits * 0.34)));
    this.lastKeyBias = keyBias;
    this.typingGroovePhase += 1.22;

    let targetPoint = this.getKeyWorldCenter(spec);
    let chosen: PawState;

    const activelyMousing = this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 320;
    const splitCol =
      this.keyboardLayout === '108'
        ? isCatFacing
          ? 12.2
          : 8.4
        : 7.5;

    if (spec.id === 'space') {
      if (activelyMousing) {
        chosen = this.rightPaw;
      } else {
        this.lastSpacePaw = this.lastSpacePaw === 'left' ? 'right' : 'left';
        chosen = this.lastSpacePaw === 'left' ? this.leftPaw : this.rightPaw;
      }
      const spaceU = isCatFacing
        ? chosen.side === 'left'
          ? spec.uStart + spec.uWidth * 0.68
          : spec.uStart + spec.uWidth * 0.32
        : chosen.side === 'left'
          ? spec.uStart + spec.uWidth * 0.32
          : spec.uStart + spec.uWidth * 0.68;
      const rY = spec.rowY ?? spec.row;
      targetPoint = this.projectKeyboardPoint(spaceU, rY + 0.50);
    } else if (activelyMousing) {
      chosen = this.rightPaw;
    } else if (screenKeyCol < splitCol) {
      chosen = this.leftPaw;
    } else {
      chosen = this.rightPaw;
    }

    if (chosen.mode === 'hold') {
      chosen = chosen.side === 'left' ? this.rightPaw : this.leftPaw;
    }
    const sideSign = chosen.side === 'left' ? -1 : 1;
    this.strikeRockVel +=
      sideSign * (1.75 + this.typingEnergy * 1.25) * (1 + this.annoyAmount * 0.5);
    if (!activelyMousing) {
      // Lively groove impulse: rocks head & upper body back and forth as the cat types!
      this.typingSwayVel += (keyBias * 2.1 + Math.cos(this.typingGroovePhase) * 1.65) * (0.9 + this.typingEnergy * 0.45);
    }

    const prevShoulder = this.getLiveShoulder(chosen, 0);
    if (chosen.mode === 'poke' && Math.hypot(targetPoint.x - chosen.pos.x, targetPoint.y - chosen.pos.y) > 22) {
      chosen.smears.push({
        sx: prevShoulder.x,
        sy: prevShoulder.y,
        px: chosen.pos.x,
        py: chosen.pos.y,
        alpha: 0.28,
      });
      if (chosen.smears.length > 3) chosen.smears.shift();
    }

    if (chosen.mode === 'curled' || chosen.mode === 'idle') {
      const startPt = this.getLiveCurledPawPos(chosen, 0);
      chosen.pos = { x: startPt.x, y: startPt.y };
      chosen.vel = { x: 0, y: 0 };
    }
    chosen.mode = 'poke';
    chosen.target = this.clampToKeyboardSurface(targetPoint);
    chosen.pokeTime = 0;
    chosen.impactSquash = 0.85;
    chosen.lastActiveAt = now;

    const other = chosen.side === 'left' ? this.rightPaw : this.leftPaw;
    if (other.mode === 'idle' && !activelyMousing) {
      other.mode = 'curled';
      other.lastActiveAt = now;
    }

    if (this.showKeyBubbles) {
      const label = formatBubbleForVk(vk, spec);
      if (label) {
        this.spawnBubble(label, spec.id === 'space', targetPoint.x, now);
      }
    }
    // Frustrated fast typing throws tiny sparks off the struck keycap.
    if (this.annoyAmount > 0.35) {
      this.spawnTypingSparks(targetPoint.x, targetPoint.y);
    }
  }

  public onKeyUp(vk: number): void {
    this.dafeiyu.onKeyUp(vk);
    if (this.privacyMode) return;
    const spec = resolveKeyByVk(vk, this.keyboardLayout);
    if (!spec) return;
    const anim = this.keyAnims.get(spec.id);
    if (anim) anim.pressed = false;
  }

  public onGlobalMouseMove(nx: number, ny: number): void {
    const now = performance.now();
    this.lastMouseNX = nx;
    this.mouseTargetOffsetX = (nx - 0.5) * (this.catBreed === 'dafeiyu' ? 14 : 28);
    this.mouseTargetOffsetY = (ny - 0.5) * (this.catBreed === 'dafeiyu' ? 11 : 20);
    this.lastMouseMoveAt = now;

    // While hunting a flying critter or holding the trash can, the left paw stays busy.
    if (this.critterActive || this.leftPaw.mode === 'hold') return;
    this.leftPaw.mode = 'mouse';
    this.leftPaw.lastActiveAt = now;
  }

  private getMouseButtonColors(): { left: string; right: string; middle: string } {
    const primary = this.customSkin
      ? this.customSkin.accentColor
      : this.catBreed === 'dafeiyu'
        ? '#5cc8ff'
        : this.catBreed === 'ragdoll'
          ? '#7ac7ff'
          : '#d4f044';
    const scroll = this.customSkin
      ? this.customSkin.accentSideColor
      : this.catBreed === 'dafeiyu'
        ? '#2563eb'
        : this.catBreed === 'ragdoll'
          ? '#4690d8'
          : '#92ba12';

    // Pick a high-contrast complementary color for RMB so Left vs Right click are unmistakable on every skin
    const isWarmAccent = /^#(f[a-f0-9][89a-c]|ff[789a-c]|e[89a-f][789a])/i.test(primary);
    const rightColor = isWarmAccent ? '#58c7ff' : '#ff7b3b';
    return { left: primary, right: rightColor, middle: scroll };
  }

  private spawnMouseBadge(button: 'left' | 'right' | 'middle', now: number): void {
    if (!this.showKeyBubbles) return;
    const colors = this.getMouseButtonColors();
    const label = button === 'left' ? 'LMB' : button === 'right' ? 'RMB' : 'MMB';
    const color = button === 'left' ? colors.left : button === 'right' ? colors.right : colors.middle;
    const mx = this.mouseBaseX + this.mouseOffsetX;
    const my = this.mouseBaseY + this.mouseOffsetY;
    const isCatFacing = this.keyboardOrientation === 'cat';
    const sideShift =
      button === 'left'
        ? isCatFacing
          ? 10
          : -10
        : button === 'right'
          ? isCatFacing
            ? -10
            : 10
          : 0;

    if (this.mouseBadges.length >= 2) {
      this.mouseBadges.shift();
    }
    this.mouseBadges.push({
      id: this.nextBubbleId++,
      label,
      color,
      x: Math.max(24, mx + sideShift),
      y: my - 30,
      createdAt: now,
      lifetime: 560,
    });
  }

  public onMouseDown(button: string): void {
    const now = performance.now();
    if (button === 'left') {
      this.mouseLeftDown = true;
      this.mouseLeftPress = 1;
      this.spawnMouseBadge('left', now);
    } else if (button === 'right') {
      this.mouseRightDown = true;
      this.mouseRightPress = 1;
      this.spawnMouseBadge('right', now);
    } else if (button === 'middle') {
      this.mouseMiddleDown = true;
      this.mouseMiddlePress = 1;
      this.spawnMouseBadge('middle', now);
    }

    this.lastMouseMoveAt = now;
    this.dafeiyu.resetLeftHandForMouse();
    if (this.leftPaw.mode === 'hold') return;
    this.leftPaw.mode = 'mouse';
    this.leftPaw.impactSquash = 0.72;
    this.leftPaw.lastActiveAt = now;
  }

  public onMouseUp(button: string): void {
    if (button === 'left') this.mouseLeftDown = false;
    else if (button === 'right') this.mouseRightDown = false;
    else if (button === 'middle') this.mouseMiddleDown = false;
  }

  public onMouseWheel(): void {
    const now = performance.now();
    this.mouseScrollFlash = 1;
    this.lastMouseMoveAt = now;
    this.dafeiyu.resetLeftHandForMouse();
    if (this.leftPaw.mode === 'hold') return;
    this.leftPaw.mode = 'mouse';
    this.leftPaw.lastActiveAt = now;
  }

  public onWindowCursor(relX: number, relY: number, overCat: boolean): void {
    this.cursorRelX = relX;
    this.cursorRelY = relY;
    this.cursorOverCat = overCat;

    if (overCat && !this.mouseLeftDown && !this.mouseRightDown) {
      const px = relX * this.logicalW;
      const py = relY * this.logicalH;
      if (this.lastPetCursorX !== null && this.lastPetCursorY !== null) {
        const dist = Math.hypot(px - this.lastPetCursorX, py - this.lastPetCursorY);
        if (dist > 1.5 && dist < 80) {
          this.petEnergy = Math.min(1, this.petEnergy + dist * 0.011);
        }
      }
      this.lastPetCursorX = px;
      this.lastPetCursorY = py;
    } else {
      this.lastPetCursorX = null;
      this.lastPetCursorY = null;
    }
  }

  // ---- Keyboard projection ----

  private projectKeyboardPoint(uCol: number, rowPos: number): Vec2 {
    const layout = getKeyboardLayout(this.keyboardLayout);
    const isCatFacing = this.keyboardOrientation === 'cat';
    const screenU = isCatFacing ? layout.totalUnits - uCol : uCol;
    const screenRow = isCatFacing ? layout.totalRows - rowPos : rowPos;

    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;
    const localX = -innerW / 2 + (screenU / layout.totalUnits) * innerW;
    const localY = -innerH / 2 + (screenRow / layout.totalRows) * innerH;

    const depthFactor = 0.94 + (screenRow / layout.totalRows) * 0.09;
    const px = localX * depthFactor;
    const py = localY;

    const cos = Math.cos(this.kbTiltRad);
    const sin = Math.sin(this.kbTiltRad);
    return {
      x: this.kbCenterX + px * cos - py * sin,
      y: this.kbCenterY + px * sin + py * cos,
    };
  }

  private getKeyWorldCenter(spec: KeySpec): Vec2 {
    const layout = getKeyboardLayout(this.keyboardLayout);
    const isCatFacing = this.keyboardOrientation === 'cat';
    const uClamped = Math.max(0.65, Math.min(layout.totalUnits - 0.65, spec.uStart + spec.uWidth * 0.5));
    const rY = spec.rowY ?? spec.row;
    const rSpan = spec.rowSpan ?? 1;
    let rowPos = rY + rSpan * 0.5;
    if (isCatFacing && rY <= 0.1) {
      rowPos = rY + 0.68;
    } else if (!isCatFacing && rY + rSpan >= layout.totalRows - 0.1) {
      rowPos = rY + rSpan - 0.68;
    }
    return this.projectKeyboardPoint(uClamped, rowPos);
  }

  private clampToKeyboardSurface(pt: Vec2): Vec2 {
    // Transform into keyboard-local space and clamp so the plump paw pad NEVER extends past the keyboard bezel!
    const dx = pt.x - this.kbCenterX;
    const dy = pt.y - this.kbCenterY;
    const cos = Math.cos(-this.kbTiltRad);
    const sin = Math.sin(-this.kbTiltRad);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;

    const maxX = this.kbWidth * 0.5 - 15;
    const minY = -this.kbHeight * 0.5 + 8;
    const maxY = this.kbHeight * 0.5 - 14;
    const cx = Math.max(-maxX, Math.min(maxX, lx));
    const cy = Math.max(minY, Math.min(maxY, ly));

    const rcos = Math.cos(this.kbTiltRad);
    const rsin = Math.sin(this.kbTiltRad);
    return {
      x: this.kbCenterX + cx * rcos - cy * rsin,
      y: this.kbCenterY + cx * rsin + cy * rcos,
    };
  }

  private spawnBubble(label: string, isSpace: boolean, keyX: number, now: number): void {
    if (this.bubbles.length >= 6) {
      this.bubbles.shift();
    }
    const minX = this.keyboardLayout === '108' ? 145 : 125;
    const maxX = this.logicalW - 105;
    const baseX = Math.max(minX, Math.min(maxX, keyX * 0.45 + this.kbCenterX * 0.55));
    const staggerY = 258 + ((this.nextBubbleId % 3) - 1) * 10 + (Math.random() - 0.5) * 6;
    this.bubbles.push({
      id: this.nextBubbleId++,
      label,
      isSpace,
      x: baseX,
      targetX: baseX,
      y: 292,
      targetY: staggerY,
      rot: ((Math.random() - 0.5) * 4.5 * Math.PI) / 180,
      createdAt: now,
      lifetime: 940 * (1 - this.annoyAmount * 0.26),
    });
    this.layoutBubbles();
  }

  private layoutBubbles(): void {
    const count = this.bubbles.length;
    if (count === 0) return;

    const widths = this.bubbles.map((b) => (b.isSpace ? 40 : Math.max(25, b.label.length * 7.5 + 14)));
    const gap = 3.5;
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (count - 1);
    const anchor = this.kbCenterX + 12;
    const leftBound = this.keyboardLayout === '108' ? 140 : 126;
    const rightBound = this.logicalW - 82;
    let cursor = Math.max(leftBound, Math.min(rightBound - totalW, anchor - totalW * 0.5));

    for (let i = 0; i < count; i++) {
      const w = widths[i];
      this.bubbles[i].targetX = cursor + w * 0.5;
      cursor += w + gap;
    }
  }

  // ---- Mood particles & overlays (music notes / anger mark / typing sparks) ----

  private spawnMusicNote(): void {
    const head = this.spinePoint(0.10, 0);
    const glyphs = ['♪', '♫', '♬'];
    const colors = ['#ff9fc6', '#bfa4ff', '#ffc0d9'];
    this.musicNotes.push({
      x: head.x + (Math.random() - 0.5) * 62,
      y: head.y - 4 - Math.random() * 12,
      vx: (Math.random() - 0.5) * 10,
      vy: -16 - Math.random() * 10,
      age: 0,
      life: 2.1 + Math.random() * 1.0,
      rot: (Math.random() - 0.5) * 0.5,
      rotVel: (Math.random() - 0.5) * 1.4,
      size: 14 + Math.random() * 6,
      glyph: glyphs[Math.floor(Math.random() * glyphs.length)],
      color: colors[Math.floor(Math.random() * colors.length)],
    });
    if (this.musicNotes.length > 12) this.musicNotes.shift();
  }

  private spawnMoodGlyph(kind: 'sleepy' | 'happy' | 'curious'): void {
    const head = this.spinePoint(0.10, 0);
    const base = {
      age: 0,
      rot: (Math.random() - 0.5) * 0.35,
      rotVel: (Math.random() - 0.5) * 1.1,
      size: 11 + Math.random() * 5,
    };
    if (kind === 'sleepy') {
      this.moodGlyphs.push({
        ...base,
        x: head.x + 30 + Math.random() * 26,
        y: head.y - 18 - Math.random() * 10,
        vx: 4 + Math.random() * 6,
        vy: -12 - Math.random() * 6,
        life: 2.4 + Math.random() * 0.8,
        glyph: Math.random() < 0.5 ? 'z' : 'Z',
        color: '#a9c5dd',
      });
    } else if (kind === 'happy') {
      this.moodGlyphs.push({
        ...base,
        x: head.x + (Math.random() - 0.5) * 54,
        y: head.y - 22 - Math.random() * 10,
        vx: (Math.random() - 0.5) * 8,
        vy: -18 - Math.random() * 8,
        life: 1.8 + Math.random() * 0.8,
        glyph: Math.random() < 0.7 ? '♥' : '♡',
        color: '#ff8fab',
      });
    } else {
      this.moodGlyphs.push({
        ...base,
        x: head.x + 46 + Math.random() * 8,
        y: head.y - 26 - Math.random() * 6,
        vx: 5 + Math.random() * 5,
        vy: -8 - Math.random() * 4,
        life: 1.7 + Math.random() * 0.6,
        glyph: '?',
        color: '#7fb3ff',
      });
    }
    if (this.moodGlyphs.length > 10) this.moodGlyphs.shift();
  }

  private spawnTypingSparks(x: number, y: number): void {
    const count = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const speed = 55 + Math.random() * 80;
      this.typingSparks.push({
        x,
        y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        age: 0,
        life: 0.24 + Math.random() * 0.18,
        size: 0.75 + Math.random() * 0.5,
        color: Math.random() < 0.5 ? '#ffb36b' : '#ff7d6a',
      });
    }
    if (this.typingSparks.length > 28) {
      this.typingSparks.splice(0, this.typingSparks.length - 28);
    }
  }

  private updateMoodParticles(dt: number): void {
    for (const n of this.musicNotes) {
      n.age += dt;
      n.x += (n.vx + Math.sin(n.age * 2.6) * 9) * dt;
      n.y += n.vy * dt;
      n.rot += n.rotVel * dt;
    }
    this.musicNotes = this.musicNotes.filter((n) => n.age < n.life);

    for (const n of this.moodGlyphs) {
      n.age += dt;
      n.x += (n.vx + Math.sin(n.age * 2.2) * 7) * dt;
      n.y += n.vy * dt;
      n.rot += n.rotVel * dt;
    }
    this.moodGlyphs = this.moodGlyphs.filter((n) => n.age < n.life);

    for (const s of this.typingSparks) {
      s.age += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 160 * dt;
    }
    this.typingSparks = this.typingSparks.filter((s) => s.age < s.life);
  }

  private drawMusicNotes(ctx: CanvasRenderingContext2D): void {
    this.drawFloatingGlyphs(ctx, this.musicNotes, 'rgba(255, 255, 255, 0.85)', 6);
  }

  private drawMoodGlyphs(ctx: CanvasRenderingContext2D): void {
    this.drawFloatingGlyphs(ctx, this.moodGlyphs, 'rgba(255, 255, 255, 0.4)', 4);
  }

  private drawFloatingGlyphs(
    ctx: CanvasRenderingContext2D,
    glyphs: MusicNoteParticle[],
    shadowColor: string,
    shadowBlur: number,
  ): void {
    for (const n of glyphs) {
      const t = n.age / n.life;
      const alpha = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.5) / 0.5);
      if (alpha <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(n.x, n.y);
      ctx.rotate(n.rot);
      ctx.font = `700 ${n.size.toFixed(1)}px "Apple Symbols", "Segoe UI Symbol", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = n.color;
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = shadowBlur;
      ctx.fillText(n.glyph, 0, 0);
      ctx.restore();
    }
  }

  private drawTypingSparks(ctx: CanvasRenderingContext2D): void {
    for (const s of this.typingSparks) {
      const alpha = Math.max(0, 1 - s.age / s.life);
      if (alpha <= 0.02) continue;
      ctx.save();
      ctx.globalAlpha = alpha * 0.9;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6 * s.size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x - s.vx * 0.016, s.y - s.vy * 0.016);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawAngerMark(ctx: CanvasRenderingContext2D, breath: number): void {
    const a = this.annoyAmount;
    if (a < 0.12) return;
    const head = this.spinePoint(0.18, breath);
    const pulse = 0.92 + Math.sin(this.elapsed * 9) * 0.1;
    const s = (0.72 + a * 0.55) * pulse;
    const x = head.x + 48 + Math.sin(this.elapsed * 2.8) * 1.4;
    const y = head.y - 26;
    ctx.save();
    ctx.globalAlpha = Math.min(1, a * 1.15);
    ctx.strokeStyle = '#ff5f4d';
    ctx.lineWidth = 2.6 * s;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(255, 74, 58, 0.6)';
    ctx.shadowBlur = 5;
    for (const [dx, dy] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * 3.4 * s, y + dy * 3.4 * s);
      ctx.quadraticCurveTo(
        x + (dx * 7.4 + dy * 1.3) * s,
        y + (dy * 7.4 - dx * 1.3) * s,
        x + dx * 10.6 * s,
        y + dy * 10.6 * s,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawMoodEffects(ctx: CanvasRenderingContext2D, breath: number): void {
    if (this.privacyMode) return;
    this.drawTypingSparks(ctx);
    this.drawMusicNotes(ctx);
    this.drawMoodGlyphs(ctx);
    this.drawAngerMark(ctx, breath);
  }

  private drawMoodBlush(ctx: CanvasRenderingContext2D, cx: number, color: string): void {
    const a = Math.max(0, this.relaxAmount * (1 - this.annoyAmount));
    if (a < 0.03) return;
    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 7;
    ctx.globalAlpha = Math.min(1, a) * 0.48;
    ctx.beginPath();
    ctx.ellipse(cx - 30, 13.5, 11, 5.8, -0.08, 0, Math.PI * 2);
    ctx.ellipse(cx + 30, 13.5, 11, 5.8, 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = Math.min(1, a) * 0.32;
    ctx.beginPath();
    ctx.ellipse(cx - 30, 13.5, 7, 3.6, -0.08, 0, Math.PI * 2);
    ctx.ellipse(cx + 30, 13.5, 7, 3.6, 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawAngryBrows(ctx: CanvasRenderingContext2D, cx: number, ink: string): void {
    const a = this.annoyAmount;
    if (a < 0.12) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, a * 1.1);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3.0;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 35, -25.5);
    ctx.lineTo(cx - 11, -18.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 35, -25.5);
    ctx.lineTo(cx + 11, -18.5);
    ctx.stroke();
    ctx.globalAlpha *= 0.6;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx - 3.5, -27.5);
    ctx.lineTo(cx - 2.5, -22.5);
    ctx.moveTo(cx + 3.5, -27.5);
    ctx.lineTo(cx + 2.5, -22.5);
    ctx.stroke();
    ctx.restore();
  }

  private getEarPose(sideSign: -1 | 1): {
    x: number;
    y: number;
    rot: number;
    scaleX: number;
    scaleY: number;
    tipBend: number;
  } {
    const rawTwitch = sideSign === -1 ? this.earTwitchLeft : this.earTwitchRight;
    // Snappy organic feline ear flick (fast whip with a subtle secondary flutter)
    const flick =
      rawTwitch > 0.001
        ? Math.sin(rawTwitch * Math.PI) * (1 + 0.34 * Math.sin(rawTwitch * Math.PI * 2.5))
        : 0;

    // Headphones press the ears down and fold them cleanly outward under the headband!
    const hp = this.headphoneAmount;
    const hpEase = 1 - Math.pow(1 - hp, 2.5);
    const freeFactor = 1 - hpEase * 0.85;

    // Subtle radar-ear tracking toward the cursor (the ear on the cursor's side perks slightly)
    const lookBias = Math.max(-1, Math.min(1, this.eyeLookX / 6.5));
    const radarPerk = Math.max(0, lookBias * sideSign) * freeFactor;

    // Soft elastic secondary motion from typing bounce, head sway inertia, and gentle idle breathing
    const idleFloat = Math.sin(this.elapsed * 1.9 + sideSign * 0.8) * 0.022 * freeFactor;
    const swayInertia = Math.max(-0.14, Math.min(0.14, -this.typingSwayVel * 0.015)) * freeFactor;
    const bobFlatten = this.bodyBob * 0.075 * freeFactor;
    const petFold =
      (this.squintAmount * 0.22 +
        Math.sin(this.elapsed * 14 + sideSign) * 0.022 * this.squintAmount) *
      freeFactor;
    const annoyFold =
      (this.annoyAmount * 0.42 +
        Math.sin(this.elapsed * 26 + sideSign) * 0.024 * this.annoyAmount) *
      freeFactor;
    const sleepyDroop = this.sleepyAmount * 0.24 * freeFactor;
    const curiousPerk = (this.curiousAmount * 0.14 + this.critterHunt * 0.12) * freeFactor;

    const x =
      sideSign * (33 + hpEase * 5.2 + this.annoyAmount * 2.2 * freeFactor) +
      this.faceTurnX * 0.18;
    const y =
      -28 +
      hpEase * 12.8 +
      this.annoyAmount * 6.0 * freeFactor +
      this.sleepyAmount * 2.8 * freeFactor +
      this.squintAmount * 2.2 * freeFactor -
      this.curiousAmount * 3.2 * freeFactor -
      radarPerk * 1.8 -
      flick * 1.4 * freeFactor +
      this.bodyBob * 1.2 * freeFactor;

    const rot =
      sideSign *
        (0.08 +
          hpEase * 0.58 +
          flick * 0.24 * freeFactor +
          annoyFold +
          petFold +
          sleepyDroop +
          bobFlatten -
          curiousPerk -
          radarPerk * 0.08 +
          idleFloat) +
      swayInertia;

    const scaleX = 1 + hpEase * 0.08 + this.bodyBob * 0.025 * freeFactor;
    const scaleY =
      1 -
      hpEase * 0.36 +
      this.curiousAmount * 0.07 * freeFactor +
      radarPerk * 0.03 -
      this.bodyBob * 0.045 * freeFactor -
      this.annoyAmount * 0.06 * freeFactor;

    // Flexible ear-tip bend so the tip itself curls/whips smoothly instead of rotating like a rigid triangle
    const tipBend =
      sideSign * (flick * 4.8 * freeFactor + hpEase * 3.8 + annoyFold * 3.0) +
      swayInertia * 16;

    return { x, y, rot, scaleX, scaleY, tipBend };
  }

  private drawHeadphones(
    ctx: CanvasRenderingContext2D,
    isDarkBase: boolean,
    accentColor: string,
  ): void {
    const hp = this.headphoneAmount;
    if (hp < 0.01) return;

    const ease = 1 - Math.pow(1 - hp, 3);
    const dropY = -(1 - ease) * 20;
    const scale = 0.88 + 0.12 * ease;
    const shiftX = this.faceTurnX * 0.28;
    const beatPulse =
      this.relaxAmount > 0.1
        ? Math.pow(Math.max(0, Math.sin(this.elapsed * 4.4)), 4) * this.relaxAmount
        : 0;

    const bandOutline = isDarkBase ? '#0d0e12' : '#4a433e';
    const bandMain = isDarkBase ? '#2e3340' : '#f4f1ea';
    const bandHighlight = isDarkBase ? 'rgba(225, 232, 245, 0.42)' : 'rgba(255, 255, 255, 0.88)';
    const cushionColor = isDarkBase ? '#414756' : '#6c635c';
    const shellTop = isDarkBase ? '#3b4150' : '#fbf9f5';
    const shellBot = isDarkBase ? '#1f232c' : '#d6d0c6';
    const rimStroke = isDarkBase ? 'rgba(226, 234, 246, 0.55)' : '#4a433e';

    ctx.save();
    ctx.globalAlpha = Math.min(1, hp * 1.45);
    ctx.translate(shiftX, dropY);
    ctx.scale(scale, scale);

    // 1) Over-head arch band (sits cleanly over the crown while cute cat ear tips poke above!)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.save();
    ctx.shadowColor = 'rgba(12, 14, 20, 0.28)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1.5;
    ctx.strokeStyle = bandOutline;
    ctx.lineWidth = 10.6;
    ctx.beginPath();
    ctx.moveTo(-55, -8);
    ctx.bezierCurveTo(-52, -48, 52, -48, 55, -8);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = bandMain;
    ctx.lineWidth = 7.4;
    ctx.beginPath();
    ctx.moveTo(-55, -8);
    ctx.bezierCurveTo(-52, -48, 52, -48, 55, -8);
    ctx.stroke();

    // Soft colored inner cushion pad at top center of headband
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(-21, -34.2);
    ctx.quadraticCurveTo(0, -37.2, 21, -34.2);
    ctx.stroke();

    // Specular sheen along top crest of headband
    ctx.strokeStyle = bandHighlight;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-36, -32.2);
    ctx.bezierCurveTo(-20, -41.5, 20, -41.5, 36, -32.2);
    ctx.stroke();

    // 2) Left & right plush over-ear studio cups
    for (const side of [-1, 1] as const) {
      const foreshorten = 1 + -side * Math.max(-0.14, Math.min(0.14, this.faceTurnX * 0.011));
      ctx.save();
      ctx.translate(side * 56, 1);
      ctx.rotate(side * -0.08);
      ctx.scale(foreshorten, 1);

      // Metallic yoke hinge joining headband to cup
      ctx.fillStyle = isDarkBase ? '#5a6275' : '#9c948b';
      ctx.strokeStyle = bandOutline;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.roundRect(-3.2, -17.5, 6.4, 6.5, 2.2);
      ctx.fill();
      ctx.stroke();

      // Plush inner ear cushion hugging the cat's cheek
      ctx.fillStyle = cushionColor;
      ctx.strokeStyle = bandOutline;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(side * -3.6, 0, 6.0, 15.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Outer rounded earcup housing with subtle 3D gradient
      const shellGrad = ctx.createLinearGradient(0, -14, 0, 14);
      shellGrad.addColorStop(0.0, shellTop);
      shellGrad.addColorStop(1.0, shellBot);
      ctx.save();
      ctx.shadowColor = 'rgba(12, 14, 20, 0.30)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1.5;
      ctx.fillStyle = shellGrad;
      ctx.beginPath();
      ctx.ellipse(side * 1.4, 0, 7.6, 14.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = rimStroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(side * 1.4, 0, 7.6, 14.4, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Signature glowing accent ring / LED stripe on outer shell (pulses gently with music!)
      ctx.save();
      if (beatPulse > 0.05) {
        ctx.shadowColor = accentColor;
        ctx.shadowBlur = 6 + beatPulse * 7;
      }
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 2.4 + beatPulse * 0.6;
      ctx.beginPath();
      ctx.ellipse(side * 3.0, 0, 3.0, 8.2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Crisp upper glossy highlight on outer shell
      ctx.fillStyle = isDarkBase ? 'rgba(255, 255, 255, 0.24)' : 'rgba(255, 255, 255, 0.72)';
      ctx.beginPath();
      ctx.ellipse(side * 0.4, -7.2, 2.2, 4.2, side * -0.22, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    ctx.restore();
  }

  // ---- Idle tail swish ----

  private updateTailFlick(): void {
    this.tailFlick = Math.max(0, this.tailFlick - this.lastDtForFx * 1.45);
    if (this.elapsed >= this.nextTailFlickAt) {
      if (!this.privacyMode && this.annoyAmount < 0.3) {
        this.tailFlick = 1;
        this.tailFlickSign = Math.random() < 0.5 ? -1 : 1;
      }
      this.nextTailFlickAt =
        this.elapsed + (this.sleepyAmount > 0.5 ? 7 + Math.random() * 6 : 2.6 + Math.random() * 4.4);
    }
  }

  // ---- Trash can helper ----

  private getTrashGeom(): {
    x: number;
    y: number;
    w: number;
    h: number;
    s: number;
    rot: number;
    behind: boolean;
    side: 1 | -1;
  } {
    const side = this.trashSide;
    const s = this.trashScale;
    const w = 34 * s;
    const h = 40 * s;
    const cx = this.catCenterX;
    const reach = this.trashReach;
    // Closest hand-off sits beside the chest; the furthest is capped so the can never leaves the window.
    const minDX = 86;
    const maxDX = this.keyboardLayout === '108' ? 176 : 158;
    const margin = w * 0.5 + 10;
    const finalX = Math.max(margin, Math.min(this.logicalW - margin, cx + side * (minDX + (maxDX - minDX) * reach)));
    const finalY = this.trashAimY || this.catTopY + 140;
    const peekX = cx + side * 50;
    const peekY = this.catTopY + 46;
    const hideX = cx + side * 12;
    const hideY = this.catTopY + 150;
    const e = Math.max(0, Math.min(1, this.trashAmount));
    if (e < 0.5) {
      const k0 = e / 0.5;
      const k = k0 * k0 * (3 - 2 * k0);
      return {
        x: hideX + (peekX - hideX) * k,
        y: hideY + (peekY - hideY) * k,
        w,
        h,
        s,
        rot: side * -0.35 * k,
        behind: true,
        side,
      };
    }
    const k0 = (e - 0.5) / 0.5;
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const k = 1 + c3 * Math.pow(k0 - 1, 3) + c1 * Math.pow(k0 - 1, 2); // easeOutBack
    return {
      x: peekX + (finalX - peekX) * k,
      y: peekY + (finalY - peekY) * k,
      w,
      h,
      s,
      rot: side * -0.35 * (1 - Math.min(1, k)),
      behind: false,
      side,
    };
  }

  private updateTrash(dt: number, now: number): void {
    const gulping = this.trashGulpT >= 0;
    const want =
      !this.privacyMode && (this.trashWanted || gulping || now < this.trashHoldUntil);

    // Like the eyes following the cursor: the can is offered on the cursor's side of the cat
    // (left or right only), and slides toward the cursor within the paw's comfortable reach.
    const cx = this.cursorRelX * this.logicalW;
    const cy = this.cursorRelY * this.logicalH;
    const catX = this.catCenterX;
    const desiredSide: 1 | -1 =
      cx < catX - 22 ? -1 : cx > catX + 22 ? 1 : this.trashSide;
    const switching = desiredSide !== this.trashSide && !gulping;
    if (switching && this.trashAmount <= 0.5) {
      // Can is tucked behind the head: swap paws and bring it out on the other side
      this.trashSide = desiredSide;
    }

    if (switching && this.trashAmount > 0.5) {
      this.trashAmount = Math.max(0.5, this.trashAmount - dt / 0.16);
    } else {
      this.trashAmount = want
        ? Math.min(1, this.trashAmount + dt / (this.trashAmount > 0.45 ? 0.32 : 0.5))
        : Math.max(0, this.trashAmount - dt / 0.42);
    }

    // More files -> a (slightly) bigger can, capped so it never gets silly.
    const targetScale = 1 + Math.min(0.42, Math.log2(Math.max(1, this.trashCount)) * 0.12);
    this.trashScale += (targetScale - this.trashScale) * (1 - Math.exp(-6 * dt));

    if (!gulping) {
      const minDX = 86;
      const maxDX = this.keyboardLayout === '108' ? 176 : 158;
      const dx = (cx - catX) * this.trashSide;
      const reachTarget = Math.max(0, Math.min(1, (dx - minDX) / (maxDX - minDX)));
      const aimTarget = Math.max(this.catTopY + 82, Math.min(this.catTopY + 165, cy));
      if (!this.trashAimY) this.trashAimY = aimTarget;
      const k = 1 - Math.exp(-7 * dt);
      this.trashReach += (reachTarget - this.trashReach) * k;
      this.trashAimY += (aimTarget - this.trashAimY) * k;
    }

    this.trashHover = this.trashWanted && this.isPointOverTrash(cx, cy);
    const lidTarget = gulping
      ? this.trashGulpT < 0.32
        ? 1
        : 0
      : this.trashHover
        ? 1
        : this.trashWanted
          ? 0.3
          : 0;
    this.trashLid += (lidTarget - this.trashLid) * (1 - Math.exp(-(gulping && this.trashGulpT >= 0.32 ? 26 : 12) * dt));

    if (gulping) {
      const prev = this.trashGulpT;
      this.trashGulpT += dt;
      if (prev < 0.32 && this.trashGulpT >= 0.32) this.trashWobble = 1;
      if (this.trashGulpT > 1.05) this.trashGulpT = -1;
    }
    this.trashWobble = Math.max(0, this.trashWobble - dt * 2.6);

    const g = this.getTrashGeom();
    const openingY = g.y - g.h * 0.5;
    for (const p of this.trashPapers) {
      p.age += dt;
      p.vy += 620 * dt;
      p.x += (g.x - p.x) * (1 - Math.exp(-5 * dt)) + p.vx * dt;
      p.y += p.vy * dt;
      p.rot += dt * 4;
    }
    this.trashPapers = this.trashPapers.filter((p) => !(p.vy > 0 && p.y > openingY + 2) && p.age < 2);
    for (const f of this.trashFx) f.age += dt;
    this.trashFx = this.trashFx.filter((f) => f.age < 1.6);

    // Paw on the hand-off side grips the can's rim while it's out front.
    const holdPaw = this.trashSide > 0 ? this.rightPaw : this.leftPaw;
    const otherPaw = holdPaw === this.rightPaw ? this.leftPaw : this.rightPaw;
    if (otherPaw.mode === 'hold') otherPaw.mode = 'idle';
    if (this.catBreed !== 'dafeiyu' && this.trashAmount > 0.45 && !g.behind) {
      holdPaw.mode = 'hold';
      holdPaw.target = { x: g.x - this.trashSide * g.w * 0.34, y: g.y - g.h * 0.5 + 4 * g.s };
      holdPaw.lastActiveAt = now;
    } else if (holdPaw.mode === 'hold') {
      holdPaw.mode = 'idle';
    }

    if (this.trashAmount <= 0 && !want) {
      this.trashCount = 1;
      this.trashReach = 0;
      this.trashAimY = 0;
    }
  }

  private drawTrashLayer(ctx: CanvasRenderingContext2D, front: boolean): void {
    if (this.trashAmount <= 0.001) return;
    const g = this.getTrashGeom();
    if (g.behind === front) return;
    this.drawTrashCan(ctx, g);
  }

  private drawTrashCan(
    ctx: CanvasRenderingContext2D,
    g: { x: number; y: number; w: number; h: number; s: number; rot: number; behind: boolean; side: 1 | -1 },
  ): void {
    const accent = this.getMouseButtonColors().left;
    const wob = this.trashWobble * Math.sin(this.elapsed * 28) * 0.13;
    const topHW = 17;
    const botHW = 13.2;
    const top = -20;
    const bot = 20;
    const outline = '#39404a';

    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.rot + wob);
    ctx.scale(g.s, g.s);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Soft drop shadow
    ctx.save();
    ctx.shadowColor = 'rgba(10, 12, 18, 0.35)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#9aa4ae';
    ctx.beginPath();
    ctx.moveTo(-topHW, top);
    ctx.lineTo(topHW, top);
    ctx.lineTo(botHW, bot - 4);
    ctx.quadraticCurveTo(botHW, bot, botHW - 4, bot);
    ctx.lineTo(-botHW + 4, bot);
    ctx.quadraticCurveTo(-botHW, bot, -botHW, bot - 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Body with brushed-metal gradient
    const bodyGrad = ctx.createLinearGradient(-topHW, 0, topHW, 0);
    bodyGrad.addColorStop(0, '#aeb8c2');
    bodyGrad.addColorStop(0.32, '#eef2f5');
    bodyGrad.addColorStop(0.62, '#c9d1d8');
    bodyGrad.addColorStop(1, '#8f9aa5');
    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-topHW, top);
    ctx.lineTo(topHW, top);
    ctx.lineTo(botHW, bot - 4);
    ctx.quadraticCurveTo(botHW, bot, botHW - 4, bot);
    ctx.lineTo(-botHW + 4, bot);
    ctx.quadraticCurveTo(-botHW, bot, -botHW, bot - 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Vertical ribs
    ctx.strokeStyle = 'rgba(58, 66, 78, 0.32)';
    ctx.lineWidth = 1.2;
    for (const f of [-0.55, 0, 0.55]) {
      ctx.beginPath();
      ctx.moveTo(f * topHW, top + 9);
      ctx.lineTo(f * botHW, bot - 4);
      ctx.stroke();
    }

    // Skin-accent band + recycle mark
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(-topHW + 0.4, top + 2.5);
    ctx.lineTo(topHW - 0.4, top + 2.5);
    ctx.lineTo(topHW - 0.9, top + 7);
    ctx.lineTo(-topHW + 0.9, top + 7);
    ctx.closePath();
    ctx.fill();
    ctx.font = '700 13px "Apple Symbols", "Segoe UI Symbol", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(40, 46, 56, 0.55)';
    ctx.fillText('♻', 0, 6.5);

    // Count badge
    if (this.trashCount > 1) {
      ctx.fillStyle = accent;
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(g.side * (topHW - 2), top + 13, 6.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1a1d22';
      ctx.font = '800 7.5px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(this.trashCount > 99 ? '99+' : String(this.trashCount), g.side * (topHW - 2), top + 13.4);
    }

    // Rim + dark opening when the lid is up
    ctx.fillStyle = '#d7dee4';
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(0, top, topHW + 1.4, 3.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (this.trashLid > 0.12) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, this.trashLid * 2);
      ctx.fillStyle = '#262b33';
      ctx.beginPath();
      ctx.ellipse(0, top + 0.3, topHW - 1.2, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Hinged lid (hinge on the cat's side, opens toward the cursor)
    const hingeX = -g.side * (topHW + 1);
    ctx.save();
    ctx.translate(hingeX, top - 1);
    ctx.rotate(-g.side * this.trashLid * 1.65);
    ctx.scale(g.side, 1);
    const lidLen = topHW * 2 + 2;
    const lidGrad = ctx.createLinearGradient(0, -7, 0, 1);
    lidGrad.addColorStop(0, '#f4f7f9');
    lidGrad.addColorStop(1, '#a9b3bd');
    ctx.fillStyle = lidGrad;
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-0.8, 1);
    ctx.lineTo(lidLen + 0.8, 1);
    ctx.quadraticCurveTo(lidLen + 0.4, -6.5, lidLen * 0.5, -7);
    ctx.quadraticCurveTo(-0.4, -6.5, -0.8, 1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Knob
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.ellipse(lidLen * 0.5, -8.2, 4, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    // "Drop here" hint pill while hovering
    if (this.trashHover && this.trashGulpT < 0) {
      const label = '松手丢进回收站';
      ctx.save();
      ctx.font = '700 10.5px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
      const tw = ctx.measureText(label).width + 16;
      const px = Math.max(tw / 2 + 4, Math.min(this.logicalW - tw / 2 - 4, g.x));
      const py = g.y - g.h * 0.5 - 30 * g.s - 4;
      ctx.fillStyle = 'rgba(20, 22, 28, 0.82)';
      this.roundRect(ctx, px - tw / 2, py - 9, tw, 18, 9);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px, py + 0.5);
      ctx.restore();
    }
  }

  private drawTrashFx(ctx: CanvasRenderingContext2D): void {
    for (const p of this.trashPapers) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#8b96a3';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-5, -6.5);
      ctx.lineTo(2.5, -6.5);
      ctx.lineTo(5, -4);
      ctx.lineTo(5, 6.5);
      ctx.lineTo(-5, 6.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(120, 132, 146, 0.6)';
      ctx.beginPath();
      ctx.moveTo(-3, -1.5);
      ctx.lineTo(3, -1.5);
      ctx.moveTo(-3, 1.5);
      ctx.lineTo(3, 1.5);
      ctx.moveTo(-3, 4);
      ctx.lineTo(1.5, 4);
      ctx.stroke();
      ctx.restore();
    }
    for (const f of this.trashFx) {
      const a = f.age < 0.2 ? f.age / 0.2 : Math.max(0, 1 - (f.age - 0.7) / 0.9);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.font = '800 13px "Segoe UI", "PingFang SC", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#4ade80';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 4;
      ctx.fillText(f.text, f.x, f.y - f.age * 26);
      ctx.restore();
    }
  }

  // ---- Flying critter cursor toy ----

  private updateCritter(dt: number, now: number): void {
    const lx = this.cursorRelX * this.logicalW;
    const ly = this.cursorRelY * this.logicalH;
    if (this.lastCursorLX < -9000) {
      this.lastCursorLX = lx;
      this.lastCursorLY = ly;
    } else if (Math.abs(lx - this.lastCursorLX) + Math.abs(ly - this.lastCursorLY) > 0.8) {
      this.critterLastMoveAt = now;
      this.lastCursorLX = lx;
      this.lastCursorLY = ly;
    }
    const center = this.spinePoint(0.42, 0);
    const d = Math.hypot(lx - center.x, ly - center.y);
    const allowed =
      this.flyingToysEnabled &&
      this.cursorPresent &&
      !this.privacyMode &&
      !this.trashWanted &&
      this.trashAmount < 0.05 &&
      !this.cursorOverCat &&
      now - this.critterLastMoveAt < 9000 &&
      lx > 10 &&
      lx < this.logicalW - 10 &&
      ly > 10 &&
      ly < this.logicalH - 10;

    if (!this.critterActive) {
      if (allowed && d < 215) {
        this.critterActive = true;
        this.critterKindIdx =
          (this.critterKindIdx + 1 + Math.floor(Math.random() * (CRITTER_KINDS.length - 1))) % CRITTER_KINDS.length;
        this.critterKind = CRITTER_KINDS[this.critterKindIdx];
        if (this.critterAmount < 0.05) {
          this.critterX = lx;
          this.critterY = ly;
        }
        this.critterDodgeX = 0;
        this.critterDodgeY = 0;
        this.nextSwatAt = now + 700;
        if (this.leftPaw.mode === 'mouse') this.leftPaw.mode = 'idle';
      }
    } else if (!allowed || d > 255) {
      this.critterActive = false;
    }

    const on = this.critterActive ? 1 : 0;
    this.critterAmount += (on - this.critterAmount) * (1 - Math.exp(-9 * dt));
    this.critterHunt += (on - this.critterHunt) * (1 - Math.exp(-(on ? 2.6 : 4) * dt));

    for (const f of this.critterFx) {
      f.age += dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vy += 40 * dt;
    }
    this.critterFx = this.critterFx.filter((f) => f.age < f.life);

    if (this.critterAmount < 0.01) return;

    const t = this.elapsed;
    this.critterDodgeX *= Math.exp(-3.2 * dt);
    this.critterDodgeY *= Math.exp(-3.2 * dt);
    const tx = lx + Math.sin(t * 2.3) * 4 + Math.sin(t * 5.1) * 1.5 + this.critterDodgeX;
    const ty = ly + Math.sin(t * 3.1) * 5 + this.critterDodgeY;
    const k = 1 - Math.exp(-13 * dt);
    const nx = this.critterX + (tx - this.critterX) * k;
    const ny = this.critterY + (ty - this.critterY) * k;
    this.critterVX = (nx - this.critterX) / Math.max(0.001, dt);
    this.critterVY = (ny - this.critterY) / Math.max(0.001, dt);
    this.critterX = nx;
    this.critterY = ny;
    if (Math.abs(this.critterVX) > 18) {
      this.critterFacing = this.critterVX > 0 ? 1 : -1;
    }
    const speed = Math.hypot(this.critterVX, this.critterVY);
    this.critterFlap += dt * CRITTER_FLAP_SPEED[this.critterKind] * (1 + Math.min(1, speed / 420) * 0.6);

    // The cat bats at the critter when it flutters within paw range.
    if (
      this.catBreed !== 'dafeiyu' &&
      this.critterActive &&
      this.critterAmount > 0.7 &&
      now >= this.nextSwatAt &&
      now - this.lastAnyKeyAt > 700
    ) {
      let paw = this.critterX > this.catCenterX ? this.rightPaw : this.leftPaw;
      if (paw.mode === 'hold' || paw.mode === 'poke') {
        paw = paw === this.rightPaw ? this.leftPaw : this.rightPaw;
      }
      const sh = this.getLiveShoulder(paw, 0);
      const dx = this.critterX - sh.x;
      const dy = this.critterY - sh.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      if (dist < 180 && paw.mode !== 'hold' && paw.mode !== 'poke') {
        const reach = Math.min(dist, 110);
        paw.mode = 'swat';
        paw.pokeTime = 0;
        paw.target = { x: sh.x + (dx / dist) * reach, y: sh.y + (dy / dist) * reach };
        paw.impactSquash = 0.6;
        paw.lastActiveAt = now;
        if (dist <= 124) {
          // Close call! The critter darts away with a little sparkle.
          this.critterDodgeX = (dx / dist) * 38;
          this.critterDodgeY = (dy / dist) * 28 - 12;
          for (let i = 0; i < 5; i++) {
            const a = Math.random() * Math.PI * 2;
            this.critterFx.push({
              x: paw.target.x,
              y: paw.target.y,
              vx: Math.cos(a) * (40 + Math.random() * 50),
              vy: Math.sin(a) * (40 + Math.random() * 50) - 20,
              age: 0,
              life: 0.45 + Math.random() * 0.25,
              color: Math.random() < 0.5 ? '#fff2a8' : '#ffd1e8',
            });
          }
          if (paw.side === 'left') this.earTwitchLeft = 1;
          else this.earTwitchRight = 1;
        }
        this.nextSwatAt = now + 750 + Math.random() * 950;
      } else {
        this.nextSwatAt = now + 350;
      }
    }
  }

  private drawCritterLayer(ctx: CanvasRenderingContext2D): void {
    for (const f of this.critterFx) {
      const a = Math.max(0, 1 - f.age / f.life);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = f.color;
      ctx.translate(f.x, f.y);
      ctx.rotate(f.age * 6);
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2;
        ctx.lineTo(Math.cos(ang) * 3.4, Math.sin(ang) * 3.4);
        ctx.lineTo(Math.cos(ang + Math.PI / 4) * 1.1, Math.sin(ang + Math.PI / 4) * 1.1);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    if (this.critterAmount < 0.02) return;
    const a = this.critterAmount;
    ctx.save();
    ctx.globalAlpha = Math.min(1, a * 1.2);
    ctx.translate(this.critterX, this.critterY);
    const tilt = Math.max(-0.35, Math.min(0.35, this.critterVY / 900));
    ctx.rotate(tilt * this.critterFacing);
    // "Poof" morph: pops in from a small sparkle
    const pop = 0.4 + 0.6 * a + Math.sin(a * Math.PI) * 0.15;
    ctx.scale(pop * 1.45, pop * 1.45);
    drawCritter(ctx, this.critterKind, this.critterFlap, this.critterFacing, this.elapsed);
    ctx.restore();
  }

  // ---- Simulation update ----

  private update(dt: number, now: number): void {
    this.elapsed += dt;
    this.breathPhase += dt * (2.1 - this.sleepyAmount * 0.9);

    const mLerp = 1 - Math.exp(-28 * dt);
    this.mouseOffsetX += (this.mouseTargetOffsetX - this.mouseOffsetX) * mLerp;
    this.mouseOffsetY += (this.mouseTargetOffsetY - this.mouseOffsetY) * mLerp;
    if (!this.mouseLeftDown && this.mouseLeftPress > 0) {
      this.mouseLeftPress = Math.max(0, this.mouseLeftPress - dt * 5.8);
    }
    if (!this.mouseRightDown && this.mouseRightPress > 0) {
      this.mouseRightPress = Math.max(0, this.mouseRightPress - dt * 5.8);
    }
    if (!this.mouseMiddleDown && this.mouseMiddlePress > 0) {
      this.mouseMiddlePress = Math.max(0, this.mouseMiddlePress - dt * 5.8);
    }
    this.mouseScrollFlash = Math.max(0, this.mouseScrollFlash - dt * 4.5);
    this.mouseBadges = this.mouseBadges.filter((b) => now - b.createdAt < b.lifetime);

    while (this.recentKeyTimes.length > 0 && now - this.recentKeyTimes[0] > 950) {
      this.recentKeyTimes.shift();
    }
    const targetTypingEnergy = Math.min(1, this.recentKeyTimes.length / 7);
    this.typingEnergy += (targetTypingEnergy - this.typingEnergy) * (1 - Math.exp(-9 * dt));

    // Mood: accumulate real typing time; short pauses do not break the streak, a real
    // break (>~4s) does. Music keeps the cat relaxed unless it has been typing too long.
    const sinceKey = now - this.lastAnyKeyAt;
    if (sinceKey > WORK_STREAK_BREAK_MS) {
      this.workTypingSec = 0;
    } else if (sinceKey < WORK_TYPING_GAP_MS) {
      this.workTypingSec = Math.min(WORK_ANNOY_SECONDS + 60, this.workTypingSec + dt);
    }
    const moodBlocked = this.privacyMode;
    const keyIdleMs = now - this.lastAnyKeyAt;
    const mouseIdleMs = now - this.lastMouseMoveAt;
    const idleMs = Math.min(keyIdleMs, mouseIdleMs);
    const head = this.spinePoint(0.18, 0);
    const cursorDist = Math.hypot(
      this.cursorRelX * this.logicalW - head.x,
      this.cursorRelY * this.logicalH - head.y,
    );

    let wantAnnoy = !moodBlocked && this.workTypingSec >= WORK_ANNOY_SECONDS ? 1 : 0;
    let wantRelax = !moodBlocked && wantAnnoy === 0 && this.musicPlaying ? 1 : 0;
    let wantHappy = !moodBlocked && wantAnnoy === 0 && this.petEnergy > 0.35 ? 1 : 0;
    let wantSleepy =
      !moodBlocked &&
      !this.musicPlaying &&
      idleMs >= MOOD_SLEEP_IDLE_MS &&
      this.petEnergy < 0.2
        ? 1
        : 0;
    let wantCurious =
      !moodBlocked &&
      !this.musicPlaying &&
      wantSleepy === 0 &&
      !this.cursorOverCat &&
      this.petEnergy < 0.25 &&
      mouseIdleMs < MOOD_CURIOUS_HOLD_MS &&
      keyIdleMs > 800 &&
      cursorDist < MOOD_CURIOUS_RADIUS
        ? 1
        : 0;

    // Demo override from the website: force one mood and mute the automatic ones.
    const preview = !moodBlocked && this.catBreed !== 'dafeiyu' ? this.moodPreview : null;
    if (preview) {
      wantAnnoy = preview === 'annoyed' ? 1 : 0;
      wantRelax = preview === 'relaxed' ? 1 : 0;
      wantHappy = preview === 'happy' ? 1 : 0;
      wantSleepy = preview === 'sleepy' ? 1 : 0;
      wantCurious = preview === 'curious' ? 1 : 0;
    }

    this.relaxAmount += (wantRelax - this.relaxAmount) * (1 - Math.exp(-1.6 * dt));
    this.annoyAmount += (wantAnnoy - this.annoyAmount) * (1 - Math.exp(-2.4 * dt));
    const wantHeadphones = !moodBlocked && (preview ? preview === 'relaxed' : this.musicPlaying) ? 1 : 0;
    this.headphoneAmount += (wantHeadphones - this.headphoneAmount) * (1 - Math.exp(-7.5 * dt));
    if (this.annoyAmount > 0.01) {
      this.tailWagPhase += dt * (6.8 + this.typingEnergy * 2.4 + this.annoyAmount * 1.4);
    }
    this.happyAmount += (wantHappy - this.happyAmount) * (1 - Math.exp(-8 * dt));
    this.curiousAmount += (wantCurious - this.curiousAmount) * (1 - Math.exp(-5 * dt));
    this.sleepyAmount +=
      (wantSleepy - this.sleepyAmount) * (1 - Math.exp(-(wantSleepy ? 4 : 16) * dt));

    if (moodBlocked) {
      this.mood = 'neutral';
    } else if (preview) {
      this.mood = preview;
    } else if (now - this.moodChangedAt >= MOOD_MIN_DWELL_MS) {
      const candidate: CatMood =
        this.annoyAmount > (this.mood === 'annoyed' ? MOOD_EXIT_THRESHOLD : 0.5)
          ? 'annoyed'
          : this.happyAmount > (this.mood === 'happy' ? MOOD_EXIT_THRESHOLD : MOOD_ENTER_THRESHOLD)
            ? 'happy'
            : this.sleepyAmount > (this.mood === 'sleepy' ? MOOD_EXIT_THRESHOLD : MOOD_ENTER_THRESHOLD)
              ? 'sleepy'
              : this.relaxAmount > (this.mood === 'relaxed' ? MOOD_EXIT_THRESHOLD : 0.5)
                ? 'relaxed'
                : this.curiousAmount >
                    (this.mood === 'curious' ? MOOD_EXIT_THRESHOLD : MOOD_ENTER_THRESHOLD)
                  ? 'curious'
                  : 'neutral';
      if (candidate !== this.mood) {
        this.mood = candidate;
        this.moodChangedAt = now;
        this.nextMoodGlyphAt = 0;
      }
    }

    if (this.mood === 'relaxed' && !this.privacyMode && now >= this.nextMusicNoteAt) {
      this.spawnMusicNote();
      this.nextMusicNoteAt = now + 420 + Math.random() * 420;
    }

    if (!this.privacyMode && now >= this.nextMoodGlyphAt) {
      if (this.sleepyAmount > 0.45) {
        this.spawnMoodGlyph('sleepy');
        this.nextMoodGlyphAt = now + 1200 + Math.random() * 600;
      } else if (this.happyAmount > 0.45) {
        this.spawnMoodGlyph('happy');
        this.nextMoodGlyphAt = now + 700 + Math.random() * 400;
      } else if (this.curiousAmount > 0.5) {
        this.spawnMoodGlyph('curious');
        this.nextMoodGlyphAt = now + 1500 + Math.random() * 900;
      }
    }
    this.updateMoodParticles(dt);
    this.updateTailFlick();
    this.updateTrash(dt, now);
    this.updateCritter(dt, now);

    const isTypingRecently = now - this.lastAnyKeyAt < 650;
    const targetHunch = isTypingRecently ? 0.45 + this.typingEnergy * 0.55 : 0;
    this.typingHunch += (targetHunch - this.typingHunch) * (1 - Math.exp(-10 * dt));

    const rockAcc = -this.strikeRock * 140 - this.strikeRockVel * 14;
    this.strikeRockVel += rockAcc * dt;
    this.strikeRock = Math.max(-1, Math.min(1, this.strikeRock + this.strikeRockVel * dt));

    this.bodyBob = Math.max(0, this.bodyBob - dt * 11.5);
    this.kbBounce = Math.max(0, this.kbBounce - dt * 15);

    // Playful left-right body & head groove sway during pure typing (matches original video first half!)
    const pureTypingActive = isTypingRecently && this.leftPaw.mode !== 'mouse';
    if (pureTypingActive) {
      this.typingGroovePhase += dt * (4.8 + this.typingEnergy * 5.2 + this.annoyAmount * 4.2);
    }
    const grooveWave =
      Math.sin(this.typingGroovePhase) * (0.58 + this.typingEnergy * 0.44 + this.annoyAmount * 0.16);
    const targetTypingSway = pureTypingActive
      ? Math.max(-1.1, Math.min(1.1, grooveWave * 0.72 + this.lastKeyBias * 0.55))
      : this.leftPaw.mode === 'mouse' && isTypingRecently
        ? Math.sin(this.typingGroovePhase) * 0.16
        : 0;
    const swayAcc = (targetTypingSway - this.typingSway) * 118 - this.typingSwayVel * 12.5;
    this.typingSwayVel += swayAcc * dt;
    this.typingSway = Math.max(-1.2, Math.min(1.2, this.typingSway + this.typingSwayVel * dt));

    // Measured spine-shear lean: shifts head & chest cleanly forward-left toward mouse while hips stay anchored!
    let targetLean = 0;
    if (this.trashAmount > 0.45) {
      targetLean = this.trashSide * (0.18 + this.trashReach * 0.32);
    } else if (this.leftPaw.mode === 'mouse') {
      const mouseSweepBias = (this.mouseOffsetX / 18) * 0.22;
      targetLean = this.rightPaw.mode === 'poke'
        ? -0.52 + mouseSweepBias
        : -0.96 + mouseSweepBias;
    }
    this.spineLean += (targetLean - this.spineLean) * (1 - Math.exp(-10 * dt));

    const desiredHeadTilt =
      this.typingSway * 0.18 +
      this.typingHunch * (this.strikeRock * 0.065 - 0.02) +
      this.spineLean * 0.085 +
      this.relaxAmount * Math.sin(this.elapsed * 2.0) * 0.06 +
      this.annoyAmount * Math.sin(this.elapsed * 13) * 0.014 +
      this.sleepyAmount * (0.045 + Math.sin(this.elapsed * 0.9) * 0.012);
    this.headTilt += (desiredHeadTilt - this.headTilt) * (1 - Math.exp(-12 * dt));

    this.petEnergy = Math.max(0, this.petEnergy - dt * (this.cursorOverCat ? 0.22 : 1.15));
    this.lastDt = dt;
    this.lastDtForFx = dt;
    const wantSquint = this.petEnergy > 0.3 ? 1 : 0;
    this.squintAmount += (wantSquint - this.squintAmount) * (1 - Math.exp(-12 * dt));
    const wantPrivacy = this.privacyMode ? 1 : 0;
    this.privacyClose += (wantPrivacy - this.privacyClose) * (1 - Math.exp(-14 * dt));
    catAudio.setPurrIntensity(!this.privacyMode && this.squintAmount > 0.25 ? this.squintAmount : 0);
    if (this.catBreed === 'dafeiyu') {
      this.dafeiyu.update(dt, now, this.buildDaFeiYuLayout());
    }

    this.earTwitchLeft = Math.max(0, this.earTwitchLeft - dt * 5.2);
    this.earTwitchRight = Math.max(0, this.earTwitchRight - dt * 5.2);
    if (
      !this.privacyMode &&
      this.headphoneAmount < 0.35 &&
      this.sleepyAmount < 0.65 &&
      this.elapsed >= this.nextEarFlickAt
    ) {
      const r = Math.random();
      if (r < 0.45) {
        this.earTwitchLeft = 1;
      } else if (r < 0.9) {
        this.earTwitchRight = 1;
      } else {
        // Occasional cute alternating double-ear perk
        this.earTwitchLeft = 1;
        this.earTwitchRight = 0.78;
      }
      this.nextEarFlickAt = this.elapsed + 2.0 + Math.random() * 2.8;
    }

    if (!this.isBlinking && this.elapsed >= this.nextBlinkAt) {
      this.isBlinking = true;
      this.blinkProgress = 0;
    }
    if (this.isBlinking) {
      this.blinkProgress += dt * 12;
      if (this.blinkProgress >= 2) {
        this.isBlinking = false;
        this.blinkProgress = 0;
        this.nextBlinkAt = this.elapsed + 2.8 + Math.random() * 3.6;
      }
    }

    // 100% live eye tracking toward cursor, OR cozy bottom-edge glance at keys during pure typing!
    const eyePos = this.spinePoint(0.24, 0);
    const eyeCenterRelX = eyePos.x / this.logicalW;
    const eyeCenterRelY = eyePos.y / this.logicalH;
    let dx = this.cursorRelX - eyeCenterRelX;
    let dy = this.cursorRelY - eyeCenterRelY;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.001) {
      const mag = Math.min(1, dist * 1.9);
      dx = (dx / dist) * mag;
      dy = (dy / dist) * mag;
    }
    const mouseRecentlyMoved = now - this.lastMouseMoveAt < 2400;
    const pureTypingGlance = mouseRecentlyMoved ? 0 : this.typingHunch;
    const targetEyeX =
      dx * 7.0 * (1 - pureTypingGlance * 0.45) +
      pureTypingGlance * (this.typingSway * 3.8 + this.lastKeyBias * 2.2);
    const targetEyeY = dy * 5.2 * (1 - pureTypingGlance * 0.45) + pureTypingGlance * 5.8;
    const eyeLerp = 1 - Math.exp(-20 * dt);
    this.eyeLookX += (targetEyeX - this.eyeLookX) * eyeLerp;
    this.eyeLookY += (targetEyeY - this.eyeLookY) * eyeLerp;

    const targetFaceTurn = dx * 4.0 + this.spineLean * 8.0 + this.typingSway * 8.5 + pureTypingGlance * 1.5;
    this.faceTurnX += (targetFaceTurn - this.faceTurnX) * (1 - Math.exp(-11 * dt));

    for (const anim of this.keyAnims.values()) {
      if (!anim.pressed && anim.pressAmount > 0) {
        anim.pressAmount = Math.max(0, anim.pressAmount - dt * 5.0);
      }
    }

    this.updatePaw(this.leftPaw, dt, now);
    this.updatePaw(this.rightPaw, dt, now);

    const beforeLen = this.bubbles.length;
    this.bubbles = this.bubbles.filter((b) => now - b.createdAt < b.lifetime);
    if (this.bubbles.length !== beforeLen) {
      this.layoutBubbles();
    }
    for (const b of this.bubbles) {
      const age = (now - b.createdAt) / b.lifetime;
      b.x += (b.targetX - b.x) * (1 - Math.exp(-18 * dt));
      const desiredY = b.targetY - age * 10;
      b.y += (desiredY - b.y) * (1 - Math.exp(-16 * dt));
    }
  }

  private updatePaw(paw: PawState, dt: number, now: number): void {
    const liveMouseX = this.mouseBaseX + this.mouseOffsetX;
    const liveMouseY = this.mouseBaseY + this.mouseOffsetY;

    if (paw.mode === 'mouse') {
      const isCatFacing = this.keyboardOrientation === 'cat';
      const lrBias = this.mouseLeftPress - this.mouseRightPress;
      const anyClickPress = Math.max(this.mouseLeftPress, this.mouseRightPress, this.mouseMiddlePress);
      if (isCatFacing) {
        // 180° cat-facing: palm heel at TOP, LMB = inner/+X, RMB = outer/-X
        paw.target = {
          x: liveMouseX + 1.2 + lrBias * 6.4,
          y: liveMouseY - 11.5 + anyClickPress * 3.6,
        };
      } else {
        // 0° viewer-facing: palm heel at BOTTOM, LMB = left/-X, RMB = right/+X
        paw.target = {
          x: liveMouseX + 0.5 - lrBias * 6.4,
          y: liveMouseY + 10.0 - anyClickPress * 3.4,
        };
      }
      const stillHolding =
        this.mouseLeftDown ||
        this.mouseRightDown ||
        this.mouseMiddleDown ||
        now - this.lastMouseMoveAt < 2200;
      if (!stillHolding) {
        paw.mode = 'idle';
      }
    } else if (paw.mode === 'poke') {
      paw.pokeTime += dt;
      if (paw.pokeTime > 0.13) {
        if (paw.side === 'left' && (this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 450)) {
          paw.mode = 'mouse';
        } else if (now - this.lastAnyKeyAt < 650) {
          paw.mode = 'curled';
        } else {
          paw.mode = 'idle';
        }
      }
    } else if (paw.mode === 'curled') {
      if (now - this.lastAnyKeyAt > 680) {
        paw.mode = 'idle';
      }
    } else if (paw.mode === 'swat') {
      paw.pokeTime += dt;
      if (paw.pokeTime > 0.34) {
        paw.mode = now - this.lastAnyKeyAt < 650 ? 'curled' : 'idle';
      }
    } else if (paw.mode === 'hold') {
      if (this.trashAmount < 0.45) {
        paw.mode = 'idle';
      }
    }

    if (paw.mode === 'curled') {
      paw.target = this.getLiveCurledPawPos(paw, 0);
    } else if (paw.mode === 'idle') {
      const baseSp = this.spinePoint(1.0, 0);
      paw.target = { x: baseSp.x + (paw.side === 'left' ? -19 : 19), y: baseSp.y };
    }

    const wantIdle = paw.mode === 'idle' ? 1 : 0;
    const wantCurl = paw.mode === 'curled' ? 1 : 0;
    const blendRate = 1 - Math.exp(-20 * dt);
    paw.idleWeight += (wantIdle - paw.idleWeight) * blendRate;
    paw.curlWeight += (wantCurl - paw.curlWeight) * blendRate;

    // Unconditionally stable, framerate-independent tracking (ZERO Euler spring overshoot at any FPS!)
    const followRate =
      (paw.mode === 'poke' ? 42 : paw.mode === 'mouse' ? 32 : paw.mode === 'swat' ? 34 : paw.mode === 'hold' ? 26 : 22) *
      (1 + this.annoyAmount * 0.6);
    const follow = 1 - Math.exp(-followRate * dt);
    paw.pos.x += (paw.target.x - paw.pos.x) * follow;
    paw.pos.y += (paw.target.y - paw.pos.y) * follow;
    paw.vel.x = 0;
    paw.vel.y = 0;

    // Hard guarantee: while poking a key, paw tip stays strictly on top of the keyboard surface
    if (paw.mode === 'poke') {
      const clamped = this.clampToKeyboardSurface(paw.pos);
      if (clamped.y < paw.pos.y || Math.abs(clamped.x - paw.pos.x) > 0.01) {
        paw.pos.x = clamped.x;
        paw.pos.y = Math.min(paw.pos.y, clamped.y);
      }
    }

    paw.impactSquash = Math.max(0, paw.impactSquash - dt * 7.5);

    for (const s of paw.smears) {
      s.alpha -= dt * 3.8;
    }
    paw.smears = paw.smears.filter((s) => s.alpha > 0.02);
  }

  // ---- High-fidelity true-scale rendering ----

  private render(): void {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    ctx.save();
    const vt = this.getViewTransform();
    ctx.translate(vt.ox, vt.oy);
    ctx.scale(vt.s, vt.s);

    const breath = Math.sin(this.breathPhase) * (1 + this.sleepyAmount * 0.25);
    const purrShift = this.squintAmount > 0.4 ? Math.sin(this.elapsed * 22) * 0.45 * this.squintAmount : 0;

    if (this.catBreed === 'dafeiyu') {
      const now = performance.now();
      const layout = this.buildDaFeiYuLayout();
      this.dafeiyu.renderBody(ctx, now, layout);
      this.drawMiniMouse(ctx);
      this.drawKeyboard(ctx);
      this.dafeiyu.renderForeground(ctx, this.lastDt, now, layout);
      if (this.showKeyBubbles && !this.privacyMode) {
        this.drawKeyBubbles(ctx);
        this.drawMouseBadges(ctx);
      }
      this.drawTrashLayer(ctx, false);
      this.drawTrashLayer(ctx, true);
      this.drawCritterLayer(ctx);
      ctx.restore();
      return;
    }

    // Layer 1: Thick plush calm low-right S-hook black tail (measured 17px thick, barely drifts!)
    this.drawTail(ctx);

    // Layer 2: Mini mouse & 65% mechanical keyboard
    this.drawMiniMouse(ctx);
    this.drawKeyboard(ctx);

    // Layer 2.5: trash can still emerging from behind the cat's back
    this.drawTrashLayer(ctx, false);

    // Layer 3: Exact measured spine-deformable cat silhouette (ears, cheeks, neck, pear belly, grounded hind feet, eyes & tiny whiskers)
    this.drawCatBody(ctx, breath, purrShift);

    // Layer 3.5: trash can handed out in front (paw grips its rim next)
    this.drawTrashLayer(ctx, true);

    // Layer 4: True-scale velvety cat paws (tapered idle legs / planted diagonal mouse support leg / bent curled chest paw / plump round poking paw!)
    this.drawPaw(ctx, this.leftPaw, breath);
    this.drawPaw(ctx, this.rightPaw, breath);

    // Layer 4.5: Mood overlays (floating music notes / anger mark / frustrated typing sparks)
    this.drawMoodEffects(ctx, breath);

    // Layer 5: Organic bouncing 3D keycap bubbles & crisp mouse click badges
    if (this.showKeyBubbles && !this.privacyMode) {
      this.drawKeyBubbles(ctx);
      this.drawMouseBadges(ctx);
    }

    // Layer 6: paper sheets falling into the can & the flying critter toy on top of everything
    this.drawTrashFx(ctx);
    this.drawCritterLayer(ctx);

    ctx.restore();
  }

  private drawTail(ctx: CanvasRenderingContext2D): void {
    // Exact ORIG 0.3s tail: leaves hip slightly higher, flat horizontal start curving cleanly up into a soft horizontal S-hook!
    // When annoyed/impatient, cats lash their tail in a snappy traveling S-wave from base to tip.
    // Every mood has its own tail language (plus random idle swishes so a still cat never looks frozen).
    const t = this.elapsed;
    const gentleDrift = Math.sin(t * 0.9) * 1.4;
    const annoy = this.annoyAmount;
    const calm = Math.max(0, 1 - annoy);
    const lash = (p: number) => Math.tanh(Math.sin(p) * 1.55) / Math.tanh(1.55);
    const w1 = annoy > 0.01 ? lash(this.tailWagPhase) * annoy : 0;
    const w2 = annoy > 0.01 ? lash(this.tailWagPhase - 0.65) * annoy : 0;
    const w3 = annoy > 0.01 ? lash(this.tailWagPhase - 1.25) * annoy : 0;

    // Happy: tail held high with a fast little tip quiver.
    const happy = this.happyAmount * calm;
    // Relaxed (music): slow, broad, beat-like sway.
    const relax = this.relaxAmount * calm * (1 - happy);
    // Curious: raised question-mark hook with a thoughtful tip twitch.
    const curious = this.curiousAmount * calm;
    // Sleepy: tail lowered and almost still.
    const sleepy = this.sleepyAmount * calm;
    // Hunting a flying critter: low tail with a twitchy, excited tip.
    const hunt = this.critterHunt * calm;
    // Idle swish: a decaying traveling wave triggered every few seconds.
    const fl = this.tailFlick;
    const flickWave = fl > 0.001 ? Math.sin((1 - fl) * Math.PI * 3.2) * fl * this.tailFlickSign * calm : 0;
    const flickWaveLag = fl > 0.001 ? Math.sin((1 - fl) * Math.PI * 3.2 - 0.9) * fl * this.tailFlickSign * calm : 0;

    const relaxSway = Math.sin(t * 2.2);
    const relaxSwayLag = Math.sin(t * 2.2 - 0.7);
    const happyQuiver = Math.sin(t * 19) * 2.4 + Math.sin(t * 3.1) * 3;
    const curiousTwitch = Math.sin(t * 4.6) * Math.max(0, Math.sin(t * 1.3)) * 5;
    const huntTwitch = Math.sin(t * 13) * 4 + Math.sin(t * 5.7) * 3;
    const sleepySway = Math.sin(t * 0.7) * 3;

    const hipRight = this.spinePoint(0.84, 0);

    const startX = hipRight.x + 56;
    const startY = hipRight.y - 2;
    const cp1X = startX + 34 - annoy * 4 + w1 * 8 + flickWaveLag * 5 + relaxSwayLag * relax * 5;
    const cp1Y =
      startY + 4 + gentleDrift * 0.25 + w1 * 18 - happy * 8 + sleepy * 6 + flickWaveLag * 6;
    const cp2X =
      startX + 38 + w2 * 20 + relaxSwayLag * relax * 11 + flickWaveLag * 10 - happy * 6 - curious * 4;
    const cp2Y =
      startY - 34 + gentleDrift * 0.45 - annoy * 10 + w2 * 34 - happy * 22 - curious * 16 + sleepy * 22 +
      hunt * 10 + flickWave * 8;
    const endX =
      startX + 70 + gentleDrift * 0.35 - annoy * 6 + w3 * 26 + relaxSway * relax * 18 + flickWave * 18 +
      happy * (happyQuiver - 10) + curious * (curiousTwitch - 22) + sleepy * (8 + sleepySway) + hunt * (huntTwitch + 6);
    const endY =
      startY - 35 + gentleDrift - annoy * 14 + w3 * 44 + Math.cos(t * 2.2) * relax * 6 - happy * 30 -
      curious * 16 + sleepy * 30 + hunt * 18 + flickWave * 12;
    const tipAngle = Math.atan2(endY - cp2Y, endX - cp2X);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this.customSkin) {
      const s = this.customSkin;
      const tailW = s.tailFluffy ? 20.0 : 16.0;
      if (s.outlineColor) {
        ctx.shadowColor = 'rgba(30, 32, 40, 0.22)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetY = 1.5;
        ctx.strokeStyle = s.outlineColor;
        ctx.lineWidth = tailW + 3.4;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      } else {
        ctx.shadowColor = 'rgba(18, 17, 18, 0.42)';
        ctx.shadowBlur = 1.6;
      }

      const tailGrad = ctx.createLinearGradient(startX, startY, endX, endY);
      tailGrad.addColorStop(0.0, s.tailColor);
      tailGrad.addColorStop(1.0, s.tailTipColor);
      ctx.strokeStyle = tailGrad;
      ctx.lineWidth = tailW;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();

      if (s.tailFluffy) {
        ctx.fillStyle = s.tailTipColor;
        ctx.beginPath();
        ctx.ellipse(endX + 1, endY, 11.8, 10.2, tipAngle, 0, Math.PI * 2);
        ctx.fill();
      }

      // Cute tabby tail rings when tailStripes is enabled!
      if (s.tailStripes && (s.stripeColor || s.tailTipColor)) {
        const ringColor = s.stripeColor || s.tailTipColor;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 3.2;
        ctx.shadowBlur = 0;
        for (const t of [0.24, 0.44, 0.64, 0.82]) {
          const mt = 1 - t;
          const bx =
            mt * mt * mt * startX +
            3 * mt * mt * t * cp1X +
            3 * mt * t * t * cp2X +
            t * t * t * endX;
          const by =
            mt * mt * mt * startY +
            3 * mt * mt * t * cp1Y +
            3 * mt * t * t * cp2Y +
            t * t * t * endY;
          const tx =
            3 * mt * mt * (cp1X - startX) +
            6 * mt * t * (cp2X - cp1X) +
            3 * t * t * (endX - cp2X);
          const ty =
            3 * mt * mt * (cp1Y - startY) +
            6 * mt * t * (cp2Y - cp1Y) +
            3 * t * t * (endY - cp2Y);
          const tLen = Math.max(1, Math.hypot(tx, ty));
          const nx = (-ty / tLen) * (tailW * 0.42);
          const ny = (tx / tLen) * (tailW * 0.42);
          ctx.beginPath();
          ctx.moveTo(bx - nx, by - ny);
          ctx.lineTo(bx + nx, by + ny);
          ctx.stroke();
        }
      }

      ctx.restore();
      return;
    }

    if (this.catBreed === 'ragdoll') {
      // Plush bushy warm cocoa-taupe Ragdoll plume tail matching the real cat photo!
      ctx.shadowColor = 'rgba(48, 38, 30, 0.22)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1.5;
      ctx.strokeStyle = '#4e4239';
      ctx.lineWidth = 23.5;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      const tailGrad = ctx.createLinearGradient(startX, startY, endX, endY);
      tailGrad.addColorStop(0.0, '#8d7e6f');
      tailGrad.addColorStop(0.5, '#726356');
      tailGrad.addColorStop(1.0, '#584b40');
      ctx.strokeStyle = tailGrad;
      ctx.lineWidth = 20.2;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();

      // Bushy warm cocoa-taupe plume tip puff
      ctx.fillStyle = '#584b40';
      ctx.beginPath();
      ctx.ellipse(endX + 1, endY, 12.2, 10.6, tipAngle, 0, Math.PI * 2);
      ctx.fill();

      // Soft warm creamy sheen along upper fluff curve
      ctx.strokeStyle = 'rgba(246, 240, 232, 0.26)';
      ctx.lineWidth = 5.0;
      ctx.beginPath();
      ctx.moveTo(startX + 4, startY - 4);
      ctx.bezierCurveTo(cp1X - 2, cp1Y - 4, cp2X - 3, cp2Y - 4, endX - 3, endY - 4);
      ctx.stroke();
    } else {
      ctx.shadowColor = 'rgba(18, 17, 18, 0.45)';
      ctx.shadowBlur = 1.6;
      ctx.strokeStyle = '#141314';
      ctx.lineWidth = 16.0;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawCatBody(ctx: CanvasRenderingContext2D, breath: number, purrShift: number): void {
    if (this.customSkin) {
      this.drawCustomCatBody(ctx, this.customSkin, breath, purrShift);
      return;
    }
    const isRagdoll = this.catBreed === 'ragdoll';
    const catBlack = '#141314';
    const inkOutline = '#5d5148';

    // Evaluate measured left & right silhouette points deformed by flexible cat spine + unified head tilt!
    const leftPts: Vec2[] = [];
    const rightPts: Vec2[] = [];
    const bellySwell = 1 + this.typingHunch * 0.04;
    const headCenter = this.spinePoint(0.24, breath);
    const hcx = headCenter.x + purrShift;
    const hcy = headCenter.y;

    for (const slice of BODY_SLICES) {
      const sp = this.spinePoint(slice.t, breath);
      const widen = slice.t > 0.45 ? bellySwell : 1;
      const hw = slice.hw * widen;

      if (slice.t <= 0.38) {
        const tiltW = slice.t <= 0.30 ? 1.0 : (0.42 - slice.t) / 0.12;
        const ang = this.headTilt * tiltW;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        const relY = sp.y - hcy;
        const lx0 = sp.x + purrShift - hw - hcx;
        const rx0 = sp.x + purrShift + hw - hcx;
        leftPts.push({
          x: hcx + lx0 * cosA - relY * sinA,
          y: hcy + lx0 * sinA + relY * cosA,
        });
        rightPts.push({
          x: hcx + rx0 * cosA - relY * sinA,
          y: hcy + rx0 * sinA + relY * cosA,
        });
      } else {
        leftPts.push({ x: sp.x + purrShift - hw, y: sp.y });
        rightPts.push({ x: sp.x + purrShift + hw, y: sp.y });
      }
    }

    const crownRelY = this.spinePoint(0.11, breath).y - hcy;
    const crownPt = {
      x: hcx - crownRelY * Math.sin(this.headTilt),
      y: hcy + crownRelY * Math.cos(this.headTilt),
    };
    const basePt = this.spinePoint(1.0, breath);

    ctx.save();
    if (isRagdoll) {
      ctx.shadowColor = 'rgba(26, 30, 40, 0.24)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 2;
    } else {
      ctx.shadowColor = 'rgba(18, 17, 18, 0.42)';
      ctx.shadowBlur = 1.6;
    }

    // 1) Cute rounded grounded hind paws peeking out when front paws lift (matches 8.3s, 10.6s, 13.2s, 31.0s!)
    const anyFrontLifted = this.leftPaw.idleWeight < 0.7 || this.rightPaw.idleWeight < 0.7;
    if (anyFrontLifted) {
      ctx.fillStyle = isRagdoll ? '#f7f5f0' : catBlack;
      ctx.strokeStyle = inkOutline;
      ctx.lineWidth = 1.9;
      for (const [fx, fy, rx, ry] of [
        [basePt.x - 42, basePt.y - 3, 14.5, 11.5],
        [basePt.x + 32, basePt.y - 1, 15.0, 11.5],
      ]) {
        ctx.beginPath();
        ctx.ellipse(fx, fy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        if (isRagdoll) {
          ctx.save();
          ctx.shadowBlur = 0;
          ctx.shadowOffsetY = 0;
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // 2) Build exact smooth spline through measured silhouette slices (left top -> right top -> right down -> bottom -> left up)!
    const traceBodyPath = () => {
      ctx.beginPath();
      const crownCos = Math.cos(this.headTilt);
      const crownSin = Math.sin(this.headTilt);
      ctx.moveTo(leftPts[0].x + 14 * crownCos + 6 * crownSin, leftPts[0].y + 14 * crownSin - 6 * crownCos);
      ctx.quadraticCurveTo(crownPt.x, crownPt.y - 2, rightPts[0].x - 14 * crownCos + 6 * crownSin, rightPts[0].y - 14 * crownSin - 6 * crownCos);

      ctx.lineTo(rightPts[0].x, rightPts[0].y);
      for (let i = 0; i < rightPts.length - 1; i++) {
        const p0 = rightPts[i];
        const p1 = rightPts[i + 1];
        const mx = (p0.x + p1.x) * 0.5;
        const my = (p0.y + p1.y) * 0.5;
        ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
      }
      const lastR = rightPts[rightPts.length - 1];
      ctx.lineTo(lastR.x, lastR.y);

      const lastL = leftPts[leftPts.length - 1];
      ctx.quadraticCurveTo(basePt.x + purrShift, basePt.y + 6, lastL.x, lastL.y);

      for (let i = leftPts.length - 1; i > 0; i--) {
        const p0 = leftPts[i];
        const p1 = leftPts[i - 1];
        const mx = (p0.x + p1.x) * 0.5;
        const my = (p0.y + p1.y) * 0.5;
        ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
      }
      ctx.lineTo(leftPts[0].x, leftPts[0].y);
      ctx.closePath();
    };

    traceBodyPath();
    if (isRagdoll) {
      // Warm creamy ivory base coat matching the real fluffy Ragdoll photo!
      const furGrad = ctx.createRadialGradient(hcx, hcy + 68, 18, basePt.x, basePt.y - 60, 148);
      furGrad.addColorStop(0.0, '#fbf9f3');
      furGrad.addColorStop(0.68, '#f4f0e6');
      furGrad.addColorStop(1.0, '#e8e2d6');
      ctx.fillStyle = furGrad;
      ctx.fill();

      // Paint custom warm milk-tea taupe Ragdoll markings clipped cleanly inside the body silhouette!
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.clip();

      // 2a) Plush warm taupe-brown lower flanks / hips wrapping around both outer thighs (matches photo!)
      const midTorso = this.spinePoint(0.72, breath);
      for (const sgn of [-1, 1]) {
        const flankGrad = ctx.createRadialGradient(
          midTorso.x + purrShift + sgn * 70,
          midTorso.y + 8,
          14,
          midTorso.x + purrShift + sgn * 50,
          midTorso.y + 10,
          72,
        );
        flankGrad.addColorStop(0.0, 'rgba(130, 115, 100, 0.78)');
        flankGrad.addColorStop(0.50, 'rgba(156, 141, 126, 0.45)');
        flankGrad.addColorStop(0.82, 'rgba(178, 165, 150, 0.14)');
        flankGrad.addColorStop(1.0, 'rgba(190, 178, 164, 0.0)');
        ctx.fillStyle = flankGrad;
        ctx.beginPath();
        ctx.ellipse(midTorso.x + purrShift + sgn * 60, midTorso.y + 8, 52, 84, sgn * -0.14, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2b) Subtle fluffy creamy-white chest lion-mane fur tufts under chin
      const neckSp = this.spinePoint(0.47, breath);
      ctx.strokeStyle = 'rgba(182, 170, 156, 0.36)';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(neckSp.x + purrShift, neckSp.y - 2, 34, 0.22 * Math.PI, 0.78 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(neckSp.x + purrShift - 16, neckSp.y + 18, 14, 0.18 * Math.PI, 0.72 * Math.PI);
      ctx.arc(neckSp.x + purrShift + 16, neckSp.y + 18, 14, 0.28 * Math.PI, 0.82 * Math.PI);
      ctx.stroke();

      // 2c) Custom warm milk-tea taupe crown cap & wide fluffy creamy-white blaze (1:1 match to user's real Ragdoll photos!)
      ctx.save();
      ctx.translate(hcx, hcy);
      ctx.rotate(this.headTilt);

      const maskShift = this.faceTurnX * 0.72;
      // Rich warm latte-taupe head mask covering crown, ears base, temples & outer cheeks
      const capGrad = ctx.createLinearGradient(0, -40, 0, 22);
      capGrad.addColorStop(0.0, '#8d7d6e');
      capGrad.addColorStop(0.42, '#9e8e7f');
      capGrad.addColorStop(0.84, '#b3a495');
      capGrad.addColorStop(1.0, 'rgba(186, 173, 158, 0.14)');

      ctx.fillStyle = capGrad;
      ctx.shadowColor = 'rgba(138, 122, 108, 0.45)';
      ctx.shadowBlur = 4.8;

      // Full warm milk-tea head mask curving around outer eyes & cheeks, opening into a wide soft fluffy white blaze!
      ctx.beginPath();
      ctx.moveTo(-74, -44);
      ctx.lineTo(74, -44);
      ctx.lineTo(70, 20);
      ctx.quadraticCurveTo(maskShift + 42, 18, maskShift + 26, 9);
      ctx.quadraticCurveTo(maskShift + 17, 0, maskShift + 13.5, -13);
      // Soft wide fluffy dome peak of the creamy-white blaze between the brows (warm latte bridge stays connected across forehead!)
      ctx.quadraticCurveTo(maskShift + 7, -21.5, maskShift, -22.5);
      ctx.quadraticCurveTo(maskShift - 7, -21.5, maskShift - 13.5, -13);
      ctx.quadraticCurveTo(maskShift - 17, 0, maskShift - 26, 9);
      ctx.quadraticCurveTo(maskShift - 42, 18, -70, 20);
      ctx.closePath();
      ctx.fill();

      // Lighter warm champagne-beige soft forehead bridge highlight right between the ears (exact match to close-up photo!)
      ctx.shadowBlur = 5.5;
      ctx.fillStyle = 'rgba(208, 194, 176, 0.58)';
      ctx.beginPath();
      ctx.ellipse(maskShift, -32, 18, 9, 0, 0, Math.PI * 2);
      ctx.fill();

      // Deeper warm taupe-brown shading along outer temples below both ears
      ctx.fillStyle = 'rgba(116, 100, 86, 0.40)';
      ctx.beginPath();
      ctx.ellipse(-44 + maskShift * 0.4, -10, 21, 22, -0.18, 0, Math.PI * 2);
      ctx.ellipse(44 + maskShift * 0.4, -10, 21, 22, 0.18, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore(); // end mask head-space
      ctx.restore(); // end body clip

      // Clean refined soft warm-brown body outline so creamy fur pops crisply on BOTH light & dark wallpapers!
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      traceBodyPath();
      ctx.strokeStyle = inkOutline;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = catBlack;
      ctx.fill();
    }

    // 3) Compact plush rounded cat ears matching ORIG 0.3s exact height (shorter & cuter, no tall rabbit ears!)
    ctx.save();
    ctx.translate(hcx, hcy);
    ctx.rotate(this.headTilt);

    const drawOneEar = (sideSign: -1 | 1) => {
      const ear = this.getEarPose(sideSign);
      ctx.save();
      ctx.translate(ear.x, ear.y);
      ctx.rotate(ear.rot);
      ctx.scale(ear.scaleX, ear.scaleY);
      const tb = ear.tipBend;

      const earPath = () => {
        ctx.beginPath();
        ctx.moveTo(sideSign * 19, 20);
        ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12 + tb * 0.5, -23, sideSign * 3 + tb, -21);
        ctx.bezierCurveTo(sideSign * -8 + tb * 0.4, -18, sideSign * -16, -6, sideSign * -21, 8);
        ctx.closePath();
      };

      if (isRagdoll) {
        // Rich dark espresso-taupe ear rims fading to soft warm latte base (1:1 match to user's real cat!)
        const earGrad = ctx.createLinearGradient(0, -23, 0, 18);
        earGrad.addColorStop(0.0, '#463b33');
        earGrad.addColorStop(0.42, '#625449');
        earGrad.addColorStop(0.82, '#8b7c6e');
        earGrad.addColorStop(1.0, '#9c8d7e');
        ctx.fillStyle = earGrad;
        earPath();
        ctx.fill();

        // Stroke outer ear rim cleanly (open at bottom skull merge so there is zero seam line!)
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.strokeStyle = '#473c34';
        ctx.lineWidth = 1.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sideSign * 19, 17);
        ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12 + tb * 0.5, -23, sideSign * 3 + tb, -21);
        ctx.bezierCurveTo(sideSign * -8 + tb * 0.4, -18, sideSign * -16, -6, sideSign * -19, 5);
        ctx.stroke();

        // Soft warm dusty-blush cream inner ear
        ctx.fillStyle = '#dec4be';
        ctx.beginPath();
        ctx.moveTo(sideSign * 11, 10);
        ctx.bezierCurveTo(sideSign * 11, -3, sideSign * 7 + tb * 0.35, -13, sideSign * 2 + tb * 0.6, -11);
        ctx.bezierCurveTo(sideSign * -4 + tb * 0.25, -9, sideSign * -9, -1, sideSign * -10, 8);
        ctx.closePath();
        ctx.fill();

        // Fluffy creamy-white Ragdoll ear furnishings
        ctx.strokeStyle = 'rgba(252, 249, 242, 0.90)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(sideSign * -7, 6);
        ctx.quadraticCurveTo(sideSign * -1, 3, sideSign * 5, 6);
        ctx.moveTo(sideSign * -4, 10);
        ctx.quadraticCurveTo(sideSign * 2, 7.5, sideSign * 8, 10);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.fillStyle = catBlack;
        earPath();
        ctx.fill();
      }
      ctx.restore();
    };

    drawOneEar(-1);
    drawOneEar(1);

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    const wShift = this.faceTurnX * 0.72;

    // Mood: rosy cheeks when relaxed by music, furrowed brows when stuck typing too long.
    this.drawMoodBlush(ctx, wShift, isRagdoll ? '#f492a6' : '#ff8fa3');

    // 4) Ragdoll rosy petting blush + adorable tiny pink nose & gentle kitten smile!
    if (isRagdoll) {
      if (this.squintAmount > 0.12) {
        ctx.fillStyle = `rgba(244, 146, 166, ${(0.42 * this.squintAmount).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(wShift - 30, 13, 8.5, 4.6, -0.08, 0, Math.PI * 2);
        ctx.ellipse(wShift + 30, 13, 8.5, 4.6, 0.08, 0, Math.PI * 2);
        ctx.fill();
      }

      // Cute rosy-pink Ragdoll nose centered neatly inside the snow-white inverted-V blaze
      ctx.fillStyle = '#ee8e9e';
      ctx.beginPath();
      ctx.moveTo(wShift - 4.1, 9.6);
      ctx.quadraticCurveTo(wShift, 8.5, wShift + 4.1, 9.6);
      ctx.quadraticCurveTo(wShift + 3.2, 13.8, wShift, 14.3);
      ctx.quadraticCurveTo(wShift - 3.2, 13.8, wShift - 4.1, 9.6);
      ctx.closePath();
      ctx.fill();

      // Delicate cute kitten "w" mouth
      ctx.strokeStyle = 'rgba(72, 77, 92, 0.80)';
      ctx.lineWidth = 1.35;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(wShift - 5.8, 16.6);
      ctx.quadraticCurveTo(wShift - 2.9, 19.6, wShift, 16.4);
      ctx.quadraticCurveTo(wShift + 2.9, 19.6, wShift + 5.8, 16.6);
      ctx.stroke();
    }

    // 5) Delicate wispy cheek whiskers adapting to 2.5D head turn
    ctx.strokeStyle = isRagdoll ? 'rgba(98, 86, 76, 0.52)' : 'rgba(205, 208, 214, 0.54)';
    ctx.lineWidth = isRagdoll ? 1.15 : 1.05;
    ctx.lineCap = 'round';
    const leftLen = Math.max(8, 12 - this.faceTurnX * 0.55);
    const rightLen = Math.max(8, 12 + this.faceTurnX * 0.55);
    for (let i = 0; i < 3; i++) {
      const wy = 16 + i * 5.0;
      const slant = 2.0 + i * 1.1;
      ctx.beginPath();
      ctx.moveTo(-34 + wShift, wy);
      ctx.lineTo(-34 + wShift - leftLen, wy + slant);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(34 + wShift, wy);
      ctx.lineTo(34 + wShift + rightLen, wy + slant);
      ctx.stroke();
    }

    // 6) Expressive eyes (lemon-chartreuse for Black Cat / luminous sapphire-blue for Ragdoll!)
    this.drawEyes(ctx, wShift, -1);
    this.drawAngryBrows(ctx, wShift, isRagdoll ? 'rgba(56, 46, 40, 0.92)' : 'rgba(255, 226, 214, 0.92)');
    this.drawHeadphones(ctx, !isRagdoll, isRagdoll ? '#7ac7ff' : '#d2f244');

    ctx.restore(); // end head

    ctx.restore();
  }

  private drawEyes(ctx: CanvasRenderingContext2D, cx: number, eyeY: number): void {
    const isRagdoll = this.catBreed === 'ragdoll';
    const blinkVal = this.isBlinking ? 1 - Math.abs(this.blinkProgress - 1) : 0;
    const closedness = Math.max(
      blinkVal,
      this.squintAmount * 0.85,
      this.privacyClose,
      this.sleepyAmount * 0.95,
    );

    // Exact measured eye spacing & size from original 0.3s & 10.6s!
    const eyeXs = [cx - 23.0, cx + 23.0];
    const rx = 14.8 + this.typingHunch * 1.0;
    const ry = 13.4 - this.typingHunch * 0.5;

    for (let idx = 0; idx < 2; idx++) {
      const ex = eyeXs[idx];
      ctx.save();
      ctx.translate(ex, eyeY);

      if (this.privacyClose > 0.45) {
        ctx.strokeStyle = isRagdoll ? '#212533' : '#d4f044';
        ctx.lineWidth = 2.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-13.5, -0.5);
        ctx.quadraticCurveTo(0, 5.2, 13.5, -0.5);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (this.squintAmount > 0.38 && blinkVal < 0.3) {
        if (isRagdoll) {
          // Sleek lazy drooping slits with a subtle crystal-blue underside shimmer!
          ctx.strokeStyle = 'rgba(174, 224, 255, 0.72)';
          ctx.lineWidth = 4.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-12.5, 0.2);
          ctx.quadraticCurveTo(0, 2.2, 12.5, 1.8);
          ctx.stroke();

          ctx.strokeStyle = '#212533';
          ctx.lineWidth = 2.7;
          ctx.beginPath();
          ctx.moveTo(-13.5, -0.5);
          ctx.quadraticCurveTo(0, 1.4, 13.5, 1.2);
          ctx.stroke();
        } else {
          // Exact sleek thin horizontal lazy-slanted lemon-chartreuse slits from user's reference photo (NO grey lid blob!)
          ctx.strokeStyle = '#d4f044';
          ctx.lineWidth = 2.9;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-13.5, -0.5);
          ctx.quadraticCurveTo(0, 1.4, 13.5, 1.2);
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }

      const openRy =
        Math.max(1.2, ry * (1 - closedness)) *
        (1 - this.relaxAmount * 0.16) *
        (1 - this.annoyAmount * 0.3) *
        (1 + this.curiousAmount * 0.18);
      const curiousTilt = (idx === 0 ? -0.1 : 0.1) * (0.25 + this.typingHunch * 0.75);
      ctx.rotate(curiousTilt);

      if (isRagdoll) {
        // Gentle soulful sky-cerulean Ragdoll eyes (warm & lifelike, matching user's Ragdoll!)
        const irisGrad = ctx.createLinearGradient(0, -openRy, 0, openRy);
        irisGrad.addColorStop(0.0, '#2c5594');
        irisGrad.addColorStop(0.50, '#5a94d6');
        irisGrad.addColorStop(1.0, '#a3d2f2');
        ctx.fillStyle = irisGrad;
      } else {
        ctx.fillStyle = '#d4f044';
      }

      ctx.beginPath();
      ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.clip();

      if (openRy > 3.2) {
        // Expressive pupil hugging lower rim when looking down at keyboard!
        const px = this.eyeLookX * (1 + this.curiousAmount * 0.35);
        const py = this.eyeLookY * (1 + this.curiousAmount * 0.35);
        const pupilRx = 6.2 * (1 + this.critterHunt * 0.38);
        const pupilRy = 8.8 * (1 + this.critterHunt * 0.22);

        ctx.fillStyle = isRagdoll ? '#101624' : '#0e0e10';
        ctx.beginPath();
        ctx.ellipse(px, py, pupilRx, pupilRy, 0, 0, Math.PI * 2);
        ctx.fill();

        if (isRagdoll) {
          // Crisp glossy twin starlight catchlights for dreamy Ragdoll doll eyes!
          ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
          ctx.beginPath();
          ctx.arc(px - 3.6, py - 4.0, 2.5, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
          ctx.beginPath();
          ctx.arc(px + 3.2, py + 3.2, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();

      if (isRagdoll && openRy > 2.2) {
        // Delicate velvety eye rim so sapphire iris frames cleanly inside the blue-grey mask
        ctx.strokeStyle = 'rgba(34, 39, 54, 0.85)';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  private drawMiniMouse(ctx: CanvasRenderingContext2D): void {
    const mx = this.mouseBaseX + this.mouseOffsetX;
    const my = this.mouseBaseY + this.mouseOffsetY;
    const rx = 18.5;
    const ry = 23.0;
    const lPress = this.mouseLeftPress;
    const rPress = this.mouseRightPress;
    const mPress = Math.max(this.mouseMiddlePress, this.mouseScrollFlash);
    const colors = this.getMouseButtonColors();
    const th = this.deskTheme;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(-0.06);

    // Soft 3D base rim / drop shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 3.5;
    if (th.underglow) {
      ctx.shadowColor = th.underglow;
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 2;
    }
    ctx.fillStyle = th.mouseBase;
    ctx.beginPath();
    ctx.ellipse(0, 1.8, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Main mouse palm shell (rear/palm at TOP closest to cat; split L/R buttons at BOTTOM pointing away from cat)
    const palmGrad = ctx.createLinearGradient(0, -ry, 0, 2);
    palmGrad.addColorStop(0.0, th.mouseShellTop);
    palmGrad.addColorStop(1.0, th.mouseShellBottom);
    ctx.fillStyle = palmGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // Clip inside mouse silhouette to render strictly separated Left / Right front button plates!
    const isCatFacing = this.keyboardOrientation === 'cat';
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx - 0.5, ry - 0.5, 0, 0, Math.PI * 2);
    ctx.clip();

    // Orientation-aware button/wheel geometry:
    // - 'cat' (180°): palm at TOP, buttons at BOTTOM, L = +X (inner), R = -X (outer)
    // - 'viewer' (0°): buttons at TOP, palm at BOTTOM, L = -X (left), R = +X (right)
    ctx.save();
    if (!isCatFacing) {
      ctx.scale(-1, -1);
    }

    const traceSeam = () => {
      ctx.moveTo(-rx - 2, -0.8);
      ctx.quadraticCurveTo(0, 1.8, rx + 2, -0.8);
    };

    // 1) Left Mouse Button plate (+X half in local coords -> inner-bottom in cat mode, top-left in viewer mode)
    ctx.beginPath();
    ctx.moveTo(0, 0.5);
    ctx.quadraticCurveTo(rx * 0.52, 0.4, rx + 2, -0.8);
    ctx.lineTo(rx + 2, ry + 2);
    ctx.lineTo(0, ry + 2);
    ctx.closePath();
    ctx.fillStyle = lPress > 0.08 ? colors.left : th.mouseButton;
    ctx.fill();
    if (lPress > 0.08) {
      ctx.fillStyle = `rgba(18, 22, 28, ${(0.18 * lPress).toFixed(3)})`;
      ctx.fillRect(0, -1, rx + 2, 3.8);
      ctx.fillRect(0, -1, 2.2, ry + 2);
    }

    // 2) Right Mouse Button plate (-X half in local coords -> outer-bottom in cat mode, top-right in viewer mode)
    ctx.beginPath();
    ctx.moveTo(-rx - 2, -0.8);
    ctx.quadraticCurveTo(-rx * 0.52, 0.4, 0, 0.5);
    ctx.lineTo(0, ry + 2);
    ctx.lineTo(-rx - 2, ry + 2);
    ctx.closePath();
    ctx.fillStyle = rPress > 0.08 ? colors.right : th.mouseButton;
    ctx.fill();
    if (rPress > 0.08) {
      ctx.fillStyle = `rgba(18, 22, 28, ${(0.18 * rPress).toFixed(3)})`;
      ctx.fillRect(-rx - 2, -1, rx + 2, 3.8);
      ctx.fillRect(-2.2, -1, 2.2, ry + 2);
    }

    // Crisp horizontal palm-to-button seam & vertical center L/R split line
    ctx.strokeStyle = th.mouseSeam;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    traceSeam();
    ctx.stroke();

    ctx.strokeStyle = th.mouseSeam;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(0, 0.6);
    ctx.lineTo(0, ry + 1);
    ctx.stroke();

    // Recessed scroll wheel housing + interactive wheel (middle click & scroll glow)
    ctx.fillStyle = th.mouseWheelHousing;
    this.roundRect(ctx, -2.5, 4.2, 5.0, 9.4, 2.5);
    ctx.fill();

    ctx.fillStyle = mPress > 0.12 ? colors.middle : th.mouseWheel;
    this.roundRect(ctx, -1.7, 5.0 + this.mouseMiddlePress * 0.8, 3.4, 7.6, 1.7);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-1.0, 8.8 + this.mouseMiddlePress * 0.8);
    ctx.lineTo(1.0, 8.8 + this.mouseMiddlePress * 0.8);
    ctx.stroke();

    ctx.restore(); // end local orientation transform

    // Always draw upright crisp L / R button legends in unobstructed front tips!
    ctx.font = '800 7.6px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lx = isCatFacing ? 7.4 : -7.4;
    const rxLbl = isCatFacing ? -7.4 : 7.4;
    const lyBase = isCatFacing ? 14.0 : -14.0;
    const pressDir = isCatFacing ? 0.9 : -0.9;
    ctx.fillStyle = lPress > 0.12 ? '#14161a' : th.mouseLegend;
    ctx.fillText('L', lx, lyBase + lPress * pressDir);
    ctx.fillStyle = rPress > 0.12 ? '#ffffff' : th.mouseLegend;
    ctx.fillText('R', rxLbl, lyBase + rPress * pressDir);

    ctx.restore(); // end mouse clip

    // Crisp outer silhouette stroke
    ctx.strokeStyle = th.mouseOutline;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  private ensureKeyboardCache(): HTMLCanvasElement | null {
    const th = this.deskTheme;
    const cacheKey = `${this.keyboardLayout}:${this.keyboardOrientation}:${this.kbWidth}x${this.kbHeight}:${th.id}`;
    if (this.kbCacheCanvas && this.kbCacheKey === cacheKey) {
      return this.kbCacheCanvas;
    }

    const layout = getKeyboardLayout(this.keyboardLayout);
    const isCatFacing = this.keyboardOrientation === 'cat';
    const is108 = this.keyboardLayout === '108';
    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;
    const topHalfW = (this.kbWidth * 0.955) / 2;
    const botHalfW = (this.kbWidth * 1.035) / 2;
    const halfH = this.kbHeight / 2;

    const margin = 24;
    const logW = Math.ceil(botHalfW * 2) + margin * 2;
    const logH = Math.ceil(this.kbHeight) + margin * 2;
    const supersample = 2.5;

    const offscreen = this.kbCacheCanvas ?? document.createElement('canvas');
    offscreen.width = Math.ceil(logW * supersample);
    offscreen.height = Math.ceil(logH * supersample);
    const octx = offscreen.getContext('2d');
    if (!octx) return null;

    octx.clearRect(0, 0, offscreen.width, offscreen.height);
    octx.save();
    octx.scale(supersample, supersample);
    octx.translate(logW / 2, logH / 2);

    // Base shadow (baked once instead of shadowBlur=11 every frame!)
    octx.save();
    octx.shadowColor = th.underglow ?? 'rgba(0, 0, 0, 0.34)';
    octx.shadowBlur = th.underglow ? 14 : 11;
    octx.shadowOffsetY = th.underglow ? 3 : 5;
    octx.fillStyle = th.caseShadow;
    this.trapezoidPath(octx, topHalfW, botHalfW, -halfH + 3.5, halfH + 5.5, 6.5);
    octx.fill();
    octx.restore();

    octx.fillStyle = th.caseFill;
    octx.strokeStyle = th.caseStroke;
    octx.lineWidth = 1.1;
    this.trapezoidPath(octx, topHalfW, botHalfW, -halfH, halfH, 6.5);
    octx.fill();
    octx.stroke();

    // Bright clean light-grey inner keybed matching ORIG 0.3s bright airy white keyboard!
    octx.fillStyle = th.keybed;
    this.trapezoidPath(octx, topHalfW - 5, botHalfW - 5, -halfH + 4, halfH - 4, 3.5);
    octx.fill();

    const rowH = innerH / layout.totalRows;
    const unitW = innerW / layout.totalUnits;
    const gap = is108 ? 0.85 : 0.9;

    for (const key of layout.keys) {
      const rY = key.rowY ?? key.row;
      const rSpan = key.rowSpan ?? 1;
      const screenRowTop = isCatFacing ? layout.totalRows - (rY + rSpan) : rY;
      const screenUStart = isCatFacing
        ? layout.totalUnits - (key.uStart + key.uWidth)
        : key.uStart;

      const rowCenterFrac = (screenRowTop + rSpan * 0.5) / layout.totalRows;
      const depthScale = 0.94 + rowCenterFrac * 0.09;

      const rawX = -innerW / 2 + screenUStart * unitW + gap * 0.5;
      const rawW = key.uWidth * unitW - gap;
      const x = rawX * depthScale;
      const w = rawW * depthScale;
      const y = -innerH / 2 + screenRowTop * rowH + gap * 0.5;
      const h = rSpan * rowH - gap - 0.8;

      let topColor = th.keyTop;
      let sideColor = th.keySide;
      if (key.accent === 'orange') {
        topColor = th.accentTop;
        sideColor = th.accentSide;
      } else if (key.accent === 'mod') {
        topColor = th.modTop;
        sideColor = th.modSide;
      }

      octx.fillStyle = sideColor;
      this.roundRect(octx, x, y + 1.4, w, h, 1.8);
      octx.fill();

      octx.fillStyle = topColor;
      this.roundRect(octx, x, y, w, h - 0.9, 1.8);
      octx.fill();

      const legend = key.id === 'space' ? '' : key.id === 'esc' ? 'Esc' : key.label;
      if (legend) {
        const isWideWord = legend.length >= 3;
        const fontSize = is108
          ? isWideWord
            ? 5.0
            : legend.length === 2
              ? 5.8
              : 7.2
          : isWideWord
            ? 5.6
            : legend.length === 2
              ? 6.4
              : 7.8;
        octx.save();
        octx.translate(x + w * 0.5, y + (h - 0.9) * 0.50);
        if (isCatFacing) {
          octx.rotate(Math.PI);
        }
        octx.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
        octx.fillStyle = key.accent === 'orange' ? th.accentLegend : th.legend;
        octx.textAlign = 'center';
        octx.textBaseline = 'middle';
        octx.fillText(legend, 0, 0);
        octx.restore();
      }
    }

    octx.restore();
    this.kbCacheCanvas = offscreen;
    this.kbCacheKey = cacheKey;
    this.kbCacheLogW = logW;
    this.kbCacheLogH = logH;
    return offscreen;
  }

  private drawKeyboard(ctx: CanvasRenderingContext2D): void {
    const layout = getKeyboardLayout(this.keyboardLayout);
    const isCatFacing = this.keyboardOrientation === 'cat';
    const is108 = this.keyboardLayout === '108';
    const th = this.deskTheme;
    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;

    ctx.save();
    ctx.translate(this.kbCenterX, this.kbCenterY + this.kbBounce * 1.1);
    ctx.rotate(this.kbTiltRad);

    // True 3D desk trapezoid perspective: far edge (top) is narrower, near edge (bottom) is wider,
    // cleanly re-projected for BOTH cat-facing (Spacebar at narrow top) and viewer-facing (Esc/F-row at narrow top)!
    const topHalfW = (this.kbWidth * 0.955) / 2;
    const botHalfW = (this.kbWidth * 1.035) / 2;
    const halfH = this.kbHeight / 2;

    const cached = this.ensureKeyboardCache();
    if (cached) {
      ctx.drawImage(
        cached,
        -this.kbCacheLogW / 2,
        -this.kbCacheLogH / 2,
        this.kbCacheLogW,
        this.kbCacheLogH,
      );
    }

    const rowH = innerH / layout.totalRows;
    const unitW = innerW / layout.totalUnits;
    const gap = is108 ? 0.85 : 0.9;

    // Only redraw actively pressed/animating keys over the cached base keyboard!
    for (const key of layout.keys) {
      const anim = this.keyAnims.get(key.id);
      const press = anim ? anim.pressAmount : 0;
      if (cached && press <= 0.01) {
        continue;
      }

      const rY = key.rowY ?? key.row;
      const rSpan = key.rowSpan ?? 1;
      const screenRowTop = isCatFacing ? layout.totalRows - (rY + rSpan) : rY;
      const screenUStart = isCatFacing
        ? layout.totalUnits - (key.uStart + key.uWidth)
        : key.uStart;

      const rowCenterFrac = (screenRowTop + rSpan * 0.5) / layout.totalRows;
      const depthScale = 0.94 + rowCenterFrac * 0.09;

      const rawX = -innerW / 2 + screenUStart * unitW + gap * 0.5;
      const rawW = key.uWidth * unitW - gap;
      const x = rawX * depthScale;
      const w = rawW * depthScale;
      const baseY = -innerH / 2 + screenRowTop * rowH + gap * 0.5;
      const y = baseY + press * 2.0;
      const h = rSpan * rowH - gap - 0.8;

      // Clear the unpressed keycap top strip behind the depressed key so it looks cleanly sunken
      if (cached && press > 0.01) {
        ctx.fillStyle = th.keybed;
        ctx.fillRect(x - 0.3, baseY - 0.3, w + 0.6, h + 2.0);
      }

      let topColor = th.keyTop;
      let sideColor = th.keySide;
      if (press > 0.14) {
        topColor = this.customSkin
          ? this.customSkin.accentColor
          : this.catBreed === 'dafeiyu'
            ? '#5cc8ff'
            : this.catBreed === 'ragdoll'
              ? '#7ac7ff'
              : '#d2f244';
        sideColor = this.customSkin
          ? this.customSkin.accentSideColor
          : this.catBreed === 'dafeiyu'
            ? '#2563eb'
            : this.catBreed === 'ragdoll'
              ? '#4690d8'
              : '#8cb014';
      } else if (key.accent === 'orange') {
        topColor = th.accentTop;
        sideColor = th.accentSide;
      } else if (key.accent === 'mod') {
        topColor = th.modTop;
        sideColor = th.modSide;
      }

      ctx.fillStyle = sideColor;
      this.roundRect(ctx, x, y + 1.4, w, h, 1.8);
      ctx.fill();

      ctx.fillStyle = topColor;
      this.roundRect(ctx, x, y, w, h - 0.9, 1.8);
      ctx.fill();

      // Keycap legends: rotated 180° in cat-facing mode, upright 0° in viewer-facing mode!
      const legend = key.id === 'space' ? '' : key.id === 'esc' ? 'Esc' : key.label;
      if (legend) {
        const isWideWord = legend.length >= 3;
        const fontSize = is108
          ? isWideWord
            ? 5.0
            : legend.length === 2
              ? 5.8
              : 7.2
          : isWideWord
            ? 5.6
            : legend.length === 2
              ? 6.4
              : 7.8;
        ctx.save();
        ctx.translate(x + w * 0.5, y + (h - 0.9) * 0.50);
        if (isCatFacing) {
          ctx.rotate(Math.PI);
        }
        ctx.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
        ctx.fillStyle = press > 0.14
          ? '#111214'
          : key.accent === 'orange'
            ? th.accentLegend
            : th.legend;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(legend, 0, 0);
        ctx.restore();
      }
    }

    if (this.privacyClose > 0.08) {
      ctx.save();
      ctx.globalAlpha = this.privacyClose;
      ctx.fillStyle = 'rgba(15, 20, 32, 0.74)';
      this.trapezoidPath(ctx, topHalfW - 2, botHalfW - 2, -halfH + 1.5, halfH - 1.5, 5.5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(244, 114, 182, 0.45)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.font = '700 11.5px "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillStyle = '#fbcfe8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const dots = performance.now() - this.privacyTypingAt < 350 ? ' • • •' : '';
      const label = this.catBreed === 'dafeiyu' ? '🔒 非礼勿视 · 已隐藏按键' : '🔒 密码输入中 · 已隐藏按键';
      ctx.fillText(label + dots, 0, 0);
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * True-scale plush velvety cat arm & chubby rounded paw ball (1:1 match to reference photo & 8.3s / 13.2s / 31.0s!)
   */
  private drawPlumpCatArm(
    ctx: CanvasRenderingContext2D,
    side: 'left' | 'right',
    sx: number,
    sy: number,
    px: number,
    py: number,
    squash: number,
    withCrease: boolean,
  ): void {
    const dx = px - sx;
    const dy = py - sy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;

    const wristDist = Math.max(6, len - 8);
    const wx = sx + ux * wristDist;
    const wy = sy + uy * wristDist;

    // True-scale plush proportions for 248px tall cat!
    const rShoulder = 14.2;
    const rWrist = 9.4;
    const pawRx = 14.5 * (1 + squash * 0.14);
    const pawRy = 11.8 * (1 - squash * 0.12);

    if (this.customSkin) {
      this.drawCustomPlumpArm(ctx, this.customSkin, side, sx, sy, px, py, squash, withCrease);
      return;
    }

    const isRagdoll = this.catBreed === 'ragdoll';
    ctx.save();

    if (isRagdoll) {
      // Seamless pure creamy snow-white Ragdoll mitten arm melting smoothly out of the white chest!
      const armGrad = ctx.createLinearGradient(sx, sy, px, py);
      armGrad.addColorStop(0.0, '#f5f1e8');
      armGrad.addColorStop(0.5, '#f9f6ef');
      armGrad.addColorStop(1.0, '#fcfaf4');

      ctx.fillStyle = armGrad;

      // Tapered snow-white arm silhouette (NO dark shadow smudge over the white chest!)
      const traceArmPath = () => {
        ctx.beginPath();
        ctx.moveTo(sx + nx * rShoulder, sy + ny * rShoulder);
        ctx.quadraticCurveTo(
          (sx + wx) * 0.5 + nx * (rShoulder * 0.84),
          (sy + wy) * 0.5 + ny * (rShoulder * 0.84),
          wx + nx * rWrist,
          wy + ny * rWrist,
        );
        ctx.lineTo(wx - nx * rWrist, wy - ny * rWrist);
        ctx.quadraticCurveTo(
          (sx + wx) * 0.5 - nx * (rShoulder * 0.84),
          (sy + wy) * 0.5 - ny * (rShoulder * 0.84),
          sx - nx * rShoulder,
          sy - ny * rShoulder,
        );
        ctx.closePath();
      };
      traceArmPath();
      ctx.fill();

      // Seamless white shoulder merge (invisible against white chest — ZERO grey shoulder blob!)
      ctx.beginPath();
      ctx.arc(sx, sy, rShoulder, 0, Math.PI * 2);
      ctx.fill();

      // Signature unique marking from user's real Ragdoll photo: adorable warm taupe-brown oval patch on viewer's RIGHT front forearm!
      if (side === 'right' && len > 26) {
        ctx.save();
        traceArmPath();
        ctx.clip();
        const spotX = sx + ux * (len * 0.64) + nx * 2.0;
        const spotY = sy + uy * (len * 0.64) + ny * 2.0;
        const armAngle = Math.atan2(dy, dx);
        ctx.fillStyle = 'rgba(134, 118, 102, 0.84)';
        ctx.shadowColor = 'rgba(134, 118, 102, 0.45)';
        ctx.shadowBlur = 2.5;
        ctx.beginPath();
        ctx.ellipse(spotX, spotY, Math.min(13.5, len * 0.16), 8.2, armAngle, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Soft subtle contact shadow ONLY under the plump round white mitten paw ball
      ctx.save();
      ctx.shadowColor = 'rgba(46, 38, 30, 0.22)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1.5;
      ctx.fillStyle = '#fcfaf4';
      ctx.beginPath();
      ctx.ellipse(px, py, pawRx, pawRy, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Refined warm-taupe arm side strokes that fade gently out at the shoulder and stay crisp along forearm & paw!
      ctx.lineWidth = 1.65;
      ctx.lineCap = 'round';
      for (const sgn of [-1, 1]) {
        const startFrac = withCrease ? 0.16 : 0.08;
        const esx = sx + ux * (len * startFrac) + nx * sgn * (rShoulder * (1 - startFrac * 0.16));
        const esy = sy + uy * (len * startFrac) + ny * sgn * (rShoulder * (1 - startFrac * 0.16));
        const eex = wx + nx * sgn * rWrist;
        const eey = wy + ny * sgn * rWrist;

        const edgeGrad = ctx.createLinearGradient(esx, esy, eex, eey);
        edgeGrad.addColorStop(0.0, 'rgba(93, 81, 72, 0.0)');
        edgeGrad.addColorStop(0.24, 'rgba(93, 81, 72, 0.78)');
        edgeGrad.addColorStop(1.0, 'rgba(93, 81, 72, 0.92)');

        ctx.strokeStyle = edgeGrad;
        ctx.beginPath();
        ctx.moveTo(esx, esy);
        ctx.quadraticCurveTo(
          (sx + wx) * 0.5 + nx * sgn * (rShoulder * 0.84),
          (sy + wy) * 0.5 + ny * sgn * (rShoulder * 0.84),
          eex,
          eey,
        );
        ctx.stroke();
      }

      // Crisp rounded mitten paw outline arc so the white paw reads clearly against white keyboard keys!
      const pawAng = Math.atan2(dy, dx);
      ctx.strokeStyle = 'rgba(93, 81, 72, 0.92)';
      ctx.beginPath();
      ctx.ellipse(px, py, pawRx, pawRy, 0, pawAng - Math.PI * 0.62, pawAng + Math.PI * 0.62);
      ctx.stroke();

      ctx.restore();
      return;
    }

    ctx.shadowColor = 'rgba(18, 17, 18, 0.42)';
    ctx.shadowBlur = 1.6;
    ctx.fillStyle = '#141314';

    // Arm silhouette tapering gently from shoulder to wrist
    ctx.beginPath();
    ctx.moveTo(sx + nx * rShoulder, sy + ny * rShoulder);
    ctx.quadraticCurveTo(
      (sx + wx) * 0.5 + nx * (rShoulder * 0.84),
      (sy + wy) * 0.5 + ny * (rShoulder * 0.84),
      wx + nx * rWrist,
      wy + ny * rWrist,
    );
    ctx.lineTo(wx - nx * rWrist, wy - ny * rWrist);
    ctx.quadraticCurveTo(
      (sx + wx) * 0.5 - nx * (rShoulder * 0.84),
      (sy + wy) * 0.5 - ny * (rShoulder * 0.84),
      sx - nx * rShoulder,
      sy - ny * rShoulder,
    );
    ctx.closePath();
    ctx.fill();

    // Seamless shoulder merge
    ctx.beginPath();
    ctx.arc(sx, sy, rShoulder, 0, Math.PI * 2);
    ctx.fill();

    // Plump, soft rounded black velvet paw ball pressing firmly onto the key!
    ctx.beginPath();
    ctx.ellipse(px, py, pawRx, pawRy, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    // Clean crisp subtle light-grey side separation lines ONLY where the arm crosses the black body (exact 2.2s / 8.3s / 13.2s!)
    if (withCrease && len > 28) {
      const startFrac = 0.18;
      const endFrac = 0.72;
      for (const sgn of [-1, 1]) {
        const csx = sx + ux * (len * startFrac) + nx * sgn * (rShoulder * 0.86);
        const csy = sy + uy * (len * startFrac) + ny * sgn * (rShoulder * 0.86);
        const cex = sx + ux * (len * endFrac) + nx * sgn * (rWrist * 1.02);
        const cey = sy + uy * (len * endFrac) + ny * sgn * (rWrist * 1.02);

        const creaseGrad = ctx.createLinearGradient(csx, csy, cex, cey);
        creaseGrad.addColorStop(0.0, 'rgba(216, 218, 222, 0.0)');
        creaseGrad.addColorStop(0.22, 'rgba(216, 218, 222, 0.65)');
        creaseGrad.addColorStop(0.84, 'rgba(216, 218, 222, 0.56)');
        creaseGrad.addColorStop(1.0, 'rgba(216, 218, 222, 0.0)');

        ctx.strokeStyle = creaseGrad;
        ctx.lineWidth = 1.3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(csx, csy);
        ctx.lineTo(cex, cey);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Real 2-segment articulated bent kitten arm (shoulder -> elbow -> curled plump paw on chest!)
   * Matches original video 8.3s (left paw), 10.6s (both paws), 23.2s, 26.2s!
   */
  private drawBentCurledArm(ctx: CanvasRenderingContext2D, paw: PawState, breath: number, alpha: number): void {
    const sh = this.getLiveShoulder(paw, breath);
    const cp = this.getLiveCurledPawPos(paw, breath);
    const sign = paw.side === 'left' ? -1 : 1;
    // Natural elbow bends slightly outward & down below shoulder before forearm curves inward-up!
    const elbowX = sh.x + sign * 8;
    const elbowY = cp.y + 8;

    if (this.customSkin) {
      this.drawCustomBentArm(ctx, this.customSkin, paw, breath, alpha);
      return;
    }

    const isRagdoll = this.catBreed === 'ragdoll';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Continuous bent velvety arm + plump curled paw
    ctx.strokeStyle = isRagdoll ? '#f6f2ea' : '#141314';
    ctx.lineWidth = 20;
    ctx.beginPath();
    ctx.moveTo(sh.x, sh.y);
    ctx.quadraticCurveTo(elbowX, elbowY, cp.x, cp.y);
    ctx.stroke();

    // Signature warm taupe-brown patch on viewer's RIGHT curled forearm too!
    if (isRagdoll && paw.side === 'right') {
      ctx.save();
      ctx.fillStyle = 'rgba(134, 118, 102, 0.78)';
      ctx.beginPath();
      ctx.ellipse((elbowX + cp.x) * 0.5 + 2, (elbowY + cp.y) * 0.5 + 1, 7.5, 5.2, -0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = isRagdoll ? '#fcfaf4' : '#141314';
    ctx.beginPath();
    ctx.ellipse(cp.x, cp.y, 12.5, 11.0, sign * 0.2, 0, Math.PI * 2);
    ctx.fill();

    // Clear crisp contour along the bent curled forearm & kitten paw
    const grad = ctx.createLinearGradient(elbowX, elbowY - 12, cp.x, cp.y + 12);
    if (isRagdoll) {
      grad.addColorStop(0.0, 'rgba(93, 81, 72, 0.0)');
      grad.addColorStop(0.28, 'rgba(93, 81, 72, 0.68)');
      grad.addColorStop(0.86, 'rgba(93, 81, 72, 0.78)');
      grad.addColorStop(1.0, 'rgba(93, 81, 72, 0.35)');
    } else {
      grad.addColorStop(0.0, 'rgba(214, 216, 220, 0.0)');
      grad.addColorStop(0.30, 'rgba(214, 216, 220, 0.65)');
      grad.addColorStop(0.85, 'rgba(220, 222, 226, 0.72)');
      grad.addColorStop(1.0, 'rgba(220, 222, 226, 0.25)');
    }

    ctx.strokeStyle = grad;
    ctx.lineWidth = isRagdoll ? 1.65 : 1.4;
    ctx.beginPath();
    ctx.moveTo(elbowX + sign * 8, elbowY - 16);
    ctx.quadraticCurveTo(elbowX + sign * 4, elbowY + 12, cp.x + sign * 2, cp.y + 10);
    ctx.quadraticCurveTo(cp.x - sign * 11, cp.y + 8, cp.x - sign * 12, cp.y - 4);
    ctx.stroke();

    ctx.restore();
  }

  private drawPaw(ctx: CanvasRenderingContext2D, paw: PawState, breath: number): void {
    // 1) Seated idle vertical front legs (EXACT 4 clean lines of ORIG 0.3s!) OR planted diagonal supporting leg (ORIG 2.2s!)
    if (paw.idleWeight > 0.05) {
      ctx.save();
      ctx.globalAlpha = paw.idleWeight;

      if (paw.side === 'right' && this.leftPaw.mode === 'mouse') {
        const sh = this.getLiveShoulder(paw, breath);
        const baseSp = this.spinePoint(1.0, breath);
        this.drawPlumpCatArm(ctx, 'right', sh.x - 4, sh.y + 8, baseSp.x + 28, baseSp.y - 2, 0, true);
      } else {
        // Exact 4-line seated leg silhouette from ORIG 0.3s (outer curved leg line + crisp inner center-gap line!)
        const topSp = this.spinePoint(0.66, breath);
        const midSp = this.spinePoint(0.84, breath);
        const botSp = this.spinePoint(1.0, breath);
        const sign = paw.side === 'left' ? -1 : 1;

        const outerTopX = topSp.x + sign * 41;
        const outerBotX = botSp.x + sign * 35;
        const innerTopX = topSp.x + sign * 6.5;
        const innerBotX = botSp.x + sign * 9.5;

        if (this.customSkin) {
          this.drawCustomIdleLegDetails(ctx, this.customSkin, paw, topSp, midSp, botSp, sign, outerTopX, outerBotX, innerTopX, innerBotX);
          ctx.restore();
          return;
        }

        // Signature warm taupe-brown oval leg patch on viewer's RIGHT seated front leg (1:1 match to user's real Ragdoll!)
        const isRagdoll = this.catBreed === 'ragdoll';
        if (isRagdoll && paw.side === 'right') {
          ctx.save();
          ctx.fillStyle = 'rgba(134, 118, 102, 0.80)';
          ctx.shadowColor = 'rgba(134, 118, 102, 0.40)';
          ctx.shadowBlur = 3.0;
          ctx.beginPath();
          ctx.ellipse(midSp.x + 21, midSp.y + 12, 9.5, 13.5, 0.22, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Crisp subtle outer leg curve & inner leg-gap line (4 total lines across both legs — exact ORIG 0.3s!)
        const lineGrad = ctx.createLinearGradient(topSp.x, topSp.y, botSp.x, botSp.y);
        if (isRagdoll) {
          lineGrad.addColorStop(0.0, 'rgba(93, 81, 72, 0.0)');
          lineGrad.addColorStop(0.18, 'rgba(93, 81, 72, 0.62)');
          lineGrad.addColorStop(0.92, 'rgba(93, 81, 72, 0.68)');
          lineGrad.addColorStop(1.0, 'rgba(93, 81, 72, 0.28)');
        } else {
          lineGrad.addColorStop(0.0, 'rgba(210, 212, 216, 0.0)');
          lineGrad.addColorStop(0.18, 'rgba(210, 212, 216, 0.64)');
          lineGrad.addColorStop(0.92, 'rgba(210, 212, 216, 0.62)');
          lineGrad.addColorStop(1.0, 'rgba(210, 212, 216, 0.25)');
        }

        ctx.strokeStyle = lineGrad;
        ctx.lineWidth = isRagdoll ? 1.55 : 1.4;
        ctx.lineCap = 'round';

        // Outer front-leg separation line (gently curves inward toward paw!)
        ctx.beginPath();
        ctx.moveTo(outerTopX, topSp.y);
        ctx.quadraticCurveTo(midSp.x + sign * 41, midSp.y, outerBotX, botSp.y - 1);
        ctx.stroke();

        // Inner front-leg gap line (tapers slightly outward toward paws, exact inverted narrow V from ORIG 0.3s!)
        ctx.beginPath();
        ctx.moveTo(innerTopX, topSp.y + 10);
        ctx.lineTo(innerBotX, botSp.y - 1);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 2) Continuous bent articulated curled chest arm (8.3s / 10.6s / 23.2s / 26.2s!)
    if (paw.curlWeight > 0.05) {
      this.drawBentCurledArm(ctx, paw, breath, paw.curlWeight);
    }

    // 3) Plump velvety poking / mouse-holding cat arm!
    const activeArmWeight = Math.max(0, 1 - paw.idleWeight - paw.curlWeight);
    if (activeArmWeight > 0.05) {
      const sh = this.getLiveShoulder(paw, breath);
      const px = paw.pos.x;
      const mouseClickDrop =
        paw.mode === 'mouse'
          ? Math.max(this.mouseLeftPress, this.mouseRightPress, this.mouseMiddlePress) * 1.8
          : 0;
      const py = paw.pos.y + mouseClickDrop;

      ctx.save();
      ctx.globalAlpha = Math.min(1, activeArmWeight * 1.2);

      for (const sm of paw.smears) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, sm.alpha * activeArmWeight);
        this.drawPlumpCatArm(ctx, paw.side, sm.sx, sm.sy, sm.px, sm.py, 0, false);
        ctx.restore();
      }

      // Keep mouse-reaching arm pure velvet black in open air (ORIG 2.2s); show subtle separation lines when poking across black torso!
      this.drawPlumpCatArm(ctx, paw.side, sh.x, sh.y, px, py, paw.impactSquash, paw.mode !== 'mouse');
      ctx.restore();
    }
  }

  private drawKeyBubbles(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();

    for (const b of this.bubbles) {
      const age = now - b.createdAt;
      const t = Math.min(1, age / b.lifetime);

      let scale = 1;
      if (t < 0.11) {
        const p = t / 0.11;
        scale = 0.62 + Math.sin(p * Math.PI * 0.65) * 0.44;
      } else if (t > 0.76) {
        scale = 1 - ((t - 0.76) / 0.24) * 0.1;
      }
      const alpha = t < 0.72 ? 1 : Math.max(0, 1 - (t - 0.72) / 0.28);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.scale(scale, scale);

      ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
      const textW = ctx.measureText(b.label).width;
      const boxW = b.isSpace ? 40 : Math.max(24, textW + 13);
      const boxH = 24;
      const bx = -boxW / 2;
      const by = -boxH / 2;

      ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 2;

      ctx.fillStyle = '#c8cac6';
      this.roundRect(ctx, bx, by + 2.2, boxW, boxH, 5.5);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(38, 40, 46, 0.42)';
      ctx.lineWidth = 1.05;
      this.roundRect(ctx, bx, by, boxW, boxH - 1.3, 5.5);
      ctx.fill();
      ctx.stroke();

      if (b.isSpace) {
        ctx.strokeStyle = '#222429';
        ctx.lineWidth = 1.55;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(-9, -1);
        ctx.lineTo(-9, 2.0);
        ctx.lineTo(9, 2.0);
        ctx.lineTo(9, -1);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#1e2025';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.label, 0, -0.5);
      }

      ctx.restore();
    }
  }

  private drawMouseBadges(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();
    for (let i = 0; i < this.mouseBadges.length; i++) {
      const b = this.mouseBadges[i];
      const t = Math.min(1, (now - b.createdAt) / b.lifetime);
      let scale = 1;
      if (t < 0.14) {
        scale = 0.65 + Math.sin((t / 0.14) * Math.PI * 0.65) * 0.42;
      } else if (t > 0.72) {
        scale = 1 - ((t - 0.72) / 0.28) * 0.12;
      }
      const alpha = t < 0.68 ? 1 : Math.max(0, 1 - (t - 0.68) / 0.32);
      const liftY = t * 14 + (this.mouseBadges.length - 1 - i) * 18;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(b.x, b.y - liftY);
      ctx.scale(scale, scale);

      const boxW = 34;
      const boxH = 19;
      const bx = -boxW / 2;
      const by = -boxH / 2;

      ctx.shadowColor = 'rgba(0, 0, 0, 0.24)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1.5;

      ctx.fillStyle = '#22242a';
      this.roundRect(ctx, bx, by + 1.6, boxW, boxH, 5);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = b.color;
      ctx.strokeStyle = 'rgba(20, 22, 28, 0.45)';
      ctx.lineWidth = 1.0;
      this.roundRect(ctx, bx, by, boxW, boxH - 1.0, 5);
      ctx.fill();
      ctx.stroke();

      ctx.font = '800 9.5px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = b.label === 'RMB' && b.color === '#ff7b3b' ? '#ffffff' : '#14161a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, 0, -0.3);

      ctx.restore();
    }
  }

  private drawCustomCatBody(
    ctx: CanvasRenderingContext2D,
    s: ResolvedSkin,
    breath: number,
    purrShift: number,
  ): void {
    const leftPts: Vec2[] = [];
    const rightPts: Vec2[] = [];
    const bellySwell = 1 + this.typingHunch * 0.04;
    const headCenter = this.spinePoint(0.24, breath);
    const hcx = headCenter.x + purrShift;
    const hcy = headCenter.y;

    for (const slice of BODY_SLICES) {
      const sp = this.spinePoint(slice.t, breath);
      const widen = slice.t > 0.45 ? bellySwell : 1;
      const hw = slice.hw * widen;

      if (slice.t <= 0.38) {
        const tiltW = slice.t <= 0.30 ? 1.0 : (0.42 - slice.t) / 0.12;
        const ang = this.headTilt * tiltW;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        const relY = sp.y - hcy;
        const lx0 = sp.x + purrShift - hw - hcx;
        const rx0 = sp.x + purrShift + hw - hcx;
        leftPts.push({ x: hcx + lx0 * cosA - relY * sinA, y: hcy + lx0 * sinA + relY * cosA });
        rightPts.push({ x: hcx + rx0 * cosA - relY * sinA, y: hcy + rx0 * sinA + relY * cosA });
      } else {
        leftPts.push({ x: sp.x + purrShift - hw, y: sp.y });
        rightPts.push({ x: sp.x + purrShift + hw, y: sp.y });
      }
    }

    const crownRelY = this.spinePoint(0.11, breath).y - hcy;
    const crownPt = {
      x: hcx - crownRelY * Math.sin(this.headTilt),
      y: hcy + crownRelY * Math.cos(this.headTilt),
    };
    const basePt = this.spinePoint(1.0, breath);

    ctx.save();
    ctx.shadowColor = s.isDarkBase ? 'rgba(18, 17, 18, 0.42)' : 'rgba(30, 32, 42, 0.22)';
    ctx.shadowBlur = s.isDarkBase ? 1.6 : 5;
    if (!s.isDarkBase) ctx.shadowOffsetY = 2;

    // 1) Grounded hind paws when front paws lift
    const anyFrontLifted = this.leftPaw.idleWeight < 0.7 || this.rightPaw.idleWeight < 0.7;
    if (anyFrontLifted) {
      ctx.fillStyle = s.pawColor;
      ctx.strokeStyle = s.pawOutlineColor || s.outlineColor || 'transparent';
      ctx.lineWidth = 1.85;
      for (const [fx, fy, rx, ry] of [
        [basePt.x - 42, basePt.y - 3, 14.5, 11.5],
        [basePt.x + 32, basePt.y - 1, 15.0, 11.5],
      ]) {
        ctx.beginPath();
        ctx.ellipse(fx, fy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        if (s.pawOutlineColor || s.outlineColor) {
          ctx.save();
          ctx.shadowBlur = 0;
          ctx.shadowOffsetY = 0;
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // 2) Unified flexible body path
    const traceBodyPath = () => {
      ctx.beginPath();
      const crownCos = Math.cos(this.headTilt);
      const crownSin = Math.sin(this.headTilt);
      ctx.moveTo(leftPts[0].x + 14 * crownCos + 6 * crownSin, leftPts[0].y + 14 * crownSin - 6 * crownCos);
      ctx.quadraticCurveTo(crownPt.x, crownPt.y - 2, rightPts[0].x - 14 * crownCos + 6 * crownSin, rightPts[0].y - 14 * crownSin - 6 * crownCos);
      ctx.lineTo(rightPts[0].x, rightPts[0].y);
      for (let i = 0; i < rightPts.length - 1; i++) {
        const p0 = rightPts[i];
        const p1 = rightPts[i + 1];
        ctx.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);
      }
      ctx.lineTo(rightPts[rightPts.length - 1].x, rightPts[rightPts.length - 1].y);
      ctx.quadraticCurveTo(basePt.x + purrShift, basePt.y + 6, leftPts[leftPts.length - 1].x, leftPts[leftPts.length - 1].y);
      for (let i = leftPts.length - 1; i > 0; i--) {
        const p0 = leftPts[i];
        const p1 = leftPts[i - 1];
        ctx.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);
      }
      ctx.lineTo(leftPts[0].x, leftPts[0].y);
      ctx.closePath();
    };

    traceBodyPath();
    const furGrad = ctx.createRadialGradient(hcx, hcy + 65, 18, basePt.x, basePt.y - 60, 150);
    furGrad.addColorStop(0.0, s.furColor);
    furGrad.addColorStop(1.0, s.furSecondaryColor);
    ctx.fillStyle = furGrad;
    ctx.fill();

    // 3) Clipped coat pattern markings & custom spots
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.clip();

    const midTorso = this.spinePoint(0.70, breath);
    const chestSp = this.spinePoint(0.56, breath);

    if (s.flankColor) {
      for (const sgn of [-1, 1]) {
        ctx.save();
        ctx.globalAlpha = 0.62;
        ctx.fillStyle = s.flankColor;
        ctx.shadowColor = s.flankColor;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.ellipse(midTorso.x + purrShift + sgn * 62, midTorso.y + 6, 48, 82, sgn * -0.14, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    if (s.bellyBibColor) {
      ctx.fillStyle = s.bellyBibColor;
      ctx.beginPath();
      ctx.ellipse(chestSp.x + purrShift, chestSp.y + 38, 36, 62, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (s.pattern === 'tabby' && s.stripeColor) {
      ctx.strokeStyle = s.stripeColor;
      ctx.lineCap = 'round';
      ctx.lineWidth = 4.6;
      ctx.globalAlpha = 0.65;
      for (const sgn of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const ty = midTorso.y - 26 + i * 20;
          ctx.beginPath();
          ctx.moveTo(midTorso.x + purrShift + sgn * 74, ty);
          ctx.quadraticCurveTo(midTorso.x + purrShift + sgn * 56, ty + 3, midTorso.x + purrShift + sgn * 42, ty + 7);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    if (s.pattern === 'calico') {
      const orangePatch = s.maskColor || '#ea9446';
      const darkPatch = s.calicoPatchColor || '#3c3634';
      ctx.save();
      ctx.shadowBlur = 4;
      ctx.shadowColor = orangePatch;
      ctx.fillStyle = orangePatch;
      ctx.beginPath();
      ctx.ellipse(midTorso.x + purrShift - 54, midTorso.y + 10, 38, 52, -0.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowColor = darkPatch;
      ctx.fillStyle = darkPatch;
      ctx.beginPath();
      ctx.ellipse(midTorso.x + purrShift + 56, midTorso.y - 4, 36, 56, 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Body custom spots
    for (const spot of s.spots) {
      if (spot.part !== 'body') continue;
      ctx.save();
      ctx.globalAlpha = spot.opacity ?? 0.85;
      ctx.fillStyle = spot.color;
      ctx.beginPath();
      ctx.ellipse(
        midTorso.x + purrShift + spot.x * 65,
        midTorso.y + spot.y * 65,
        Math.max(2, spot.rx),
        Math.max(2, spot.ry),
        spot.rotation || 0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();
    }

    // Head-space patterns (rotate seamlessly with headTilt!)
    ctx.save();
    ctx.translate(hcx, hcy);
    ctx.rotate(this.headTilt);
    const maskShift = this.faceTurnX * 0.72;

    if (s.pattern === 'bicolor' && s.maskColor) {
      ctx.save();
      ctx.fillStyle = s.maskColor;
      ctx.shadowColor = s.maskColor;
      ctx.shadowBlur = 4.5;
      ctx.beginPath();
      ctx.moveTo(-74, -44);
      ctx.lineTo(74, -44);
      ctx.lineTo(70, 20);
      ctx.quadraticCurveTo(maskShift + 42, 18, maskShift + 26, 9);
      ctx.quadraticCurveTo(maskShift + 17, 0, maskShift + 13.5, -13);
      ctx.quadraticCurveTo(maskShift + 7, -21.5, maskShift, -22.5);
      ctx.quadraticCurveTo(maskShift - 7, -21.5, maskShift - 13.5, -13);
      ctx.quadraticCurveTo(maskShift - 17, 0, maskShift - 26, 9);
      ctx.quadraticCurveTo(maskShift - 42, 18, -70, 20);
      ctx.closePath();
      ctx.fill();
      if (s.foreheadBridgeColor) {
        ctx.fillStyle = s.foreheadBridgeColor;
        ctx.shadowBlur = 5.5;
        ctx.beginPath();
        ctx.ellipse(maskShift, -32, 18, 9, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    } else if (s.pattern === 'tuxedo' && s.bellyBibColor) {
      ctx.fillStyle = s.bellyBibColor;
      ctx.beginPath();
      ctx.ellipse(maskShift, 22, 26, 15, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.pattern === 'siamese' && s.maskColor) {
      ctx.save();
      ctx.fillStyle = s.maskColor;
      ctx.shadowColor = s.maskColor;
      ctx.shadowBlur = 9;
      ctx.beginPath();
      ctx.ellipse(maskShift, 3, 42, 27, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (s.pattern === 'calico') {
      const orangePatch = s.maskColor || '#ea9446';
      const darkPatch = s.calicoPatchColor || '#3c3634';
      ctx.save();
      ctx.shadowBlur = 4;
      ctx.fillStyle = orangePatch;
      ctx.shadowColor = orangePatch;
      ctx.beginPath();
      ctx.ellipse(-34 + maskShift * 0.4, -18, 34, 28, -0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = darkPatch;
      ctx.shadowColor = darkPatch;
      ctx.beginPath();
      ctx.ellipse(36 + maskShift * 0.4, -16, 32, 26, 0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (s.pattern === 'tabby' && s.stripeColor) {
      // Iconic tabby forehead "M" & cheek stripes!
      ctx.strokeStyle = s.stripeColor;
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.78;
      // Center M stripes on forehead
      ctx.beginPath();
      ctx.moveTo(maskShift - 11, -30);
      ctx.lineTo(maskShift - 8, -19);
      ctx.moveTo(maskShift, -32);
      ctx.lineTo(maskShift, -18);
      ctx.moveTo(maskShift + 11, -30);
      ctx.lineTo(maskShift + 8, -19);
      ctx.stroke();
      // Cheek tiger stripes
      ctx.lineWidth = 2.8;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sgn * 58, 6);
        ctx.lineTo(sgn * 42, 9);
        ctx.moveTo(sgn * 56, 14);
        ctx.lineTo(sgn * 41, 16);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Head custom spots
    for (const spot of s.spots) {
      if (spot.part !== 'head') continue;
      ctx.save();
      ctx.globalAlpha = spot.opacity ?? 0.85;
      ctx.fillStyle = spot.color;
      ctx.beginPath();
      ctx.ellipse(
        maskShift + spot.x * 52,
        spot.y * 36,
        Math.max(2, spot.rx),
        Math.max(2, spot.ry),
        spot.rotation || 0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();
    }

    ctx.restore(); // end head-space patterns
    ctx.restore(); // end body clip

    if (s.outlineColor) {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      traceBodyPath();
      ctx.strokeStyle = s.outlineColor;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    // 4) Ears, face features & eyes in head-space
    ctx.save();
    ctx.translate(hcx, hcy);
    ctx.rotate(this.headTilt);

    const drawCustomEar = (sideSign: -1 | 1) => {
      const ear = this.getEarPose(sideSign);
      ctx.save();
      ctx.translate(ear.x, ear.y);
      ctx.rotate(ear.rot);
      ctx.scale(ear.scaleX, ear.scaleY);
      const tb = ear.tipBend;

      const earPath = () => {
        ctx.beginPath();
        ctx.moveTo(sideSign * 19, 20);
        ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12 + tb * 0.5, -23, sideSign * 3 + tb, -21);
        ctx.bezierCurveTo(sideSign * -8 + tb * 0.4, -18, sideSign * -16, -6, sideSign * -21, 8);
        ctx.closePath();
      };

      const baseEarCol =
        s.pattern === 'calico' && sideSign === -1
          ? s.maskColor || s.earOuterColor
          : s.earOuterColor;
      const earGrad = ctx.createLinearGradient(0, -23, 0, 18);
      earGrad.addColorStop(0.0, s.earTipColor || baseEarCol);
      earGrad.addColorStop(1.0, baseEarCol);
      ctx.fillStyle = earGrad;
      earPath();
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      if (s.outlineColor) {
        ctx.strokeStyle = s.outlineColor;
        ctx.lineWidth = 1.85;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sideSign * 19, 17);
        ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12 + tb * 0.5, -23, sideSign * 3 + tb, -21);
        ctx.bezierCurveTo(sideSign * -8 + tb * 0.4, -18, sideSign * -16, -6, sideSign * -19, 5);
        ctx.stroke();
      }

      if (s.earInnerColor) {
        ctx.fillStyle = s.earInnerColor;
        ctx.beginPath();
        ctx.moveTo(sideSign * 11, 10);
        ctx.bezierCurveTo(sideSign * 11, -3, sideSign * 7 + tb * 0.35, -13, sideSign * 2 + tb * 0.6, -11);
        ctx.bezierCurveTo(sideSign * -4 + tb * 0.25, -9, sideSign * -9, -1, sideSign * -10, 8);
        ctx.closePath();
        ctx.fill();
      }

      if (s.earTuftColor) {
        ctx.strokeStyle = s.earTuftColor;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sideSign * -6, 6);
        ctx.quadraticCurveTo(sideSign * -1, 3, sideSign * 5, 6);
        ctx.moveTo(sideSign * -3, 10);
        ctx.quadraticCurveTo(sideSign * 2, 7.5, sideSign * 7, 10);
        ctx.stroke();
      }
      ctx.restore();
    };

    drawCustomEar(-1);
    drawCustomEar(1);

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    const wShift = this.faceTurnX * 0.72;

    // Mood: rosy cheeks when relaxed by music, furrowed brows when stuck typing too long.
    this.drawMoodBlush(ctx, wShift, s.blushColor || '#ff8fa3');

    // Blush on petting
    if (s.blushColor && this.squintAmount > 0.12) {
      ctx.save();
      ctx.globalAlpha = 0.42 * this.squintAmount;
      ctx.fillStyle = s.blushColor;
      ctx.beginPath();
      ctx.ellipse(wShift - 30, 13, 8.5, 4.6, -0.08, 0, Math.PI * 2);
      ctx.ellipse(wShift + 30, 13, 8.5, 4.6, 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Nose & mouth
    if (s.noseColor) {
      ctx.fillStyle = s.noseColor;
      ctx.beginPath();
      ctx.moveTo(wShift - 4.1, 9.6);
      ctx.quadraticCurveTo(wShift, 8.5, wShift + 4.1, 9.6);
      ctx.quadraticCurveTo(wShift + 3.2, 13.8, wShift, 14.3);
      ctx.quadraticCurveTo(wShift - 3.2, 13.8, wShift - 4.1, 9.6);
      ctx.closePath();
      ctx.fill();
    }
    if (s.mouthColor) {
      ctx.strokeStyle = s.mouthColor;
      ctx.lineWidth = 1.35;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(wShift - 5.8, 16.6);
      ctx.quadraticCurveTo(wShift - 2.9, 19.6, wShift, 16.4);
      ctx.quadraticCurveTo(wShift + 2.9, 19.6, wShift + 5.8, 16.6);
      ctx.stroke();
    }

    // Whiskers
    ctx.strokeStyle = s.whiskerColor;
    ctx.lineWidth = 1.1;
    ctx.lineCap = 'round';
    const leftLen = Math.max(8, 12 - this.faceTurnX * 0.55);
    const rightLen = Math.max(8, 12 + this.faceTurnX * 0.55);
    for (let i = 0; i < 3; i++) {
      const wy = 16 + i * 5.0;
      const slant = 2.0 + i * 1.1;
      ctx.beginPath();
      ctx.moveTo(-34 + wShift, wy);
      ctx.lineTo(-34 + wShift - leftLen, wy + slant);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(34 + wShift, wy);
      ctx.lineTo(34 + wShift + rightLen, wy + slant);
      ctx.stroke();
    }

    this.drawCustomEyes(ctx, s, wShift, -1);
    this.drawAngryBrows(
      ctx,
      wShift,
      s.outlineColor || (s.isDarkBase ? 'rgba(255, 226, 214, 0.92)' : 'rgba(56, 46, 40, 0.92)'),
    );
    this.drawHeadphones(ctx, s.isDarkBase, s.accentColor);

    ctx.restore();
    ctx.restore();
  }

  private drawCustomEyes(ctx: CanvasRenderingContext2D, s: ResolvedSkin, cx: number, eyeY: number): void {
    const blinkVal = this.isBlinking ? 1 - Math.abs(this.blinkProgress - 1) : 0;
    const closedness = Math.max(
      blinkVal,
      this.squintAmount * 0.85,
      this.privacyClose,
      this.sleepyAmount * 0.95,
    );
    const eyeXs = [cx - 23.0, cx + 23.0];
    const rx = 14.8 + this.typingHunch * 1.0;
    const ry = 13.4 - this.typingHunch * 0.5;

    for (let idx = 0; idx < 2; idx++) {
      ctx.save();
      ctx.translate(eyeXs[idx], eyeY);

      if (this.privacyClose > 0.45) {
        ctx.strokeStyle = s.squintColor;
        ctx.lineWidth = 2.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-13.5, -0.5);
        ctx.quadraticCurveTo(0, 5.2, 13.5, -0.5);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (this.squintAmount > 0.38 && blinkVal < 0.3) {
        if (s.squintGlowColor) {
          ctx.strokeStyle = s.squintGlowColor;
          ctx.lineWidth = 4.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-12.5, 0.2);
          ctx.quadraticCurveTo(0, 2.2, 12.5, 1.8);
          ctx.stroke();
        }
        ctx.strokeStyle = s.squintColor;
        ctx.lineWidth = 2.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-13.5, -0.5);
        ctx.quadraticCurveTo(0, 1.4, 13.5, 1.2);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      const openRy =
        Math.max(1.2, ry * (1 - closedness)) *
        (1 - this.relaxAmount * 0.16) *
        (1 - this.annoyAmount * 0.3) *
        (1 + this.curiousAmount * 0.18);
      const curiousTilt = (idx === 0 ? -0.1 : 0.1) * (0.25 + this.typingHunch * 0.75);
      ctx.rotate(curiousTilt);

      const irisGrad = ctx.createLinearGradient(0, -openRy, 0, openRy);
      irisGrad.addColorStop(0.0, s.eyeColorTop);
      irisGrad.addColorStop(1.0, s.eyeColorBottom);
      ctx.fillStyle = irisGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.clip();
      if (openRy > 3.2) {
        const px = this.eyeLookX * (1 + this.curiousAmount * 0.35);
        const py = this.eyeLookY * (1 + this.curiousAmount * 0.35);
        ctx.fillStyle = s.pupilColor;
        ctx.beginPath();
        ctx.ellipse(px, py, 6.2 * (1 + this.critterHunt * 0.38), 8.8 * (1 + this.critterHunt * 0.22), 0, 0, Math.PI * 2);
        ctx.fill();

        if (s.eyeCatchlight) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
          ctx.beginPath();
          ctx.arc(px - 3.6, py - 4.0, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
          ctx.beginPath();
          ctx.arc(px + 3.2, py + 3.2, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      if (s.eyeRimColor && openRy > 2.2) {
        ctx.strokeStyle = s.eyeRimColor;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  private drawCustomPlumpArm(
    ctx: CanvasRenderingContext2D,
    s: ResolvedSkin,
    side: 'left' | 'right',
    sx: number,
    sy: number,
    px: number,
    py: number,
    squash: number,
    withCrease: boolean,
  ): void {
    const dx = px - sx;
    const dy = py - sy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const wristDist = Math.max(6, len - 8);
    const wx = sx + ux * wristDist;
    const wy = sy + uy * wristDist;
    const rShoulder = 14.2;
    const rWrist = 9.4;
    const pawRx = 14.5 * (1 + squash * 0.14);
    const pawRy = 11.8 * (1 - squash * 0.12);

    ctx.save();
    const traceArmPath = () => {
      ctx.beginPath();
      ctx.moveTo(sx + nx * rShoulder, sy + ny * rShoulder);
      ctx.quadraticCurveTo(
        (sx + wx) * 0.5 + nx * (rShoulder * 0.84),
        (sy + wy) * 0.5 + ny * (rShoulder * 0.84),
        wx + nx * rWrist,
        wy + ny * rWrist,
      );
      ctx.lineTo(wx - nx * rWrist, wy - ny * rWrist);
      ctx.quadraticCurveTo(
        (sx + wx) * 0.5 - nx * (rShoulder * 0.84),
        (sy + wy) * 0.5 - ny * (rShoulder * 0.84),
        sx - nx * rShoulder,
        sy - ny * rShoulder,
      );
      ctx.closePath();
    };

    ctx.fillStyle = s.armColor;
    traceArmPath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(sx, sy, rShoulder, 0, Math.PI * 2);
    ctx.fill();

    // Custom arm spots
    const armPart = side === 'left' ? 'leftArm' : 'rightArm';
    const armSpots = s.spots.filter((sp) => sp.part === armPart);
    if (armSpots.length > 0 && len > 24) {
      const armAng = Math.atan2(dy, dx);
      ctx.save();
      traceArmPath();
      ctx.clip();
      for (const sp of armSpots) {
        const frac = Math.max(0.1, Math.min(0.9, sp.x));
        ctx.globalAlpha = sp.opacity ?? 0.85;
        ctx.fillStyle = sp.color;
        ctx.beginPath();
        ctx.ellipse(
          sx + ux * (len * frac) + nx * sp.y,
          sy + uy * (len * frac) + ny * sp.y,
          Math.max(2, sp.rx),
          Math.max(2, sp.ry),
          armAng + (sp.rotation || 0),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.restore();
    }

    // Mitten paw ball
    ctx.save();
    if (!s.isDarkBase) {
      ctx.shadowColor = 'rgba(36, 32, 30, 0.22)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1.5;
    }
    ctx.fillStyle = s.pawColor;
    ctx.beginPath();
    ctx.ellipse(px, py, pawRx, pawRy, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const edgeColor = s.pawOutlineColor || s.outlineColor;
    if (edgeColor) {
      ctx.lineWidth = 1.65;
      ctx.lineCap = 'round';
      for (const sgn of [-1, 1]) {
        const startFrac = withCrease ? 0.16 : 0.08;
        const esx = sx + ux * (len * startFrac) + nx * sgn * (rShoulder * (1 - startFrac * 0.16));
        const esy = sy + uy * (len * startFrac) + ny * sgn * (rShoulder * (1 - startFrac * 0.16));
        ctx.strokeStyle = edgeColor;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(esx, esy);
        ctx.quadraticCurveTo(
          (sx + wx) * 0.5 + nx * sgn * (rShoulder * 0.84),
          (sy + wy) * 0.5 + ny * sgn * (rShoulder * 0.84),
          wx + nx * sgn * rWrist,
          wy + ny * sgn * rWrist,
        );
        ctx.stroke();
      }
      const pawAng = Math.atan2(dy, dx);
      ctx.globalAlpha = 0.92;
      ctx.strokeStyle = edgeColor;
      ctx.beginPath();
      ctx.ellipse(px, py, pawRx, pawRy, 0, pawAng - Math.PI * 0.62, pawAng + Math.PI * 0.62);
      ctx.stroke();
    } else if (s.armCreaseColor && withCrease && len > 28) {
      for (const sgn of [-1, 1]) {
        const csx = sx + ux * (len * 0.18) + nx * sgn * (rShoulder * 0.86);
        const csy = sy + uy * (len * 0.18) + ny * sgn * (rShoulder * 0.86);
        const cex = sx + ux * (len * 0.72) + nx * sgn * (rWrist * 1.02);
        const cey = sy + uy * (len * 0.72) + ny * sgn * (rWrist * 1.02);
        ctx.strokeStyle = s.armCreaseColor;
        ctx.lineWidth = 1.3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(csx, csy);
        ctx.lineTo(cex, cey);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  private drawCustomBentArm(
    ctx: CanvasRenderingContext2D,
    s: ResolvedSkin,
    paw: PawState,
    breath: number,
    alpha: number,
  ): void {
    const sh = this.getLiveShoulder(paw, breath);
    const cp = this.getLiveCurledPawPos(paw, breath);
    const sign = paw.side === 'left' ? -1 : 1;
    const elbowX = sh.x + sign * 8;
    const elbowY = cp.y + 8;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = s.armColor;
    ctx.lineWidth = 20;
    ctx.beginPath();
    ctx.moveTo(sh.x, sh.y);
    ctx.quadraticCurveTo(elbowX, elbowY, cp.x, cp.y);
    ctx.stroke();

    const armPart = paw.side === 'left' ? 'leftArm' : 'rightArm';
    for (const sp of s.spots) {
      if (sp.part !== armPart) continue;
      ctx.save();
      ctx.globalAlpha = alpha * (sp.opacity ?? 0.82);
      ctx.fillStyle = sp.color;
      ctx.beginPath();
      ctx.ellipse((elbowX + cp.x) * 0.5, (elbowY + cp.y) * 0.5, Math.min(8, sp.rx), Math.min(6, sp.ry), -0.3 * sign, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = s.pawColor;
    ctx.beginPath();
    ctx.ellipse(cp.x, cp.y, 12.5, 11.0, sign * 0.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = s.pawOutlineColor || s.legLineColor;
    ctx.lineWidth = 1.55;
    ctx.beginPath();
    ctx.moveTo(elbowX + sign * 8, elbowY - 16);
    ctx.quadraticCurveTo(elbowX + sign * 4, elbowY + 12, cp.x + sign * 2, cp.y + 10);
    ctx.quadraticCurveTo(cp.x - sign * 11, cp.y + 8, cp.x - sign * 12, cp.y - 4);
    ctx.stroke();
    ctx.restore();
  }

  private drawCustomIdleLegDetails(
    ctx: CanvasRenderingContext2D,
    s: ResolvedSkin,
    paw: PawState,
    topSp: Vec2,
    midSp: Vec2,
    botSp: Vec2,
    sign: -1 | 1,
    outerTopX: number,
    outerBotX: number,
    innerTopX: number,
    innerBotX: number,
  ): void {
    const armPart = paw.side === 'left' ? 'leftArm' : 'rightArm';
    for (const sp of s.spots) {
      if (sp.part !== armPart) continue;
      ctx.save();
      ctx.globalAlpha = sp.opacity ?? 0.82;
      ctx.fillStyle = sp.color;
      ctx.beginPath();
      ctx.ellipse(midSp.x + sign * 21, midSp.y + (sp.x - 0.5) * 28, Math.max(3, sp.rx * 0.8), Math.max(3, sp.ry * 1.1), 0.2 * sign, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Optional cute white mittens at the bottom of idle seated legs when pawColor differs from furColor!
    if (s.pawColor !== s.furColor) {
      ctx.save();
      ctx.fillStyle = s.pawColor;
      ctx.beginPath();
      ctx.ellipse(botSp.x + sign * 22, botSp.y - 4, 13.5, 9.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.strokeStyle = s.legLineColor;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(outerTopX, topSp.y);
    ctx.quadraticCurveTo(midSp.x + sign * 41, midSp.y, outerBotX, botSp.y - 1);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(innerTopX, topSp.y + 10);
    ctx.lineTo(innerBotX, botSp.y - 1);
    ctx.stroke();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  private trapezoidPath(
    ctx: CanvasRenderingContext2D,
    topHalfW: number,
    botHalfW: number,
    topY: number,
    botY: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(-topHalfW + r, topY);
    ctx.lineTo(topHalfW - r, topY);
    ctx.quadraticCurveTo(topHalfW, topY, topHalfW + 1, topY + r);
    ctx.lineTo(botHalfW, botY - r);
    ctx.quadraticCurveTo(botHalfW, botY, botHalfW - r, botY);
    ctx.lineTo(-botHalfW + r, botY);
    ctx.quadraticCurveTo(-botHalfW, botY, -botHalfW, botY - r);
    ctx.lineTo(-topHalfW - 1, topY + r);
    ctx.quadraticCurveTo(-topHalfW, topY, -topHalfW + r, topY);
    ctx.closePath();
  }
}

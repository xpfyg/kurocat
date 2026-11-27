import idleUrl from './assets/dafeiyu/notail_idle.png';
import blinkUrl from './assets/dafeiyu/notail_blink.png';
import shyUrl from './assets/dafeiyu/notail_shy.png';
import happyUrl from './assets/dafeiyu/notail_happy2.png';

export interface DaFeiYuLayout {
  logicalW: number;
  kbCenterX: number;
  kbCenterY: number;
  kbWidth: number;
  kbHeight: number;
  kbTiltRad: number;
  mouseBtnX: number;
  mouseBtnY: number;
  mouseNX: number;
  mouseLeft: boolean;
  mouseRight: boolean;
  mouseActiveAt: number;
  petEnergy: number;
  privacyMode: boolean;
  privacyTypingAt: number;
  is108: boolean;
}

interface HandState {
  x: number;
  y: number;
  tx: number;
  ty: number;
  lastAt: number;
  squash: number;
  heldVks: Set<number>;
}

interface WaterRipple {
  x: number;
  y: number;
  r: number;
  life: number;
}

interface FloatingParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  kind: 'heart' | 'drop';
}

/**
 * BigFish (大肥鱼 / 鲸鱼娘) companion renderer for MiniCat.
 * Uses MIT-licensed `PC2005-cloud/dsh-pet` (via `QCYTSN/dsh-dafeiyu`) armless/tailless sprites
 * with procedural pure-round chibi hands, plump flared maid sleeves, animated ocean-blue whale tail
 * slapping right-edge keys, calm hysteresis-locked typing-speed cheek blush, 3-limb simultaneous
 * mouse+keyboard+tail support, and adorable hands-covering-eyes password privacy mode.
 */
export class DaFeiYuRenderer {
  private sprites: Record<'idle' | 'blink' | 'shy' | 'happy', HTMLImageElement>;

  private lastKeyAt = -10000;
  private keyTimes: number[] = [];
  private typingHeat = 0;
  private blushLevel = 0;
  private moodTier: 0 | 1 | 2 = 0;
  private moodChangedAt = -10000;
  private nextBlinkAt = performance.now() + 3600 + Math.random() * 2600;
  private blinkUntil = 0;

  private bodyShiftX = 0;
  private bodyShiftVel = 0;
  private bodyShiftTarget = 0;
  private bodyTilt = 0;
  private bodyTiltVel = 0;
  private bodyTiltTarget = 0;
  private bodyDiveY = 0;
  private bodyBob = 0;

  private leftHand: HandState = {
    x: 155,
    y: 312,
    tx: 155,
    ty: 312,
    lastAt: -10000,
    squash: 0,
    heldVks: new Set(),
  };
  private rightHand: HandState = {
    x: 235,
    y: 312,
    tx: 235,
    ty: 312,
    lastAt: -10000,
    squash: 0,
    heldVks: new Set(),
  };

  private tail = {
    x: 320,
    y: 280,
    tx: 320,
    ty: 280,
    slapAt: -10000,
    releaseAt: -10000,
    slapTargetX: 340,
    slapTargetY: 355,
    heldVks: new Set<number>(),
    squash: 0,
    phase: 0,
  };

  private ripples: WaterRipple[] = [];
  private particles: FloatingParticle[] = [];

  constructor() {
    const mk = (src: string) => {
      const img = new Image();
      img.src = src;
      return img;
    };
    this.sprites = {
      idle: mk(idleUrl),
      blink: mk(blinkUrl),
      shy: mk(shyUrl),
      happy: mk(happyUrl),
    };
  }

  public onPrivacyModeChanged(active: boolean): void {
    if (active) {
      this.leftHand.heldVks.clear();
      this.rightHand.heldVks.clear();
      this.tail.heldVks.clear();
      this.ripples.length = 0;
    }
  }

  public onPrivacyTyping(): void {
    this.bodyBob = Math.min(0.65, this.bodyBob + 0.42);
  }

  public resetLeftHandForMouse(): void {
    this.leftHand.lastAt = -10000;
  }

  public onKeyDown(
    vk: number,
    pt: { x: number; y: number },
    layout: DaFeiYuLayout,
    repeat: boolean,
  ): void {
    if (layout.privacyMode || repeat) return;
    const now = performance.now();
    this.lastKeyAt = now;
    this.keyTimes.push(now);
    this.bodyBob = Math.min(1.1, this.bodyBob + 0.72);

    const charX = layout.is108 ? 268 : 192;
    const normX = Math.max(-1, Math.min(1, (pt.x - layout.kbCenterX) / (layout.kbWidth * 0.46)));
    const mouseBusy = layout.mouseLeft || layout.mouseRight || now - layout.mouseActiveAt < 900;
    const isLeftSide = pt.x < layout.kbCenterX - 2;
    const rightEdgeThreshold = layout.kbCenterX + layout.kbWidth * (layout.is108 ? 0.16 : 0.215);

    if (pt.x >= rightEdgeThreshold) {
      // Right-edge action / arrow / numpad keys -> animated ocean-blue whale tail slap!
      this.tail.slapAt = now;
      this.tail.releaseAt = -10000;
      this.tail.heldVks.add(vk);
      this.tail.slapTargetX = pt.x;
      this.tail.slapTargetY = pt.y;
      this.tail.squash = 1;
      if (!mouseBusy) {
        this.bodyTiltTarget = -0.075;
        this.bodyShiftTarget = -7;
      }
      this.ripples.push({ x: pt.x, y: pt.y, r: 6, life: 1 });
      this.ripples.push({ x: pt.x, y: pt.y, r: 2, life: 0.85 });
      this.spawnParticles(pt.x, pt.y - 8, 3, true);
    } else if (mouseBusy) {
      // Simultaneous mouse + keyboard: left hand stays glued on mouse, right hand taps main keyboard!
      const shiftBase = layout.is108 ? -88 : -38;
      const curCharX = charX + shiftBase;
      const comfortX = Math.max(curCharX - 10, Math.min(curCharX + 92, pt.x));
      const comfortY = Math.min(layout.kbCenterY + 6, pt.y);
      this.rightHand.tx = comfortX;
      this.rightHand.ty = comfortY;
      this.rightHand.lastAt = now;
      this.rightHand.squash = 1;
      this.rightHand.heldVks.add(vk);
    } else {
      // Cozy two-handed typing with gentle micro-sway (±5.5°)
      this.bodyTiltTarget = normX * 0.095;
      this.bodyShiftTarget = normX * (layout.is108 ? 22 : 13);
      const comfortX =
        charX +
        this.bodyShiftTarget +
        Math.max(-76, Math.min(76, (pt.x - charX) * 0.78));
      const comfortY = Math.min(layout.kbCenterY + 10, pt.y);
      if (isLeftSide) {
        this.leftHand.tx = comfortX;
        this.leftHand.ty = comfortY;
        this.leftHand.lastAt = now;
        this.leftHand.squash = 1;
        this.leftHand.heldVks.add(vk);
      } else {
        this.rightHand.tx = comfortX;
        this.rightHand.ty = comfortY;
        this.rightHand.lastAt = now;
        this.rightHand.squash = 1;
        this.rightHand.heldVks.add(vk);
      }
    }
  }

  public onKeyUp(vk: number): void {
    const now = performance.now();
    this.leftHand.heldVks.delete(vk);
    this.rightHand.heldVks.delete(vk);
    if (this.tail.heldVks.has(vk)) {
      this.tail.heldVks.delete(vk);
      if (this.tail.heldVks.size === 0) {
        this.tail.releaseAt = now;
      }
    }
  }

  private spawnParticles(x: number, y: number, count: number, onlyDrop: boolean): void {
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * (onlyDrop ? 28 : 48),
        y: y + (Math.random() - 0.5) * 16,
        vx: (Math.random() - 0.5) * (onlyDrop ? 2.2 : 0.8),
        vy: -1.1 - Math.random() * 1.2,
        life: 1,
        kind: onlyDrop ? 'drop' : Math.random() > 0.45 ? 'heart' : 'drop',
      });
    }
  }

  public update(dt: number, now: number, layout: DaFeiYuLayout): void {
    this.bodyBob *= Math.exp(-12 * dt);

    const isHappy = !layout.privacyMode && layout.petEnergy > 0.25;
    const isTyping =
      !layout.privacyMode &&
      (now - this.lastKeyAt < 550 ||
        this.tail.heldVks.size > 0 ||
        this.leftHand.heldVks.size > 0 ||
        this.rightHand.heldVks.size > 0);
    const mouseMode =
      !layout.privacyMode &&
      !isHappy &&
      (layout.mouseLeft || layout.mouseRight || now - layout.mouseActiveAt < 900);

    // 1) Calm 2.8s typing-speed window + hysteresis-locked blush mood (min 2.2s dwell, zero flicker!)
    while (this.keyTimes.length && now - this.keyTimes[0] > 2800) {
      this.keyTimes.shift();
    }
    const typingCPS = this.keyTimes.length / 2.8;
    const heatTarget = layout.privacyMode
      ? 0
      : Math.min(1, Math.max(0, (typingCPS - 2.4) / 5.4));
    if (heatTarget > this.typingHeat) {
      this.typingHeat += (heatTarget - this.typingHeat) * (1 - Math.exp(-2.2 * dt));
    } else {
      this.typingHeat += (heatTarget - this.typingHeat) * (1 - Math.exp(-0.65 * dt));
    }

    const dwell = now - this.moodChangedAt;
    if (this.moodTier === 0) {
      if (this.typingHeat >= 0.40 && dwell >= 1400) {
        this.moodTier = 1;
        this.moodChangedAt = now;
      }
    } else if (this.moodTier === 1) {
      if (this.typingHeat >= 0.78 && dwell >= 1800) {
        this.moodTier = 2;
        this.moodChangedAt = now;
      } else if (this.typingHeat < 0.22 && dwell >= 2200) {
        this.moodTier = 0;
        this.moodChangedAt = now;
      }
    } else if (this.moodTier === 2) {
      if (this.typingHeat < 0.55 && dwell >= 2200) {
        this.moodTier = 1;
        this.moodChangedAt = now;
      }
    }

    const targetBlush = Math.max(
      this.typingHeat * 0.92,
      isHappy ? 0.45 : 0,
      layout.privacyMode ? 0.46 : 0,
      this.moodTier === 1 ? 0.55 : this.moodTier === 2 ? 0.85 : 0,
    );
    this.blushLevel += (targetBlush - this.blushLevel) * (1 - Math.exp(-3.2 * dt));

    // Natural calm blinking every 4.5 - 7.2s
    if (now >= this.nextBlinkAt) {
      this.blinkUntil = now + 135;
      this.nextBlinkAt = now + 4500 + Math.random() * 2700;
    }

    const charX = layout.is108 ? 268 : 192;
    if (isHappy && Math.random() < 0.06) {
      this.spawnParticles(charX + this.bodyShiftX, 120, 1, false);
    } else if (!layout.privacyMode && this.moodTier === 2 && Math.random() < 0.025) {
      this.spawnParticles(charX + this.bodyShiftX, 124, 1, false);
    }

    // 2) Body spring physics
    if (layout.privacyMode) {
      this.bodyShiftTarget = 0;
      const shySway =
        Math.sin(now * 0.0042) * 0.032 +
        (now - layout.privacyTypingAt < 240 ? Math.sin(now * 0.04) * 0.024 : 0);
      this.bodyTiltTarget = shySway;
      this.bodyDiveY *= Math.exp(-9 * dt);
    } else if (mouseMode) {
      const baseShift = layout.is108 ? -125 : -38;
      this.bodyShiftTarget = baseShift + (layout.mouseNX - 0.5) * 12;
      this.bodyTiltTarget = -0.10;
      this.bodyDiveY += (8 - this.bodyDiveY) * (1 - Math.exp(-10 * dt));
    } else if (!isTyping) {
      this.bodyShiftTarget = 0;
      this.bodyTiltTarget = 0;
      this.bodyDiveY *= Math.exp(-9 * dt);
    } else {
      this.bodyDiveY *= Math.exp(-9 * dt);
    }

    const shiftAcc = (this.bodyShiftTarget - this.bodyShiftX) * 160 - this.bodyShiftVel * 18;
    this.bodyShiftVel += shiftAcc * dt;
    this.bodyShiftX += this.bodyShiftVel * dt;

    const tiltAcc = (this.bodyTiltTarget - this.bodyTilt) * 180 - this.bodyTiltVel * 17;
    this.bodyTiltVel += tiltAcc * dt;
    this.bodyTilt += this.bodyTiltVel * dt;

    // 3) Ripples & particles
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i];
      rp.r += 58 * dt;
      rp.life -= 2.2 * dt;
      if (rp.life <= 0) this.ripples.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.022 * (dt * 60);
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }

  private computeGeom(now: number, layout: DaFeiYuLayout) {
    const charX = layout.is108 ? 268 : 192;
    const baseCharY = layout.is108 ? 366 : 364;
    const breath = Math.sin(now * 0.0034) * 2.2 + this.bodyBob * 3.8 + this.bodyDiveY;
    const charCenterX = charX + this.bodyShiftX;
    const charBaseY = baseCharY + breath;
    const drawW = layout.is108 ? 268 : 262;
    const drawH = drawW * (278 / 224);
    const pivotOff = 48;
    const pivotY = charBaseY - pivotOff;

    const spritePointToWorld = (normX: number, normY: number) => {
      const lx = (normX - 0.5) * drawW;
      const ly = normY * drawH - drawH + pivotOff;
      const c = Math.cos(this.bodyTilt);
      const s = Math.sin(this.bodyTilt);
      return {
        x: charCenterX + lx * c - ly * s,
        y: pivotY + lx * s + ly * c,
      };
    };

    return {
      charCenterX,
      charBaseY,
      drawW,
      drawH,
      pivotOff,
      pivotY,
      spritePointToWorld,
    };
  }

  /** Layer 1 (drawn BEFORE keyboard & mouse): BigFish sprite + soft lower-cheek watercolor blush. */
  public renderBody(ctx: CanvasRenderingContext2D, now: number, layout: DaFeiYuLayout): void {
    const g = this.computeGeom(now, layout);
    const isHappy = !layout.privacyMode && layout.petEnergy > 0.25;
    const isBlinking = now < this.blinkUntil;

    let exprKey: 'idle' | 'blink' | 'shy' | 'happy' = 'idle';
    if (layout.privacyMode) exprKey = 'blink';
    else if (isHappy || this.moodTier === 2) exprKey = 'happy';
    else if (this.moodTier === 1) exprKey = 'shy';
    else if (isBlinking) exprKey = 'blink';

    const img = this.sprites[exprKey] || this.sprites.idle;
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, layout.logicalW, layout.kbCenterY - layout.kbHeight * 0.36);
      ctx.clip();
      ctx.translate(g.charCenterX, g.pivotY);
      ctx.rotate(this.bodyTilt);
      ctx.scale(1 + this.bodyBob * 0.022, 1 - this.bodyBob * 0.018);
      ctx.drawImage(img, -g.drawW * 0.5, -g.drawH + g.pivotOff, g.drawW, g.drawH);

      // Soft natural watercolor cheek blush strictly BELOW her eyes
      if (this.blushLevel > 0.08) {
        const cheeks = [
          { x: (0.372 - 0.5) * g.drawW, y: 0.562 * g.drawH - g.drawH + g.pivotOff },
          { x: (0.616 - 0.5) * g.drawW, y: 0.562 * g.drawH - g.drawH + g.pivotOff },
        ];
        for (const ch of cheeks) {
          const rX = 11.5 + this.blushLevel * 4.5;
          const rY = 6.2 + this.blushLevel * 2.2;
          const grad = ctx.createRadialGradient(ch.x, ch.y, 1, ch.x, ch.y, rX);
          grad.addColorStop(0, `rgba(255, 110, 148, ${(this.blushLevel * 0.46).toFixed(3)})`);
          grad.addColorStop(0.55, `rgba(255, 138, 170, ${(this.blushLevel * 0.22).toFixed(3)})`);
          grad.addColorStop(1, 'rgba(255, 140, 170, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.ellipse(ch.x, ch.y, rX, rY, 0, 0, Math.PI * 2);
          ctx.fill();

          if (this.blushLevel > 0.52) {
            const lineA = Math.min(1, (this.blushLevel - 0.52) / 0.40) * 0.36;
            ctx.strokeStyle = `rgba(235, 88, 132, ${lineA.toFixed(3)})`;
            ctx.lineWidth = 1.05;
            ctx.lineCap = 'round';
            ctx.beginPath();
            for (const ox of [-3.4, 0, 3.4]) {
              ctx.moveTo(ch.x + ox - 0.9, ch.y + 1.8);
              ctx.lineTo(ch.x + ox + 1.0, ch.y - 1.5);
            }
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }
  }

  /** Layer 2 (drawn AFTER keyboard & mouse): water ripples, animated whale tail, plump round hands, particles. */
  public renderForeground(
    ctx: CanvasRenderingContext2D,
    dt: number,
    now: number,
    layout: DaFeiYuLayout,
  ): void {
    const g = this.computeGeom(now, layout);
    const shL = g.spritePointToWorld(0.39, 0.653);
    const shR = g.spritePointToWorld(0.61, 0.653);
    const tailRoot = g.spritePointToWorld(0.68, 0.822);

    const isHappy = !layout.privacyMode && layout.petEnergy > 0.25;
    const isTyping =
      !layout.privacyMode &&
      (now - this.lastKeyAt < 550 ||
        this.tail.heldVks.size > 0 ||
        this.leftHand.heldVks.size > 0 ||
        this.rightHand.heldVks.size > 0);
    const mouseMode =
      !layout.privacyMode &&
      !isHappy &&
      (layout.mouseLeft || layout.mouseRight || now - layout.mouseActiveAt < 900);

    // 1) Water slap ripples on keyboard
    for (const rp of this.ripples) {
      ctx.save();
      ctx.globalAlpha = rp.life * 0.82;
      ctx.strokeStyle = '#67d8ff';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.ellipse(rp.x, rp.y, rp.r, rp.r * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 2) Animated ocean-blue whale tail
    const wagSpeed = isHappy
      ? 0.015
      : this.typingHeat > 0.45
        ? 0.014
        : isTyping
          ? 0.0082
          : 0.0042;
    const idleWag = Math.sin(now * wagSpeed) * (isHappy ? 0.34 : 0.16 + this.typingHeat * 0.16);
    const idleTipX = tailRoot.x + 76 + Math.sin(now * wagSpeed) * 10;
    const idleTipY = tailRoot.y - 34 + Math.cos(now * wagSpeed * 1.15) * 8;

    const tailAge = Math.max(0, now - this.tail.slapAt);
    const holdingSlap =
      !layout.privacyMode &&
      (this.tail.heldVks.size > 0 || (this.tail.slapAt > 0 && tailAge < 260));
    let targetPhase = 0;
    if (holdingSlap) {
      targetPhase = Math.min(1, tailAge / 65);
    } else if (!layout.privacyMode && this.tail.slapAt > 0) {
      const holdEnd = Math.max(this.tail.slapAt + 260, this.tail.releaseAt);
      const retElapsed = Math.max(0, now - holdEnd);
      targetPhase = Math.max(0, 1 - retElapsed / 220);
    }
    this.tail.phase += (targetPhase - this.tail.phase) * (1 - Math.exp(-34 * dt));
    this.tail.tx = idleTipX + (this.tail.slapTargetX - idleTipX) * this.tail.phase;
    this.tail.ty = idleTipY + (this.tail.slapTargetY - idleTipY) * this.tail.phase;
    const tLerp = 1 - Math.exp(-36 * dt);
    this.tail.x += (this.tail.tx - this.tail.x) * tLerp;
    this.tail.y += (this.tail.ty - this.tail.y) * tLerp;
    this.tail.squash *= Math.exp(-11 * dt);

    const activeWag = idleWag * (1 - this.tail.phase) + -0.08 * this.tail.phase;
    this.drawWhaleTail(ctx, tailRoot.x, tailRoot.y, this.tail.x, this.tail.y, this.tail.phase, activeWag, layout.logicalW);

    // 3) Pure round chibi hands (covering closed eyes in privacyMode!)
    const leftTyping =
      !layout.privacyMode &&
      !mouseMode &&
      (now - this.leftHand.lastAt < 380 || this.leftHand.heldVks.size > 0);
    const rightTyping =
      !layout.privacyMode &&
      (now - this.rightHand.lastAt < 380 || this.rightHand.heldVks.size > 0);

    let lTargetX: number;
    let lTargetY: number;
    let rTargetX: number;
    let rTargetY: number;
    if (layout.privacyMode) {
      const eyeL = g.spritePointToWorld(0.390, 0.476);
      const eyeR = g.spritePointToWorld(0.598, 0.476);
      const shyBob = Math.sin(now * 0.008) * 1.4;
      lTargetX = eyeL.x;
      lTargetY = eyeL.y + shyBob;
      rTargetX = eyeR.x;
      rTargetY = eyeR.y - shyBob;
    } else if (isHappy) {
      const cheer = Math.sin(now * 0.016) * 5.0;
      lTargetX = shL.x - 14;
      lTargetY = shL.y + 4 + cheer;
      rTargetX = shR.x + 14;
      rTargetY = shR.y + 4 - cheer;
    } else {
      if (mouseMode) {
        const pressOff = layout.mouseLeft || layout.mouseRight ? 2.5 : 0;
        lTargetX = layout.mouseBtnX;
        lTargetY = layout.mouseBtnY + pressOff;
      } else if (leftTyping) {
        lTargetX = this.leftHand.tx;
        lTargetY = this.leftHand.ty;
      } else {
        lTargetX = shL.x - 15;
        lTargetY = shL.y + 34;
      }
      if (rightTyping) {
        rTargetX = this.rightHand.tx;
        rTargetY = this.rightHand.ty;
      } else {
        rTargetX = shR.x + 15;
        rTargetY = shR.y + 34;
      }
    }

    const hLerp = 1 - Math.exp(-26 * dt);
    this.leftHand.x += (lTargetX - this.leftHand.x) * hLerp;
    this.leftHand.y += (lTargetY - this.leftHand.y) * hLerp;
    this.rightHand.x += (rTargetX - this.rightHand.x) * hLerp;
    this.rightHand.y += (rTargetY - this.rightHand.y) * hLerp;
    this.leftHand.squash *= Math.exp(-14 * dt);
    this.rightHand.squash *= Math.exp(-14 * dt);

    const maxMouseReach = layout.is108 ? 96 : 88;
    this.drawChubbyArm(
      ctx,
      shL.x,
      shL.y,
      this.leftHand.x,
      this.leftHand.y,
      'left',
      this.leftHand.squash,
      mouseMode ? maxMouseReach : 72,
    );
    this.drawChubbyArm(
      ctx,
      shR.x,
      shR.y,
      this.rightHand.x,
      this.rightHand.y,
      'right',
      this.rightHand.squash,
      mouseMode ? 86 : 72,
    );

    // 4) Water droplets & hearts
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.font = '14px sans-serif';
      ctx.fillText(p.kind === 'heart' ? '💙' : '💧', p.x, p.y);
      ctx.restore();
    }
  }

  private drawWhaleTail(
    ctx: CanvasRenderingContext2D,
    rootX: number,
    rootY: number,
    tipX: number,
    tipY: number,
    slapPhase: number,
    wagAngle: number,
    logicalW: number,
  ): void {
    const idleCtrlX = rootX + 48;
    const idleCtrlY = rootY - 2;
    const slapCtrlX = Math.min(logicalW - 18, Math.max(rootX + 94, tipX + 42));
    const slapCtrlY = Math.min(rootY - 28, (rootY + tipY) * 0.5 - 50);

    const ctrlX = idleCtrlX + (slapCtrlX - idleCtrlX) * slapPhase;
    const ctrlY = idleCtrlY + (slapCtrlY - idleCtrlY) * slapPhase;

    const steps = 14;
    const pts: Array<{ x: number; y: number; nx: number; ny: number; r: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 0.90;
      const omt = 1 - t;
      const x = omt * omt * rootX + 2 * omt * t * ctrlX + t * t * tipX;
      const y = omt * omt * rootY + 2 * omt * t * ctrlY + t * t * tipY;
      const tx = 2 * omt * (ctrlX - rootX) + 2 * t * (tipX - ctrlX);
      const ty = 2 * omt * (ctrlY - rootY) + 2 * t * (tipY - ctrlY);
      const len = Math.max(0.001, Math.hypot(tx, ty));
      const nx = -ty / len;
      const ny = tx / len;
      const r = t < 0.14 ? 7.2 + (t / 0.14) * 2.8 : 10.0 * (1 - ((t - 0.14) / 0.86) * 0.56);
      pts.push({ x, y, nx, ny, r });
    }

    const tipAng = Math.atan2(tipY - ctrlY, tipX - ctrlX) + wagAngle;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (slapPhase > 0.25) {
      ctx.save();
      ctx.shadowColor = 'rgba(7, 16, 40, 0.45)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 5;
      ctx.fillStyle = 'rgba(20, 40, 88, 0.25)';
      ctx.beginPath();
      ctx.ellipse(tipX, tipY + 4, 20, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const stemGrad = ctx.createLinearGradient(rootX, rootY, tipX, tipY);
    stemGrad.addColorStop(0, 'rgba(24, 34, 68, 0.92)');
    stemGrad.addColorStop(0.18, '#1d3269');
    stemGrad.addColorStop(0.55, '#2957a4');
    stemGrad.addColorStop(1, '#52b2eb');

    ctx.beginPath();
    ctx.moveTo(pts[0].x + pts[0].nx * pts[0].r, pts[0].y + pts[0].ny * pts[0].r);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x + pts[i].nx * pts[i].r, pts[i].y + pts[i].ny * pts[i].r);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      ctx.lineTo(pts[i].x - pts[i].nx * pts[i].r, pts[i].y - pts[i].ny * pts[i].r);
    }
    ctx.closePath();
    ctx.fillStyle = stemGrad;
    ctx.fill();

    ctx.strokeStyle = '#16203d';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    for (let i = 1; i < pts.length; i++) {
      const px = pts[i].x + pts[i].nx * pts[i].r;
      const py = pts[i].y + pts[i].ny * pts[i].r;
      if (i === 1) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.beginPath();
    for (let i = 1; i < pts.length; i++) {
      const px = pts[i].x - pts[i].nx * pts[i].r;
      const py = pts[i].y - pts[i].ny * pts[i].r;
      if (i === 1) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(170, 232, 255, 0.48)';
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    for (let i = 2; i < pts.length; i++) {
      const hx = pts[i].x + pts[i].nx * (pts[i].r * 0.35);
      const hy = pts[i].y + pts[i].ny * (pts[i].r * 0.35);
      if (i === 2) ctx.moveTo(hx, hy);
      else ctx.lineTo(hx, hy);
    }
    ctx.stroke();

    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(tipAng);
    const sq = this.tail.squash;
    const scaleMult = 1.05 + slapPhase * 0.10;
    ctx.scale(scaleMult * (1 + sq * 0.16), scaleMult * (1 - sq * 0.10));

    const flukeGrad = ctx.createRadialGradient(-6, 0, 2, 4, 0, 28);
    flukeGrad.addColorStop(0, '#96ecff');
    flukeGrad.addColorStop(0.38, '#4ba8e6');
    flukeGrad.addColorStop(0.78, '#26539e');
    flukeGrad.addColorStop(1, '#182f68');

    ctx.fillStyle = flukeGrad;
    ctx.strokeStyle = '#151f3b';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-13, -4);
    ctx.bezierCurveTo(-8, -19, 8, -30, 19, -23);
    ctx.bezierCurveTo(22, -14, 14, -4, 3, 0);
    ctx.bezierCurveTo(14, 4, 22, 14, 19, 23);
    ctx.bezierCurveTo(8, 30, -8, 19, -13, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = 'rgba(215, 248, 255, 0.65)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-8, -2);
    ctx.quadraticCurveTo(2, -11, 13, -17);
    ctx.moveTo(-8, 2);
    ctx.quadraticCurveTo(2, 11, 13, 17);
    ctx.moveTo(-6, -1);
    ctx.quadraticCurveTo(1, -6, 8, -9);
    ctx.moveTo(-6, 1);
    ctx.quadraticCurveTo(1, 6, 8, 9);
    ctx.stroke();

    ctx.fillStyle = 'rgba(230, 252, 255, 0.55)';
    ctx.beginPath();
    ctx.ellipse(-4, -7, 4.2, 2.2, -0.45, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    ctx.restore();
  }

  private drawChubbyArm(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    targetX: number,
    targetY: number,
    side: 'left' | 'right',
    squash: number,
    maxLen: number,
  ): void {
    const dx = targetX - sx;
    const dy = targetY - sy;
    const rawLen = Math.max(1, Math.hypot(dx, dy));
    const len = Math.min(rawLen, maxLen);
    const ux = dx / rawLen;
    const uy = dy / rawLen;
    const px = sx + ux * len;
    const py = sy + uy * len;
    const nx = -uy;
    const ny = ux;
    const ang = Math.atan2(dy, dx);
    const sgn = side === 'left' ? -1 : 1;

    const wristDist = Math.max(14, len - 9);
    const wx = sx + ux * wristDist;
    const wy = sy + uy * wristDist;
    const rSh = 9.2;
    const rCuff = 12.0;
    const midX = (sx + wx) * 0.5 + nx * (sgn * 2.5);
    const midY = (sy + wy) * 0.5 + ny * (sgn * 2.5);

    ctx.save();
    const grad = ctx.createLinearGradient(sx, sy, wx, wy);
    grad.addColorStop(0, '#1f223b');
    grad.addColorStop(0.65, '#272b4b');
    grad.addColorStop(1, '#31365e');

    ctx.beginPath();
    ctx.moveTo(sx + nx * rSh, sy + ny * rSh);
    ctx.quadraticCurveTo(midX + nx * 11.0, midY + ny * 11.0, wx + nx * rCuff, wy + ny * rCuff);
    ctx.lineTo(wx - nx * rCuff, wy - ny * rCuff);
    ctx.quadraticCurveTo(midX - nx * 11.0, midY - ny * 11.0, sx - nx * rSh, sy - ny * rSh);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(sx, sy, rSh, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#181a2e';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx + nx * rSh, sy + ny * rSh);
    ctx.quadraticCurveTo(midX + nx * 11.0, midY + ny * 11.0, wx + nx * rCuff, wy + ny * rCuff);
    ctx.moveTo(sx - nx * rSh, sy - ny * rSh);
    ctx.quadraticCurveTo(midX - nx * 11.0, midY - ny * 11.0, wx - nx * rCuff, wy - ny * rCuff);
    ctx.stroke();

    const trimDist = Math.max(8, wristDist - 5.5);
    ctx.save();
    ctx.translate(sx + ux * trimDist, sy + uy * trimDist);
    ctx.rotate(ang + Math.PI / 2);
    ctx.strokeStyle = 'rgba(205, 212, 232, 0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-rCuff + 2, 0);
    ctx.lineTo(rCuff - 2, 0);
    ctx.stroke();
    ctx.fillStyle = '#e7c67b';
    ctx.beginPath();
    ctx.arc(0, 0, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(wx, wy);
    ctx.rotate(ang + Math.PI / 2);
    ctx.fillStyle = '#f8f9fe';
    ctx.strokeStyle = '#252844';
    ctx.lineWidth = 1.8;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.arc(i * 4.4, 0, 4.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(0, -0.5, 10.2, 3.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Pure round chibi hand (zero thumb!)
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.fillStyle = '#fde7df';
    ctx.strokeStyle = '#3d2c35';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.ellipse(0, 0, 8.4 * (1 + squash * 0.14), 8.2 * (1 - squash * 0.10), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.beginPath();
    ctx.arc(-2.2, -2.2, 2.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }
}

export type CritterKind = 'butterfly' | 'bee' | 'bird' | 'dragonfly' | 'ladybug' | 'firefly' | 'bat';

export const CRITTER_KINDS: CritterKind[] = [
  'butterfly',
  'bee',
  'bird',
  'dragonfly',
  'ladybug',
  'firefly',
  'bat',
];

/** Wing-beat speed (radians per second) per critter. */
export const CRITTER_FLAP_SPEED: Record<CritterKind, number> = {
  butterfly: 13,
  bee: 46,
  bird: 17,
  dragonfly: 40,
  ladybug: 34,
  firefly: 24,
  bat: 15,
};

/**
 * Draws a tiny flying critter centered at the current origin.
 * `flap` is the wing-beat phase, `facing` is +1 (right) / -1 (left), `t` is elapsed seconds.
 */
export function drawCritter(
  ctx: CanvasRenderingContext2D,
  kind: CritterKind,
  flap: number,
  facing: number,
  t: number,
): void {
  ctx.save();
  ctx.scale(facing < 0 ? -1 : 1, 1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (kind) {
    case 'butterfly':
      drawButterfly(ctx, flap);
      break;
    case 'bee':
      drawBee(ctx, flap);
      break;
    case 'bird':
      drawBird(ctx, flap);
      break;
    case 'dragonfly':
      drawDragonfly(ctx, flap);
      break;
    case 'ladybug':
      drawLadybug(ctx, flap);
      break;
    case 'firefly':
      drawFirefly(ctx, flap, t);
      break;
    case 'bat':
      drawBat(ctx, flap);
      break;
  }
  ctx.restore();
}

function drawButterfly(ctx: CanvasRenderingContext2D, flap: number): void {
  // Wings fold toward the body (x-scale) as they beat
  const open = 0.25 + 0.75 * Math.abs(Math.cos(flap));
  const outline = '#3b2a4a';
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.scale(side * open, 1);
    // Upper wing
    const g = ctx.createRadialGradient(4, -5, 1, 7, -6, 12);
    g.addColorStop(0, '#fff3a8');
    g.addColorStop(0.45, '#ffb347');
    g.addColorStop(1, '#ff6fa8');
    ctx.fillStyle = g;
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(0.5, -1);
    ctx.bezierCurveTo(3, -13, 15, -14, 13, -4);
    ctx.bezierCurveTo(12, 0, 6, 1, 0.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Lower wing
    ctx.fillStyle = '#ff8fc0';
    ctx.beginPath();
    ctx.moveTo(0.5, 0.5);
    ctx.bezierCurveTo(7, 1, 11, 7, 7, 10);
    ctx.bezierCurveTo(4, 12, 1, 6, 0.5, 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Wing spots
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(9, -7, 1.6, 0, Math.PI * 2);
    ctx.arc(5.5, 5.5, 1.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // Body & antennae
  ctx.fillStyle = outline;
  ctx.beginPath();
  ctx.ellipse(0, 0, 1.5, 6.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(0, -5.5);
  ctx.quadraticCurveTo(2, -10, 4.5, -11);
  ctx.moveTo(0, -5.5);
  ctx.quadraticCurveTo(-2, -10, -4.5, -11);
  ctx.stroke();
  ctx.fillStyle = outline;
  ctx.beginPath();
  ctx.arc(4.5, -11, 1, 0, Math.PI * 2);
  ctx.arc(-4.5, -11, 1, 0, Math.PI * 2);
  ctx.fill();
}

function drawBee(ctx: CanvasRenderingContext2D, flap: number): void {
  const wingLift = Math.sin(flap) * 0.5;
  // Wings (behind body, translucent)
  ctx.fillStyle = 'rgba(214, 240, 255, 0.78)';
  ctx.strokeStyle = 'rgba(70, 110, 140, 0.7)';
  ctx.lineWidth = 0.9;
  for (const [ox, rot] of [
    [-2, -0.5 - wingLift],
    [2.5, 0.2 - wingLift * 0.8],
  ] as Array<[number, number]>) {
    ctx.save();
    ctx.translate(ox, -4);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.ellipse(0, -5, 3.6, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  // Fuzzy striped body
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, 8.5, 6.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd23f';
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = '#2b2422';
  for (const x of [-4.8, 0, 4.8]) {
    ctx.fillRect(x - 1.3, -7, 2.6, 14);
  }
  ctx.restore();
  ctx.strokeStyle = '#2b2422';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(0, 0, 8.5, 6.2, 0, 0, Math.PI * 2);
  ctx.stroke();
  // Stinger
  ctx.fillStyle = '#2b2422';
  ctx.beginPath();
  ctx.moveTo(-8.2, -1);
  ctx.lineTo(-11.5, 0);
  ctx.lineTo(-8.2, 1.2);
  ctx.fill();
  // Face
  ctx.fillStyle = '#2b2422';
  ctx.beginPath();
  ctx.arc(5.4, -1.2, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 140, 140, 0.7)';
  ctx.beginPath();
  ctx.arc(6.2, 2, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#2b2422';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(6, -5);
  ctx.quadraticCurveTo(8, -9, 10, -9);
  ctx.stroke();
}

function drawBird(ctx: CanvasRenderingContext2D, flap: number): void {
  const wing = Math.sin(flap);
  const outline = '#2c4a6e';
  // Tail
  ctx.fillStyle = '#3f86c9';
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-6, 0);
  ctx.lineTo(-13, -3.5);
  ctx.lineTo(-12, 1);
  ctx.lineTo(-13, 4.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Round body
  const g = ctx.createRadialGradient(2, -2, 1, 0, 0, 9);
  g.addColorStop(0, '#9fd8ff');
  g.addColorStop(1, '#4a9be0');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, 8, 6.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Belly
  ctx.fillStyle = '#fff3d6';
  ctx.beginPath();
  ctx.ellipse(2, 2.6, 4.6, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  // Beak
  ctx.fillStyle = '#ffb02e';
  ctx.beginPath();
  ctx.moveTo(7.4, -1.6);
  ctx.lineTo(11.5, -0.2);
  ctx.lineTo(7.4, 1.2);
  ctx.closePath();
  ctx.fill();
  // Eye
  ctx.fillStyle = '#1b2433';
  ctx.beginPath();
  ctx.arc(4.4, -2.2, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(4.8, -2.6, 0.45, 0, Math.PI * 2);
  ctx.fill();
  // Flapping wing
  ctx.save();
  ctx.translate(-1, -1.5);
  ctx.scale(1, wing);
  ctx.fillStyle = '#2f74b8';
  ctx.beginPath();
  ctx.moveTo(3, 0);
  ctx.quadraticCurveTo(-1, -12, -8, -9);
  ctx.quadraticCurveTo(-5, -3, -4, 0);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 1 / Math.max(0.25, Math.abs(wing));
  ctx.stroke();
  ctx.restore();
}

function drawDragonfly(ctx: CanvasRenderingContext2D, flap: number): void {
  const beat = Math.sin(flap) * 0.35;
  ctx.fillStyle = 'rgba(200, 245, 255, 0.55)';
  ctx.strokeStyle = 'rgba(60, 140, 160, 0.75)';
  ctx.lineWidth = 0.8;
  for (const [ox, len, a] of [
    [1.5, 13, -1.25 + beat],
    [1.5, 13, 1.25 - beat],
    [-1.5, 11, -1.85 - beat],
    [-1.5, 11, 1.85 + beat],
  ] as Array<[number, number, number]>) {
    ctx.save();
    ctx.translate(ox, 0);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.ellipse(len * 0.5, 0, len * 0.5, 2.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  // Long segmented abdomen
  const g = ctx.createLinearGradient(-16, 0, 6, 0);
  g.addColorStop(0, '#2fb8a4');
  g.addColorStop(1, '#3fd6ff');
  ctx.strokeStyle = g;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.lineTo(-16, 0.6);
  ctx.stroke();
  ctx.fillStyle = '#25a28f';
  ctx.beginPath();
  ctx.ellipse(3.5, 0, 3.2, 2.6, 0, 0, Math.PI * 2);
  ctx.fill();
  // Big compound eyes
  ctx.fillStyle = '#1d6f87';
  ctx.beginPath();
  ctx.arc(7, -1.6, 2, 0, Math.PI * 2);
  ctx.arc(7, 1.6, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.beginPath();
  ctx.arc(7.6, -2.2, 0.6, 0, Math.PI * 2);
  ctx.fill();
}

function drawLadybug(ctx: CanvasRenderingContext2D, flap: number): void {
  const beat = Math.sin(flap) * 0.4;
  // Thin flight wings
  ctx.fillStyle = 'rgba(230, 240, 255, 0.7)';
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.rotate(side * (0.9 + beat));
    ctx.beginPath();
    ctx.ellipse(-4, side * -7, 6, 2.4, side * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // Shell (slightly open elytra)
  ctx.strokeStyle = '#2a1414';
  ctx.lineWidth = 1.1;
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.rotate(side * 0.18);
    ctx.fillStyle = '#e8332f';
    ctx.beginPath();
    ctx.ellipse(-1, side * 2.4, 7, 4.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2a1414';
    ctx.beginPath();
    ctx.arc(-3, side * 3, 1.4, 0, Math.PI * 2);
    ctx.arc(1.5, side * 4, 1.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // Head
  ctx.fillStyle = '#2a1414';
  ctx.beginPath();
  ctx.arc(6.5, 0, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(7.6, -1.3, 0.8, 0, Math.PI * 2);
  ctx.arc(7.6, 1.3, 0.8, 0, Math.PI * 2);
  ctx.fill();
}

function drawFirefly(ctx: CanvasRenderingContext2D, flap: number, t: number): void {
  const glow = 0.55 + 0.45 * Math.sin(t * 5.5);
  // Soft glowing aura
  const aura = ctx.createRadialGradient(-5, 1, 0, -5, 1, 16);
  aura.addColorStop(0, `rgba(240, 255, 120, ${(0.75 * glow).toFixed(3)})`);
  aura.addColorStop(1, 'rgba(240, 255, 120, 0)');
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(-5, 1, 16, 0, Math.PI * 2);
  ctx.fill();
  // Wings
  const beat = Math.sin(flap) * 0.45;
  ctx.fillStyle = 'rgba(220, 235, 255, 0.7)';
  ctx.save();
  ctx.rotate(-0.6 - beat);
  ctx.beginPath();
  ctx.ellipse(-1, -5, 2.6, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Body + glowing tail lamp
  ctx.fillStyle = '#3a3226';
  ctx.beginPath();
  ctx.ellipse(1, 0, 4, 2.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(232, 255, 90, ${(0.7 + 0.3 * glow).toFixed(3)})`;
  ctx.shadowColor = '#eaff5a';
  ctx.shadowBlur = 8 * glow;
  ctx.beginPath();
  ctx.ellipse(-4.5, 0.6, 3.6, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(4, -0.8, 0.8, 0, Math.PI * 2);
  ctx.fill();
}

function drawBat(ctx: CanvasRenderingContext2D, flap: number): void {
  const wing = Math.sin(flap);
  const outline = '#1e1830';
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.scale(side, 0.35 + 0.65 * Math.abs(wing));
    ctx.fillStyle = '#5a4b86';
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(2, -1);
    ctx.quadraticCurveTo(8, -9, 16, -5);
    ctx.quadraticCurveTo(13, -2, 13, 1);
    ctx.quadraticCurveTo(10, -1, 8, 2);
    ctx.quadraticCurveTo(6, 0, 3, 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = '#4a3d72';
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(0, 0.5, 4.2, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Ears
  ctx.beginPath();
  ctx.moveTo(-3, -3);
  ctx.lineTo(-2.4, -7.5);
  ctx.lineTo(-0.6, -4);
  ctx.moveTo(3, -3);
  ctx.lineTo(2.4, -7.5);
  ctx.lineTo(0.6, -4);
  ctx.fill();
  // Eyes & tiny fangs
  ctx.fillStyle = '#ffe066';
  ctx.beginPath();
  ctx.arc(-1.5, -0.6, 1.1, 0, Math.PI * 2);
  ctx.arc(1.5, -0.6, 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(-1, 2.2);
  ctx.lineTo(-0.5, 3.6);
  ctx.lineTo(0, 2.2);
  ctx.moveTo(0.4, 2.2);
  ctx.lineTo(0.9, 3.6);
  ctx.lineTo(1.4, 2.2);
  ctx.fill();
}

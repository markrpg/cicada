// Additive overlay on the waterfall: sparks that fly off the "now" edge where a tone lands,
// a glowing eye that tracks the dominant tone, bloom flashes and shockwave rings on frame start.

import { F_LO, F_HI } from './ui-spectro.js';

export const PALETTES = {
  rx: ['#19e6ff', '#2bffc6', '#7dff4a', '#eaff6b'],
  tx: ['#ff2bd6', '#ff4f86', '#ff7a1a', '#ffd23a'],
  ok: ['#7dff4a', '#eaff6b', '#2bffc6', '#ffffff'],
  bad: ['#ff4a5e', '#ff7a1a'],
};

function sprite(color, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, color);
  grd.addColorStop(0.45, color + '55');
  grd.addColorStop(1, color + '00');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

const LABELS = [2000, 3000, 4000, 5000, 6000, 7000];

export class FX {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.parts = [];
    this.flashes = [];
    this.rings = [];
    this.sprites = {};
    for (const [k, list] of Object.entries(PALETTES)) this.sprites[k] = list.map((col) => sprite(col));
    this.big = {};
    for (const [k, list] of Object.entries(PALETTES)) this.big[k] = sprite(list[0], 256);
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.cap = this.reduced ? 80 : 520;
    this.eye = { x: 0, y: 0, a: 0, pal: 'rx' };
    this.topInset = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.W = innerWidth;
    this.H = innerHeight;
    this.portrait = this.H > this.W * 1.08;
    this.c.width = Math.round(this.W * dpr);
    this.c.height = Math.round(this.H * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // f: 0..1 across 1–8 kHz.
  edge(f) {
    return this.portrait ? [this.W * f, 0] : [this.W, this.H * (1 - f)];
  }

  spark(f, pal = 'rx', count = 4, power = 1, dim = false) {
    const [x, y] = this.edge(f);
    const list = this.sprites[pal];
    const n = Math.min(count, this.cap - this.parts.length);
    for (let i = 0; i < n; i++) {
      const speed = (90 + Math.random() * 300) * power;
      const spread = (Math.random() - 0.5) * 220 * power;
      this.parts.push({
        x, y,
        vx: this.portrait ? spread : -speed,
        vy: this.portrait ? speed : spread,
        life: 0,
        max: 0.45 + Math.random() * 0.75,
        size: (8 + Math.random() * 22) * (0.7 + power * 0.3),
        img: list[(Math.random() * list.length) | 0],
        alpha: dim ? 0.35 : 1,
      });
    }
  }

  // A whole-screen burst from the edge: frame start, frame done.
  bloom(f, pal = 'rx', dim = false) {
    const [x, y] = this.edge(f);
    const a = dim ? 0.3 : 1;
    this.flashes.push({ x, y, t: 0, dur: 0.9, pal, a });
    this.rings.push({ x, y, t: 0, dur: 1.1, color: PALETTES[pal][0], a });
    this.rings.push({ x, y, t: -0.12, dur: 1.2, color: PALETTES[pal][2], a: a * 0.7 });
    if (!this.reduced) this.spark(f, pal, dim ? 10 : 40, 1.8, dim);
  }

  frame(dt, peak, pal) {
    const { g, W, H } = this;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);

    // frequency ticks
    g.font = '600 11px ui-monospace, "SF Mono", "Roboto Mono", Menlo, monospace';
    g.fillStyle = 'rgba(244,239,252,0.32)';
    if (this.portrait) {
      g.textAlign = 'center';
      g.textBaseline = 'top';
      const y = this.topInset + 6;
      for (const hz of LABELS) g.fillText(`${hz / 1000}k`, (W * (hz - F_LO)) / (F_HI - F_LO), y);
    } else {
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      for (const hz of LABELS) g.fillText(`${hz / 1000}k`, 14, H * (1 - (hz - F_LO) / (F_HI - F_LO)));
    }

    g.globalCompositeOperation = 'lighter';

    // flashes
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const p = f.t / f.dur;
      if (p >= 1) { this.flashes.splice(i, 1); continue; }
      const r = Math.max(W, H) * (0.5 + p * 0.9);
      g.globalAlpha = f.a * 0.7 * (1 - p) * (1 - p);
      g.drawImage(this.big[f.pal], f.x - r, f.y - r, r * 2, r * 2);
    }

    // rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const rg = this.rings[i];
      rg.t += dt;
      if (rg.t < 0) continue;
      const p = rg.t / rg.dur;
      if (p >= 1) { this.rings.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - p, 3);
      const r = 20 + e * Math.max(W, H) * 0.75;
      g.strokeStyle = rg.color;
      g.globalAlpha = rg.a * (1 - p) * 0.35;
      g.lineWidth = 14 * (1 - p) + 2;
      g.beginPath();
      g.arc(rg.x, rg.y, r, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = rg.a * (1 - p) * 0.9;
      g.lineWidth = 2;
      g.stroke();
    }

    // particles
    const drag = Math.pow(0.12, dt);
    const parts = this.parts;
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i];
      q.life += dt;
      if (q.life >= q.max) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
      q.vx *= drag;
      q.vy *= drag;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      const p = q.life / q.max;
      const s = q.size * (1 - p * 0.6);
      g.globalAlpha = q.alpha * (1 - p);
      g.drawImage(q.img, q.x - s / 2, q.y - s / 2, s, s);
    }

    // eye on the strongest tone
    const eye = this.eye;
    if (peak && peak.active) {
      const [x, y] = this.edge(peak.peak);
      eye.x = eye.a > 0.05 ? eye.x + (x - eye.x) * 0.5 : x;
      eye.y = eye.a > 0.05 ? eye.y + (y - eye.y) * 0.5 : y;
      eye.a = Math.min(1, eye.a + dt * 10);
      eye.pal = pal;
    } else {
      eye.a = Math.max(0, eye.a - dt * 3);
    }
    if (eye.a > 0.01) {
      const lvl = peak ? peak.level : 0.5;
      const s = 50 + lvl * 120;
      g.globalAlpha = eye.a * 0.9;
      g.drawImage(this.sprites[eye.pal][0], eye.x - s / 2, eye.y - s / 2, s, s);
      g.globalAlpha = eye.a;
      g.drawImage(this.sprites[eye.pal][3], eye.x - s / 5, eye.y - s / 5, s / 2.5, s / 2.5);
      // edge line
      g.globalAlpha = eye.a * 0.5;
      g.fillStyle = PALETTES[eye.pal][0];
      if (this.portrait) g.fillRect(0, 0, W, 2);
      else g.fillRect(W - 2, 0, 2, H);
    }

    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }
}

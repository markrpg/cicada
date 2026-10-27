// Segmented glowing progress bar. Each segment lights white-hot as its symbols land, then
// cools into a colour sweep that keeps flowing along the lit run.
// 'tx' (outgoing): slanted ember chevrons, magenta → orange → gold.
// 'rx' (incoming): upright biolume ticks that grow in, cyan → acid green.

const PALS = {
  tx: ['#ff2bd6', '#ff3d8b', '#ff7a1a', '#ffd23a'],
  rx: ['#19e6ff', '#2bffc6', '#7dff4a', '#eaff6b'],
  bad: ['#ff4a5e', '#ff2b5e', '#ff7a1a', '#ff4a5e'],
};
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const RGB = Object.fromEntries(Object.entries(PALS).map(([k, v]) => [k, v.map(rgb)]));

function sample(pal, t) {
  t = t - Math.floor(t);
  t = t < 0.5 ? t * 2 : 2 - t * 2; // ping-pong so the sweep never jumps
  const x = t * (pal.length - 1);
  const i = Math.min(pal.length - 2, Math.floor(x));
  const f = x - i;
  const a = pal[i], b = pal[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mixWhite = (c, f) => [c[0] + (255 - c[0]) * f, c[1] + (255 - c[1]) * f, c[2] + (255 - c[2]) * f];

export class SegBar {
  constructor(canvas, kind) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.kind = kind;
    this.total = 1;
    this.value = 0;
    this.n = 0;
    this.lit = new Float64Array(0);
    this.litCount = 0;
    this.state = 'arm';
    this.tEnd = 0;
    this.w = 0;
    this.h = 0;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = r.width;
    this.h = r.height;
    this.c.width = Math.round(r.width * dpr);
    this.c.height = Math.round(r.height * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layout();
  }

  layout() {
    if (!this.w) return;
    const per = this.kind === 'tx' ? 11 : 8;
    const n = Math.max(1, Math.min(this.total, Math.max(12, Math.min(140, Math.floor(this.w / per)))));
    if (n === this.n) return;
    const frac = this.n ? this.litCount / this.n : 0;
    this.n = n;
    this.lit = new Float64Array(n);
    this.litCount = Math.round(frac * n);
    this.lit.fill(-1e9, 0, this.litCount);
    this.set(this.value);
  }

  setTotal(t) {
    t = Math.max(1, t | 0);
    if (t === this.total) return;
    this.total = t;
    this.n = 0;
    this.layout();
  }

  set(v) {
    this.value = Math.min(this.total, Math.max(0, v));
    if (!this.n) return;
    const want = Math.floor((this.value / this.total) * this.n + 1e-9);
    const now = performance.now();
    for (let i = this.litCount; i < want; i++) this.lit[i] = now + (i - this.litCount) * 16;
    this.litCount = Math.max(this.litCount, want);
    if (this.state === 'arm' && this.value > 0) this.state = 'run';
  }

  finish(ok) {
    if (ok) this.set(this.total);
    this.state = ok ? 'ok' : 'bad';
    this.tEnd = performance.now();
  }

  // Path of one segment.
  seg(g, x, w, y, h, skew) {
    if (skew) {
      g.moveTo(x + skew, y);
      g.lineTo(x + w + skew, y);
      g.lineTo(x + w, y + h);
      g.lineTo(x, y + h);
      g.closePath();
    } else {
      const r = Math.min(2, w / 2);
      g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
    }
  }

  draw(now) {
    const { g, w, h, n } = this;
    if (!w || !n) return;
    g.clearRect(0, 0, w, h);
    const tx = this.kind === 'tx';
    const skew = tx ? h * 0.42 : 0;
    const gap = tx ? 3 : 2;
    const segW = (w - skew - gap * (n - 1)) / n;
    const pal = RGB[this.state === 'bad' ? 'bad' : this.kind];
    const sweep = (now / 1000) * (tx ? 0.45 : 0.32);
    const lc = this.litCount;

    // unlit track
    g.fillStyle = 'rgba(255,255,255,0.075)';
    g.beginPath();
    for (let i = lc; i < n; i++) {
      const x = i * (segW + gap);
      if (tx) this.seg(g, x, segW, 0, h, skew);
      else this.seg(g, x, segW, h * 0.36, h * 0.28, 0);
    }
    g.fill();

    // finished: a white wave runs across once
    let wave = -1;
    if (this.state === 'ok') wave = (now - this.tEnd) / 650;

    // lit segments
    let head = null;
    for (let i = 0; i < lc; i++) {
      const x = i * (segW + gap);
      const age = (now - this.lit[i]) / 1000;
      if (age < 0) continue;
      let c = sample(pal, i / Math.max(1, n - 1) * 0.9 - sweep);
      let hot = Math.max(0, 1 - age / 0.4);
      if (wave >= 0 && wave < 1.4) hot = Math.max(hot, Math.max(0, 1 - Math.abs(wave * n - i) / (n * 0.12)));
      if (this.state === 'bad') hot *= 0.6;
      c = mixWhite(c, hot * 0.85);
      g.fillStyle = css(c);
      g.beginPath();
      if (tx) {
        this.seg(g, x, segW, 0, h, skew);
      } else {
        const grow = Math.min(1, age / 0.12);
        const hh = h * (0.28 + 0.72 * (1 - Math.pow(1 - grow, 3)));
        this.seg(g, x, segW, (h - hh) / 2, hh, 0);
      }
      g.fill();
      if (i === lc - 1) head = { x, c };
    }

    g.save();
    g.globalCompositeOperation = 'lighter';

    // sheen across the lit run
    if (lc > 0) {
      const litW = lc * (segW + gap);
      const period = 1.6;
      const p = ((now / 1000) % period) / period;
      const sx = -80 + p * (litW + 160);
      const grd = g.createLinearGradient(sx - 60, 0, sx + 60, 0);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0.32)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = grd;
      g.fillRect(0, 0, Math.min(w, litW + skew), h);
      g.globalCompositeOperation = 'lighter';
    }

    // glowing head
    if (head && this.state !== 'bad') {
      const pulse = 0.6 + 0.4 * Math.sin(now / 90);
      g.shadowColor = css(head.c, 1);
      g.shadowBlur = 16;
      g.fillStyle = css(mixWhite(head.c, 0.5), 0.55 * pulse);
      g.beginPath();
      this.seg(g, head.x, segW, 0, h, skew);
      g.fill();
      g.shadowBlur = 0;
    }

    // waiting for data: a comet scans the empty track
    if (this.state === 'arm') {
      const p = (now / 1000) % 1.3 / 1.3;
      const t = p < 0.5 ? p * 2 : 2 - p * 2;
      const cx = t * w;
      const grd = g.createLinearGradient(cx - 70, 0, cx + 70, 0);
      const c = pal[0];
      grd.addColorStop(0, css(c, 0));
      grd.addColorStop(0.5, css(c, 0.85));
      grd.addColorStop(1, css(c, 0));
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = grd;
      g.fillRect(cx - 70, 0, 140, h);
    }
    g.restore();
  }

  get settled() {
    return (this.state === 'ok' || this.state === 'bad') && performance.now() - this.tEnd > 1100;
  }

  destroy() {
    this.ro.disconnect();
  }
}

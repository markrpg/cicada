// Scrolling waterfall of 1–8 kHz. The canvas backing store is only (time × bins) pixels
// and CSS stretches it to the viewport, so the GPU does the upscaling for free.
// Landscape: time flows right→left, low frequencies at the bottom.
// Portrait:  time falls top→bottom, low frequencies on the left.

export const F_LO = 1000;
export const F_HI = 8000;

const STOPS = [
  [0.0, [6, 4, 11]],
  [0.16, [24, 10, 72]],
  [0.33, [88, 18, 176]],
  [0.5, [214, 22, 143]],
  [0.64, [255, 72, 64]],
  [0.78, [255, 174, 46]],
  [0.9, [232, 255, 112]],
  [1.0, [255, 255, 255]],
];

function buildLUT() {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let k = 1;
    while (k < STOPS.length - 1 && STOPS[k][0] < v) k++;
    const [p0, c0] = STOPS[k - 1], [p1, c1] = STOPS[k];
    const t = Math.min(1, Math.max(0, (v - p0) / (p1 - p0)));
    const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
    const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
    const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
    lut[i] = (255 << 24) | (b << 16) | (g << 8) | r; // little-endian RGBA
  }
  return lut;
}

// Byte magnitude → colour index: drop the noise floor, then a gamma that keeps tones hot.
function buildCurve(floor = 62, gamma = 1.5) {
  const c = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const v = Math.max(0, (i - floor) / (255 - floor));
    c[i] = Math.round(255 * Math.pow(v, gamma));
  }
  return c;
}

export class Spectrogram {
  constructor(canvas, bloom) {
    this.c = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    this.bloom = bloom;
    this.bg = bloom.getContext('2d', { alpha: false });
    this.bloomOn = true;
    this.lut = buildLUT();
    this.curve = buildCurve();
    this.step = 1;
    this.key = '';
    this.data = null;
    this.result = { active: false, peak: 0, level: 0, energy: 0 };
    this.configure(this.isPortrait(), 150);
  }

  isPortrait() {
    return innerHeight > innerWidth * 1.08;
  }

  setBloom(on) {
    this.bloomOn = on;
    this.bloom.classList.toggle('off', !on);
  }

  configure(portrait, bins) {
    this.portrait = portrait;
    this.bins = bins;
    const len = portrait ? 440 : 760;
    const { c, bloom } = this;
    if (portrait) { c.width = bins; c.height = len; } else { c.width = len; c.height = bins; }
    bloom.width = Math.max(1, c.width >> 2);
    bloom.height = Math.max(1, c.height >> 2);
    this.g.fillStyle = '#06040b';
    this.g.fillRect(0, 0, c.width, c.height);
    this.bg.fillStyle = '#06040b';
    this.bg.fillRect(0, 0, bloom.width, bloom.height);
    this.col = portrait ? this.g.createImageData(bins, this.step) : this.g.createImageData(this.step, bins);
    this.px = new Uint32Array(this.col.data.buffer);
  }

  // Scroll one step and paint the newest slice. Returns the dominant tone in the band.
  frame(analyser) {
    const portrait = this.isPortrait();
    if (!analyser) {
      if (portrait !== this.portrait) this.configure(portrait, this.bins);
      this.result.active = false;
      this.result.level *= 0.9;
      return this.result;
    }
    const sr = analyser.context.sampleRate;
    const binHz = sr / analyser.fftSize;
    const lo = Math.ceil(F_LO / binHz), hi = Math.floor(F_HI / binHz);
    const bins = hi - lo + 1;
    if (portrait !== this.portrait || bins !== this.bins) this.configure(portrait, bins);
    if (!this.data || this.data.length !== analyser.frequencyBinCount) this.data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(this.data);

    const { g, c, step, px, lut, curve, data } = this;
    if (portrait) g.drawImage(c, 0, step);
    else g.drawImage(c, -step, 0);

    let max = 0, maxK = 0, sum = 0;
    for (let k = 0; k < bins; k++) {
      const raw = data[lo + k];
      sum += raw;
      if (raw > max) { max = raw; maxK = k; }
      const color = lut[curve[raw]];
      if (portrait) {
        for (let s = 0; s < step; s++) px[s * bins + k] = color;
      } else {
        const y = bins - 1 - k;
        for (let s = 0; s < step; s++) px[y * step + s] = color;
      }
    }
    if (portrait) g.putImageData(this.col, 0, 0);
    else g.putImageData(this.col, c.width - step, 0);

    if (this.bloomOn) this.bg.drawImage(c, 0, 0, this.bloom.width, this.bloom.height);

    const mean = sum / bins;
    const r = this.result;
    r.level = max / 255;
    r.energy = mean / 255;
    r.peak = maxK / (bins - 1);
    r.active = max > 150 && max > mean * 1.9;
    return r;
  }
}

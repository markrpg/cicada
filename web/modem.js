// Tower protocol v2: a low drone opens into a data-bearing resonant cicada buzz.
// Header and payload use Reed–Solomon, interleaving, whitening and CRC-32.

import { fft, nextPow2 } from './fft.js';
import * as rs from './rs.js';
import { DIBIT_SECONDS, BUZZ_FREQUENCIES, SYNC_WORD, writeBuzz, writeDrone } from './tower-synth.js';

export const CONFIG = Object.freeze({
  protocol: 2,
  symbolDur: DIBIT_SECONDS * 4, // one encoded byte, four physical dibits
  intro: 5.75,
  preambleGap: 0.035,
  lead: 0.05,
  tail: 0.35,
  headerParity: 6,
  blockData: 128,
  blockParity: 16,
  maxPayload: 1000,
  maxFrameSeconds: 180,
  maxPlaybackBytes: 128 * 1024 * 1024,
  frequencyLow: 50,
  frequencyHigh: 8000,
});

const HEADER_DATA = 3;
const HEADER_SYMBOLS = HEADER_DATA + CONFIG.headerParity;

export function toneFreq(band, k) {
  return BUZZ_FREQUENCIES[k];
}

function validate(length, sr = 48000) {
  if (!Number.isInteger(length) || length < 0 || length > CONFIG.maxPayload) throw new RangeError(`Payload must be 0–${CONFIG.maxPayload} bytes`);
  if (!Number.isFinite(sr) || sr < 8000 || sr > 96000) throw new RangeError('Sample rate must be between 8000 and 96000 Hz');
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Whitening keeps repeated characters from repeating the same tones.
function mask(i) {
  let x = Math.imul(i + 1, 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  return x & 0xff;
}

// Block sizes and the interleaved send order for a payload of `length` bytes.
function bodyLayout(length) {
  const bodyLen = length + 4;
  const nBlocks = Math.ceil(bodyLen / CONFIG.blockData);
  const sizes = [];
  for (let b = 0; b < nBlocks; b++) sizes.push(Math.floor(bodyLen / nBlocks) + (b < bodyLen % nBlocks ? 1 : 0));
  const offsets = [];
  sizes.reduce((o, s) => (offsets.push(o), o + s), 0);
  const cwLen = sizes.map((s) => s + CONFIG.blockParity);
  const order = []; // order[i] = [block, index within codeword]
  const longest = Math.max(...cwLen);
  for (let j = 0; j < longest; j++)
    for (let b = 0; b < nBlocks; b++) if (j < cwLen[b]) order.push([b, j]);
  return { bodyLen, sizes, offsets, cwLen, order };
}

export function symbolCount(length) {
  validate(length);
  return HEADER_SYMBOLS + bodyLayout(length).order.length;
}

export function frameSymbols(payload, kind = 0) {
  if (payload.length > CONFIG.maxPayload) throw new RangeError(`Payload over ${CONFIG.maxPayload} bytes`);
  const n = payload.length;
  const header = rs.encode(Uint8Array.of(kind & 0xff, n >> 8, n & 0xff), CONFIG.headerParity);
  const body = new Uint8Array(n + 4);
  body.set(payload);
  new DataView(body.buffer).setUint32(n, crc32(payload));
  const L = bodyLayout(n);
  const codewords = L.sizes.map((s, b) => rs.encode(body.subarray(L.offsets[b], L.offsets[b] + s), CONFIG.blockParity));
  const out = new Uint8Array(HEADER_SYMBOLS + L.order.length);
  out.set(header);
  L.order.forEach(([b, j], i) => (out[HEADER_SYMBOLS + i] = codewords[b][j]));
  return out;
}

const preambles = new Map();
export function preamble(sr) {
  validate(0, sr);
  let out = preambles.get(sr);
  if (out) return out;
  out = new Float32Array(Math.round(SYNC_WORD.length * DIBIT_SECONDS * sr));
  SYNC_WORD.forEach((state, i) => writeBuzz(out, Math.round(i * DIBIT_SECONDS * sr), state, sr, i + 1));
  preambles.set(sr, out);
  return out;
}

function writeSymbol(out, start, byte, sr, index) {
  for (let d = 0; d < 4; d++) writeBuzz(out, start + Math.round(d * DIBIT_SECONDS * sr), (byte >> (6 - 2 * d)) & 3, sr, index * 4 + d + 1);
}

const symbolStart = (i, sr) => Math.round(i * CONFIG.symbolDur * sr);

function layoutSamples(nSymbols, sr) {
  const lead = Math.round(CONFIG.lead * sr);
  const syncStart = lead + Math.round(CONFIG.intro * sr);
  const dataStart = syncStart + preamble(sr).length + Math.round(CONFIG.preambleGap * sr);
  const dataEnd = dataStart + symbolStart(nSymbols, sr);
  const total = dataEnd + Math.round(CONFIG.tail * sr);
  // PCM and the AudioBuffer playback copy both need to fit this budget.
  if (total / sr > CONFIG.maxFrameSeconds || total * 8 > CONFIG.maxPlaybackBytes) throw new RangeError('Transfer exceeds the three-minute or 128 MiB playback limit');
  return { lead, syncStart, dataStart, dataEnd, total };
}

export function frameTiming(payloadLength, sampleRate = 48000) {
  validate(payloadLength, sampleRate);
  const symbols = symbolCount(payloadLength);
  const s = layoutSamples(symbols, sampleRate);
  return { symbols, total: s.total / sampleRate, introEnd: s.syncStart / sampleRate, dataStart: s.dataStart / sampleRate, dataEnd: s.dataEnd / sampleRate };
}

export function synthesize(payload, sr, kind = 0) {
  validate(payload.length, sr);
  const symbols = frameSymbols(payload, kind);
  const pre = preamble(sr);
  const s = layoutSamples(symbols.length, sr);
  const out = new Float32Array(s.total);
  out.set(pre, s.syncStart);
  symbols.forEach((b, i) => writeSymbol(out, s.dataStart + symbolStart(i, sr), b ^ mask(i), sr, i));
  writeDrone(out, sr, s.dataEnd);
  return out;
}

function power(x, start, n, f, sr) {
  const c = 2 * Math.cos((2 * Math.PI * f) / sr);
  let s1 = 0, s2 = 0;
  for (let i = start, end = start + n; i < end; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

function dibit(x, start, sr) {
  const skip = Math.round(0.004 * sr), n = Math.round((DIBIT_SECONDS - 0.008) * sr);
  let best = 0, peak = -1, second = 0;
  for (let k = 0; k < 4; k++) {
    const p = power(x, start + skip, n, BUZZ_FREQUENCIES[k], sr);
    if (p > peak) { second = peak; peak = p; best = k; }
    else if (p > second) second = p;
  }
  let energy = 0;
  for (let j = 0; j < n; j++) energy += x[start + skip + j] ** 2;
  return { state: best, peak, margin: peak / (second + 1e-12), concentration: peak / (n * energy + 1e-12) };
}

export function decodeSymbol(x, start, sr) {
  let byte = 0, margin = Infinity, concentration = 0;
  for (let d = 0; d < 4; d++) {
    const r = dibit(x, start + Math.round(d * DIBIT_SECONDS * sr), sr);
    byte = (byte << 2) | r.state;
    margin = Math.min(margin, r.margin);
    concentration += r.concentration / 4;
  }
  return { byte, margin, concentration };
}

// Byte boundaries have a brief amplitude dip. Track it without relying on the
// data state; this keeps long frames aligned when the two audio clocks drift.
function trackBoundary(x, start, sr, limit) {
  const half = Math.round(0.0015 * sr), step = Math.max(1, Math.round(0.0002 * sr));
  const range = Math.round(0.0025 * sr);
  let best = start, energy = Infinity;
  for (let p = Math.max(half, start - range); p <= Math.min(limit - half, start + range); p += step) {
    let e = 0;
    for (let j = -half; j <= half; j++) { const v = x[p + j] - (x[p + j - 1] || 0); e += v * v; }
    if (e < energy) { energy = e; best = p; }
  }
  return best;
}

// Streaming decoder. Finds preambles by FFT cross-correlation, then reads symbols at
// fixed offsets from the correlation peak.
export class Receiver {
  constructor(sampleRate, handlers = {}) {
    this.sr = sampleRate;
    this.on = handlers;
    const tpl = preamble(sampleRate);
    this.M = tpl.length;
    this.N = nextPow2(this.M * 3);
    this.margin = 512;
    this.hop = this.N - this.M + 1 - this.margin;
    this.tRe = new Float64Array(this.N);
    this.tIm = new Float64Array(this.N);
    this.tRe.set(tpl);
    fft(this.tRe, this.tIm);
    this.tNorm = Math.sqrt(tpl.reduce((e, v) => e + v * v, 0));
    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
    this.cum = new Float64Array(this.N + 1);
    this.gap = Math.round(CONFIG.preambleGap * sampleRate);
    this.symSpan = Math.round(CONFIG.symbolDur * sampleRate);
    this.threshold = 0.35;
    this.buf = new Float32Array(Math.max(this.N * 2, sampleRate * 8));
    this.len = 0;
    this.base = 0; // absolute sample index of buf[0]
    this.pos = 0;  // absolute sample index where the preamble search resumes
    this.frame = null;
  }

  get end() {
    return this.base + this.len;
  }

  push(chunk) {
    this.append(chunk);
    for (;;) {
      if (this.frame ? !this.stepFrame() : !this.search()) return;
    }
  }

  append(chunk) {
    if (this.len + chunk.length > this.buf.length) {
      const keep = this.frame ? this.frame.dataStart + symbolStart(this.frame.i, this.sr) + Math.round(this.frame.correction) - Math.round(0.01 * this.sr) : this.pos;
      const drop = Math.max(0, Math.min(this.len, keep - this.base));
      if (drop > 0) {
        this.buf.copyWithin(0, drop, this.len);
        this.len -= drop;
        this.base += drop;
      }
      if (this.len + chunk.length > this.buf.length) {
        const grown = new Float32Array((this.len + chunk.length) * 2);
        grown.set(this.buf.subarray(0, this.len));
        this.buf = grown;
      }
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
  }

  search() {
    const { N, M, re, im, cum } = this;
    if (this.pos + N > this.end) return false;
    const off = this.pos - this.base;
    for (let i = 0; i < N; i++) {
      const v = this.buf[off + i];
      re[i] = v;
      im[i] = 0;
      cum[i + 1] = cum[i] + v * v;
    }
    fft(re, im);
    for (let i = 0; i < N; i++) {
      const a = re[i], b = im[i], c = this.tRe[i], d = this.tIm[i];
      re[i] = a * c + b * d;
      im[i] = b * c - a * d;
    }
    fft(re, im, true);
    const rho = (l) => re[l] / N / (this.tNorm * Math.sqrt(cum[l + M] - cum[l]) + 1e-9);
    let best = -1, bestRho = this.threshold;
    for (let l = 0; l < this.hop; l++) {
      const r = rho(l);
      if (r > bestRho) { bestRho = r; best = l; }
    }
    if (best < 0) {
      this.pos += this.hop;
      return true;
    }
    for (let l = best + 1, last = Math.min(best + this.margin, N - M); l <= last; l++) {
      const r = rho(l);
      if (r > bestRho) { bestRho = r; best = l; }
    }
    const start = this.pos + best;
    this.frame = { start, dataStart: start + M + this.gap, correction: 0, i: 0, symbols: [], header: null, rho: bestRho };
    return true;
  }

  stepFrame() {
    const f = this.frame;
    const expected = f.dataStart + symbolStart(f.i, this.sr) + Math.round(f.correction);
    if (expected + this.symSpan + Math.round(0.004 * this.sr) > this.end) return false;
    const local = expected - this.base;
    const boundary = trackBoundary(this.buf, local, this.sr, this.len);
    f.correction += 0.65 * (boundary - local);
    const s = f.dataStart + symbolStart(f.i, this.sr) + Math.round(f.correction);
    const decoded = decodeSymbol(this.buf, s - this.base, this.sr);
    f.quiet = decoded.concentration < 0.02 ? (f.quiet || 0) + 1 : 0;
    if (f.quiet >= 8) {
      if (f.header) this.on.message?.({ kind: f.header.kind, payload: this.preview(f), ok: false, fixed: 0 });
      this.frame = null;
      this.pos = s + this.symSpan;
      return true;
    }
    f.symbols.push(decoded.byte ^ mask(f.i));
    f.i++;
    if (f.i === HEADER_SYMBOLS) {
      const header = this.readHeader(f.symbols);
      if (!header) {
        this.frame = null;
        this.pos = f.start + this.M;
        return true;
      }
      f.header = header;
      f.layout = bodyLayout(header.length);
      f.total = HEADER_SYMBOLS + f.layout.order.length;
      this.on.start?.({ kind: header.kind, length: header.length });
    } else if (f.header) {
      this.on.progress?.({ received: f.i, total: f.total, preview: this.preview(f) });
      if (f.i === f.total) {
        this.on.message?.(this.finish(f));
        this.frame = null;
        this.pos = s + this.symSpan;
      }
    }
    return true;
  }

  readHeader(symbols) {
    try {
      const { data } = rs.decode(Uint8Array.from(symbols), CONFIG.headerParity);
      const length = (data[1] << 8) | data[2];
      if (length > CONFIG.maxPayload || data[0] > 3) return null;
      return { kind: data[0], length };
    } catch {
      return null;
    }
  }

  // Uncorrected payload bytes received so far, in order, stopping at the first gap.
  preview(f) {
    const { layout, header } = f;
    const out = new Uint8Array(header.length);
    const have = new Uint8Array(header.length);
    for (let i = HEADER_SYMBOLS; i < f.symbols.length; i++) {
      const [b, j] = layout.order[i - HEADER_SYMBOLS];
      if (j >= layout.sizes[b]) continue;
      const p = layout.offsets[b] + j;
      if (p < header.length) { out[p] = f.symbols[i]; have[p] = 1; }
    }
    let n = 0;
    while (n < header.length && have[n]) n++;
    return out.subarray(0, n);
  }

  finish(f) {
    const { layout, header } = f;
    const codewords = layout.cwLen.map((n) => new Uint8Array(n));
    layout.order.forEach(([b, j], i) => (codewords[b][j] = f.symbols[HEADER_SYMBOLS + i]));
    const body = new Uint8Array(layout.bodyLen);
    let fixed = 0, failedBlocks = 0;
    codewords.forEach((cw, b) => {
      try {
        const r = rs.decode(cw, CONFIG.blockParity);
        body.set(r.data, layout.offsets[b]);
        fixed += r.fixed;
      } catch {
        body.set(cw.subarray(0, layout.sizes[b]), layout.offsets[b]);
        failedBlocks++;
      }
    });
    const payload = body.slice(0, header.length);
    const ok = failedBlocks === 0 && new DataView(body.buffer).getUint32(header.length) === crc32(payload);
    return { kind: header.kind, payload, ok, fixed };
  }
}

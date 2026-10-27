// Cicada modem: bytes as insect chatter.
//
// Frame:   lead silence · preamble (buzzing up-chirp + down-chirp) · gap · symbols · tail
// Symbol:  one byte. The high nibble picks one of 16 tones in band A, the low nibble one of
//          16 tones in band B. Each band plays a train of short ticks, band B's ticks falling
//          between band A's, which gives the cricket-like trill.
// Symbols: 9 header symbols (kind, length hi, length lo + 6 Reed–Solomon parity), then the
//          body: payload + CRC-32, cut into Reed–Solomon blocks and interleaved so a burst
//          of noise spreads over several blocks.

import { fft, nextPow2 } from './fft.js';
import * as rs from './rs.js';

export const CONFIG = {
  bandA: 1650,          // Hz, tone 0 of the high-nibble band
  bandB: 4500,          // Hz, tone 0 of the low-nibble band
  step: 156.25,         // Hz between tones: a null of the 4-tick pulse train's spectrum
  pulses: 4,
  pulsePeriod: 0.016,
  pulseOn: 0.009,
  bandBOffset: 0.008,
  symbolDur: 0.08,
  sweep: 50,            // Hz each tick rises across its length
  chirpLow: 1400,
  chirpHigh: 7200,
  chirpDur: 0.1,
  preambleGap: 0.03,
  amp: 0.45,
  lead: 0.05,
  tail: 0.12,
  headerParity: 6,
  blockData: 128,       // max data bytes per body block
  blockParity: 16,      // corrects 8 bad symbols per block
  maxPayload: 65535,
};

const HEADER_DATA = 3;
const HEADER_SYMBOLS = HEADER_DATA + CONFIG.headerParity;

export function toneFreq(band, k) {
  return (band === 0 ? CONFIG.bandA : CONFIG.bandB) + k * CONFIG.step;
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
  let out = preambles.get(sr);
  if (out) return out;
  const { chirpLow: lo, chirpHigh: hi, chirpDur: T } = CONFIG;
  const n = Math.round(T * sr), ramp = Math.round(0.002 * sr);
  const mu = (hi - lo) / T;
  out = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const buzz = 0.75 + 0.25 * Math.cos(2 * Math.PI * 150 * t);
    const edge = Math.min(1, i / ramp, (n - 1 - i) / ramp);
    out[i] = Math.sin(2 * Math.PI * (lo * t + 0.5 * mu * t * t)) * buzz * edge;
    out[n + i] = Math.sin(2 * Math.PI * (hi * t - 0.5 * mu * t * t)) * buzz * edge;
  }
  preambles.set(sr, out);
  return out;
}

function writeTick(out, start, f, sr) {
  const n = Math.round(CONFIG.pulseOn * sr);
  const ramp = Math.max(1, Math.round(0.0012 * sr));
  const f0 = f - CONFIG.sweep / 2, k = CONFIG.sweep / CONFIG.pulseOn;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let env = 1 - 0.45 * (i / n); // fades across the tick like a stridulation click
    if (i < ramp) env *= 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
    else if (i > n - ramp) env *= 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / ramp);
    out[start + i] += CONFIG.amp * env * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
}

function writeSymbol(out, start, byte, sr) {
  const fa = toneFreq(0, byte >> 4), fb = toneFreq(1, byte & 15);
  for (let p = 0; p < CONFIG.pulses; p++) {
    writeTick(out, start + Math.round(p * CONFIG.pulsePeriod * sr), fa, sr);
    writeTick(out, start + Math.round((CONFIG.bandBOffset + p * CONFIG.pulsePeriod) * sr), fb, sr);
  }
}

const symbolStart = (i, sr) => Math.round(i * CONFIG.symbolDur * sr);

function layoutSamples(nSymbols, sr) {
  const lead = Math.round(CONFIG.lead * sr);
  const dataStart = lead + preamble(sr).length + Math.round(CONFIG.preambleGap * sr);
  const dataEnd = dataStart + symbolStart(nSymbols, sr);
  return { lead, dataStart, dataEnd, total: dataEnd + Math.round(CONFIG.tail * sr) };
}

// Seconds from the start of the synthesized PCM.
export function frameTiming(payloadLength, sampleRate = 48000) {
  const s = layoutSamples(symbolCount(payloadLength), sampleRate);
  return { symbols: symbolCount(payloadLength), total: s.total / sampleRate, dataStart: s.dataStart / sampleRate, dataEnd: s.dataEnd / sampleRate };
}

export function synthesize(payload, sr, kind = 0) {
  const symbols = frameSymbols(payload, kind);
  const pre = preamble(sr);
  const s = layoutSamples(symbols.length, sr);
  const out = new Float32Array(s.total);
  for (let i = 0; i < pre.length; i++) out[s.lead + i] = 0.8 * pre[i];
  symbols.forEach((b, i) => writeSymbol(out, s.dataStart + symbolStart(i, sr), b ^ mask(i), sr));
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

const PROBE = [-20, 0, 20];

function strongestTone(x, start, n, band, sr) {
  let best = 0, bestP = -1, second = 0;
  for (let k = 0; k < 16; k++) {
    const f = toneFreq(band, k);
    let p = 0;
    for (const d of PROBE) p += power(x, start, n, f + d, sr);
    if (p > bestP) {
      second = Math.max(second, bestP);
      bestP = p;
      best = k;
    } else if (p > second) second = p;
  }
  return { k: best, margin: bestP / (second + 1e-12) };
}

export function decodeSymbol(x, start, sr) {
  const n = Math.round(((CONFIG.pulses - 1) * CONFIG.pulsePeriod + CONFIG.pulseOn) * sr);
  const a = strongestTone(x, start, n, 0, sr);
  const b = strongestTone(x, start + Math.round(CONFIG.bandBOffset * sr), n, 1, sr);
  return { byte: (a.k << 4) | b.k, margin: Math.min(a.margin, b.margin) };
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
    this.symSpan = Math.round((CONFIG.bandBOffset + (CONFIG.pulses - 1) * CONFIG.pulsePeriod + CONFIG.pulseOn) * sampleRate);
    this.threshold = 0.25;
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
      const drop = (this.frame ? this.frame.start : this.pos) - this.base;
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
    this.frame = { start, dataStart: start + M + this.gap, i: 0, symbols: [], header: null, rho: bestRho };
    return true;
  }

  stepFrame() {
    const f = this.frame;
    const s = f.dataStart + symbolStart(f.i, this.sr);
    if (s + this.symSpan > this.end) return false;
    f.symbols.push(decodeSymbol(this.buf, s - this.base, this.sr).byte ^ mask(f.i));
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
      return { kind: data[0], length: (data[1] << 8) | data[2] };
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

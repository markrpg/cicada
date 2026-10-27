// Original oscillator model of a wavering ship terminal. No film samples or
// extracted spectral coefficients are used by the transmitter.
import { DIBIT_SECONDS, GRAIN_RATIOS } from './tower-synth.js';

export const INTRO_SECONDS = 2.4;
export const SYNC_WORD = [3, 0, 2, 1, 3, 1, 0, 0, 2, 3, 1, 2, 2, 0, 3, 1];
const cache = new Map();
const palette = [2638, 2638, 492, 492, 1930, 1266, 742, 1598];

export function buzzTemplate(seed, sr) {
  const key = `${seed}:${sr}`;
  if (cache.has(key)) return cache.get(key);
  const n = Math.round(DIBIT_SECONDS * sr / 2);
  const re = new Float32Array(n), im = new Float32Array(n);
  // The phrase evolves independently of the encoded bits.
  const f = palette[Math.floor((seed - 1) / 12) % palette.length];
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += 2 * Math.PI * (f + (f > 2000 ? 32 : 7) * Math.sin(2 * Math.PI * 19 * t)) / sr;
    const edge = Math.min(1, i / (0.002 * sr), (n - 1 - i) / (0.002 * sr));
    const tremolo = 0.8 + 0.2 * Math.cos(2 * Math.PI * 25 * t);
    re[i] = edge * tremolo * (Math.sin(phase) + 0.2 * Math.sin(2 * phase)) / 1.2;
    im[i] = edge * tremolo * (Math.cos(phase) + 0.2 * Math.cos(2 * phase)) / 1.2;
  }
  const result = { re, im };
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

export function writeBuzz(out, start, state, sr, seed = 1) {
  const { re } = buzzTemplate(seed, sr);
  const a = Math.sqrt(GRAIN_RATIOS[state]), b = 1 / a;
  for (let i = 0; i < re.length; i++) {
    if (start + i < out.length) out[start + i] += 0.32 * a * re[i];
    if (start + re.length + i < out.length) out[start + re.length + i] += 0.32 * b * re[i];
  }
}

export function writeDrone(out, sr) {
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const fade = Math.max(0, Math.min(1, t / 0.05, (out.length - i) / (sr * 0.2)));
    out[i] += fade * 0.008 * (Math.sin(2 * Math.PI * 398 * t) + 0.6 * Math.sin(2 * Math.PI * 503 * t));
    if (t < INTRO_SECONDS) {
      const f = t < 1.05 ? 2638 : t < 1.9 ? 492 : 1930;
      phase += 2 * Math.PI * (f + (f > 2000 ? 32 : 4) * Math.sin(2 * Math.PI * 19 * t)) / sr;
      const segmentStart = t < 1.05 ? 0 : t < 1.9 ? 1.05 : 1.9;
      const segmentEnd = t < 1.05 ? 1.05 : t < 1.9 ? 1.9 : INTRO_SECONDS;
      const edge = Math.min(1, (t - segmentStart) / 0.02, (segmentEnd - t) / 0.04);
      out[i] += fade * edge * 0.24 * (Math.sin(phase) + 0.16 * Math.sin(2 * phase));
    }
  }
}

// Procedural tower drone and resonant tymbal buzz. No recorded audio is embedded.
export const DIBIT_SECONDS = 0.05;
export const SYNC_WORD = [0, 3, 1, 0, 2, 2, 3, 0, 1, 3, 3, 2, 0, 2, 1, 1];

function random(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Data changes the relative loudness of two copies of the same short tymbal
// grain. Pitch, pulse rate and random ringing remain independent of the data.
export const GRAIN_RATIOS = [0.4, 0.74, 1 / 0.74, 2.5];
const grains = new Map();
export function buzzTemplate(seed, sr) {
  const key = `${seed}:${sr}`;
  if (grains.has(key)) return grains.get(key);
  const n = Math.round(DIBIT_SECONDS * sr / 2);
  const re = new Float32Array(n), im = new Float32Array(n);
  const r = random(seed);
  let at = 0;
  while (at < n) {
    const f = 2500 + r() * 700, decay = 0.0009 + r() * 0.0007, gain = 0.6 + 0.4 * r(), phase = r() * 2 * Math.PI;
    for (let j = 0; j < Math.round(decay * 5 * sr) && at + j < n; j++) {
      const env = gain * Math.exp(-j / (decay * sr));
      re[at + j] += env * Math.sin(2 * Math.PI * f * j / sr + phase);
      im[at + j] += env * Math.cos(2 * Math.PI * f * j / sr + phase);
    }
    at += Math.max(1, Math.round(sr / (650 + r() * 250)));
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(re[i]), Math.abs(im[i]));
  for (let i = 0; i < n; i++) {
    const edge = Math.min(1, i / (0.001 * sr), (n - 1 - i) / (0.001 * sr));
    re[i] *= edge / peak; im[i] *= edge / peak;
  }
  const result = { re, im };
  // Bound memory during repeated sends and long receiving sessions.
  if (grains.size >= 128) grains.delete(grains.keys().next().value);
  grains.set(key, result);
  return result;
}

export function writeBuzz(out, start, state, sr, seed = 1) {
  const { re } = buzzTemplate(seed, sr);
  const ratio = GRAIN_RATIOS[state], a = Math.sqrt(ratio), b = 1 / a;
  for (let i = 0; i < re.length; i++) {
    if (start + i < out.length) out[start + i] += 0.38 * a * re[i];
    if (start + re.length + i < out.length) out[start + re.length + i] += 0.38 * b * re[i];
  }
}

const DRONE_PITCHES = [[297, 400, 471], [316, 414, 418], [262, 363, 418], [320, 363, 418]];

export function writeDrone(out, sr, dataEnd) {
  const r = random(11);
  const phase = new Float64Array(8);
  const osc = (k, f) => {
    phase[k] += 2 * Math.PI * f / sr;
    return Math.sin(phase[k]);
  };
  let lp = 0, lp2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = DRONE_PITCHES[t < 2.6 ? 0 : t < 3.7 ? 1 : t < 6.3 ? 2 : 3];
    const pulse = 0.75 - 0.25 * Math.cos(2 * Math.PI * t / 0.14);
    const a = 1 - Math.exp(-2 * Math.PI * 46 / sr);
    lp += a * (r() * 2 - 1 - lp);
    lp2 += a * (lp - lp2);
    const rumble = (0.8 * osc(0, 60) + 0.7 * osc(1, 95) + 0.35 * osc(2, 185) + 5 * lp2) * (0.85 + 0.15 * Math.sin(2 * Math.PI * 7 * t));
    const tones = osc(3, f[0]) + 0.3 * osc(4, f[1]) + 0.45 * osc(5, f[2]) + 0.1 * osc(6, 766) + 0.08 * osc(7, 1027);
    const swell = t < 4.1 ? 0.16 + 0.84 * t / 4.1 : Math.max(0.16, 1 - 0.3 * (t - 4.1));
    const edge = Math.max(0, Math.min(1, t / 0.15, (out.length - i) / (0.35 * sr)));
    const underBuzz = t > 5.75 ? 0.28 : 1;
    out[i] += edge * swell * underBuzz * (0.12 * rumble + 0.10 * pulse * tones);
    if (i > dataEnd) out[i] *= Math.max(0, 1 - (i - dataEnd) / (0.35 * sr));
  }
}

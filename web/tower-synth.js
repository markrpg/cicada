// Procedural tower drone and resonant tymbal buzz. No recorded audio is embedded.
export const DIBIT_SECONDS = 0.035;
export const BUZZ_FREQUENCIES = [2800, 2800, 2800, 2800];
export const SYNC_WORD = [0, 3, 1, 0, 2, 2, 3, 0, 1, 3, 3, 2, 0, 2, 1, 1];

function random(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Four orthogonal phase patterns share one carrier and the same insect-like
// pulse envelope. Data changes the texture, never jumps between musical pitches.
const codes = [[1, 1, 1, 1], [1, -1, 1, -1], [1, 1, -1, -1], [1, -1, -1, 1]];
const pn = [1, -1, 1, 1, -1, -1, 1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, -1, -1, 1, -1, 1, 1, 1, -1, 1, -1, -1];
const templates = new Map();

export function buzzTemplate(state, sr) {
  const key = `${state}:${sr}`;
  if (templates.has(key)) return templates.get(key);
  const n = Math.round(DIBIT_SECONDS * sr);
  const re = new Float32Array(n), im = new Float32Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, chipTime = i / n * 28, chip = Math.min(27, Math.floor(chipTime)), f = chipTime - chip;
    const edge = Math.min(1, i / (0.001 * sr), (n - 1 - i) / (0.001 * sr));
    const tymbal = (0.35 + 0.65 * Math.exp(-2.5 * f)) * Math.min(1, f / 0.07, (1 - f) / 0.07);
    const env = edge * tymbal * pn[chip] * codes[state][chip % 4];
    re[i] = env * Math.cos(2 * Math.PI * 2800 * t);
    im[i] = env * Math.sin(2 * Math.PI * 2800 * t);
    norm += re[i] * re[i];
  }
  const result = { re, im, norm };
  templates.set(key, result);
  return result;
}

export function writeBuzz(out, start, state, sr, seed = 1) {
  const { re } = buzzTemplate(state, sr);
  const r = random(seed);
  for (let i = 0; i < re.length && start + i < out.length; i++) {
    out[start + i] += 0.6 * re[i] + 0.005 * (r() * 2 - 1);
  }
}

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
    const f = t < 2.6 ? [297, 400, 471] : t < 3.7 ? [316, 414, 418] : t < 6.3 ? [262, 363, 418] : [320, 363, 418];
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

// Procedural tower drone and resonant tymbal buzz. No recorded audio is embedded.
export const DIBIT_SECONDS = 0.035;
export const BUZZ_FREQUENCIES = [2500, 2750, 3000, 3250];
export const SYNC_WORD = [0, 3, 1, 0, 2, 2, 3, 0, 1, 3, 3, 2, 0, 2, 1, 1];

function random(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Each narrow resonant state carries two bits. Rapid amplitude modulation gives it
// a tymbal texture; smooth edges leave a measurable envelope for clock tracking.
export function writeBuzz(out, start, state, sr, seed = 1) {
  const n = Math.round(DIBIT_SECONDS * sr);
  const f = BUZZ_FREQUENCIES[state];
  const r = random(seed);
  const phase = 0.7 * state;
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / sr, x = i / n;
    const edge = Math.min(1, i / (0.003 * sr), (n - 1 - i) / (0.003 * sr));
    const grain = 0.72 + 0.28 * Math.sin(Math.PI * x);
    const tymbal = 0.72 + 0.28 * Math.cos(2 * Math.PI * 735 * t + phase);
    const ring = Math.sin(2 * Math.PI * f * t + phase);
    out[start + i] += 0.48 * edge * grain * tymbal * ring + 0.012 * edge * (r() * 2 - 1);
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

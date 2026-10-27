import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesize, Receiver, frameTiming } from '../web/modem.js';

const enc = new TextEncoder();

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function gauss(r) {
  let u = 0;
  while (!u) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function resample(x, ratio) {
  const y = new Float32Array(Math.floor(x.length * ratio));
  for (let i = 0; i < y.length; i++) {
    const t = i / ratio, j = Math.floor(t), f = t - j;
    y[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? 0) * f;
  }
  return y;
}

// Speaker-to-mic stand-in: rate change with clock drift, quiet, one echo, white noise.
function air(clean, { from, to, drift = 1, gain = 0.08, snrDb = 10, echoMs = 7, echoGain = 0.35, lead = 0.4, seed = 1 }) {
  const x = resample(clean, (to / from) * drift);
  const d = Math.round((echoMs / 1000) * to), pad = Math.round(lead * to);
  const y = new Float32Array(pad + x.length + d + to / 2);
  let ps = 0, n = 0;
  for (let i = 0; i < x.length; i++) {
    y[pad + i] += gain * x[i];
    y[pad + i + d] += gain * echoGain * x[i];
    if (x[i]) { ps += (gain * x[i]) ** 2; n++; }
  }
  const sigma = Math.sqrt(ps / n / 10 ** (snrDb / 10));
  const r = rng(seed);
  for (let i = 0; i < y.length; i++) y[i] += sigma * gauss(r);
  return y;
}

function listen(samples, sr) {
  const got = { starts: 0, messages: [], progress: 0 };
  const rx = new Receiver(sr, {
    start: () => got.starts++,
    progress: () => got.progress++,
    message: (m) => got.messages.push(m),
  });
  for (let i = 0; i < samples.length; i += 1024) rx.push(samples.subarray(i, i + 1024));
  return got;
}

const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
};

test('clean loopback at one rate', () => {
  const msg = enc.encode('Hello from the Mac 🦗');
  const got = listen(concat(new Float32Array(3000), synthesize(msg, 48000, 0), new Float32Array(48000)), 48000);
  assert.equal(got.messages.length, 1);
  assert.equal(got.messages[0].ok, true);
  assert.deepEqual(got.messages[0].payload, msg);
  assert.equal(got.messages[0].kind, 0);
});

test('44.1 kHz Mac to 48 kHz phone with drift, echo and noise', () => {
  const msg = enc.encode('Copy this onto the phone: https://example.com/a/b?c=d');
  const got = listen(air(synthesize(msg, 44100, 3), { from: 44100, to: 48000, drift: 1.00008, snrDb: 3 }), 48000);
  assert.equal(got.messages.length, 1);
  assert.equal(got.messages[0].ok, true);
  assert.deepEqual(got.messages[0].payload, msg);
  assert.equal(got.messages[0].kind, 3);
});

test('two frames back to back', () => {
  const a = enc.encode('first'), b = enc.encode('second message');
  const clean = concat(synthesize(a, 48000), new Float32Array(9600), synthesize(b, 48000));
  const got = listen(air(clean, { from: 48000, to: 48000, seed: 7 }), 48000);
  assert.deepEqual(got.messages.map((m) => new TextDecoder().decode(m.payload)), ['first', 'second message']);
  assert.ok(got.messages.every((m) => m.ok));
});

test('a 1 KB file survives a burst of noise', () => {
  const r = rng(42);
  const file = Uint8Array.from({ length: 1000 }, () => (r() * 256) | 0);
  const sr = 48000;
  const y = air(synthesize(file, sr, 2), { from: sr, to: sr, seed: 3 });
  const burstAt = Math.round((0.4 + frameTiming(1000, sr).dataStart + 20) * sr);
  for (let i = 0; i < sr * 0.3; i++) y[burstAt + i] += (r() - 0.5) * 0.6; // 300 ms clap
  const got = listen(y, sr);
  assert.equal(got.messages.length, 1);
  assert.equal(got.messages[0].ok, true);
  assert.ok(got.messages[0].fixed > 0);
  assert.deepEqual(got.messages[0].payload, file);
});

test('noise alone produces nothing', () => {
  const r = rng(9);
  const noise = Float32Array.from({ length: 48000 * 20 }, () => 0.05 * gauss(r));
  const got = listen(noise, 48000);
  assert.equal(got.starts, 0);
  assert.equal(got.messages.length, 0);
});

test('timing matches the synthesized length', () => {
  const pcm = synthesize(new Uint8Array(50), 44100);
  assert.ok(Math.abs(frameTiming(50, 44100).total - pcm.length / 44100) < 1e-9);
});

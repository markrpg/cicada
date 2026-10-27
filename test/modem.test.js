import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, synthesize, Receiver, frameTiming, decodeSymbol, preamble } from '../web/modem.js';
import { writeBuzz, DIBIT_SECONDS } from '../web/tower-synth.js';

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
  for (let i = 0; i < sr * 0.3; i++) y[burstAt + i] += (r() - 0.5) * 3; // 300 ms clap that forces symbol errors
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

test('every possible byte survives the resonant buzz detector at both rates', () => {
  for (const sr of [44100, 48000]) {
    for (let byte = 0; byte < 256; byte++) {
      const out = new Float32Array(Math.ceil(CONFIG.symbolDur * sr) + 8);
      for (let d = 0; d < 4; d++) writeBuzz(out, Math.round(d * DIBIT_SECONDS * sr), (byte >> (6 - 2 * d)) & 3, sr, byte + d);
      assert.equal(decodeSymbol(out, 0, sr).byte, byte);
    }
  }
});

test('long binary transfer tracks positive and negative clock drift', () => {
  const r = rng(327);
  const bytes = Uint8Array.from({ length: 1000 }, () => r() * 256 | 0);
  for (const drift of [1.00008, 0.99992]) {
    const got = listen(air(synthesize(bytes, 48000, 2), { from: 48000, to: 44100, drift, snrDb: 3, seed: 18 }), 44100);
    assert.equal(got.messages.length, 1);
    assert.ok(got.messages[0].ok, `drift ${drift}`);
    assert.deepEqual(got.messages[0].payload, bytes);
  }
});

test('16-bit WAV quantization preserves the actual encoded message', () => {
  const bytes = enc.encode('A message in the tower buzz 🦗');
  const sr = 44100;
  const pcm = synthesize(bytes, sr);
  const quantized = pcm.map((v) => Math.round(v * 32767) / 32768);
  const got = listen(concat(quantized, new Float32Array(sr)), sr);
  assert.equal(got.messages.length, 1);
  assert.equal(got.messages[0].ok, true);
  assert.deepEqual(got.messages[0].payload, bytes);
});

test('levels, duration, rates and allocation limits are bounded', () => {
  const sr = 48000;
  const pcm = synthesize(new Uint8Array(CONFIG.maxPayload), sr);
  let peak = 0;
  for (const x of pcm) { assert.ok(Number.isFinite(x)); peak = Math.max(peak, Math.abs(x)); }
  assert.ok(peak < 1, `peak ${peak}`);
  const t = frameTiming(CONFIG.maxPayload, sr);
  assert.ok(t.total <= CONFIG.maxFrameSeconds);
  assert.ok(Math.abs(t.symbols - (t.dataEnd - t.dataStart) / CONFIG.symbolDur) < 1e-8);
  assert.throws(() => synthesize(new Uint8Array(CONFIG.maxPayload + 1), sr), RangeError);
  for (const bad of [NaN, Infinity, 0, 7999, 192000]) assert.throws(() => frameTiming(1, bad), RangeError);
});

test('a damaged acquisition burst is ignored and a later valid frame is found', () => {
  const sr = 48000, bytes = enc.encode('recovered');
  const bad = synthesize(enc.encode('broken'), sr);
  const timing = frameTiming(6, sr);
  bad.fill(0, Math.round(timing.introEnd * sr), Math.round(timing.introEnd * sr) + preamble(sr).length);
  const got = listen(concat(bad, synthesize(bytes, sr), new Float32Array(sr)), sr);
  assert.equal(got.messages.length, 1);
  assert.deepEqual(got.messages[0].payload, bytes);
  assert.ok(got.messages[0].ok);
});

test('uncorrectable payload damage is reported, not delivered as good data', () => {
  const sr = 48000, bytes = enc.encode('unrecoverable corruption must be detected');
  const pcm = synthesize(bytes, sr);
  const timing = frameTiming(bytes.length, sr);
  const r = rng(79);
  const a = Math.round((timing.dataStart + 10 * CONFIG.symbolDur) * sr);
  const b = Math.round((timing.dataStart + 25 * CONFIG.symbolDur) * sr);
  for (let i = a; i < b; i++) pcm[i] = (r() - 0.5) * 0.9;
  const got = listen(concat(pcm, new Float32Array(sr)), sr);
  assert.equal(got.messages.length, 1);
  assert.equal(got.messages[0].ok, false);
});

test('a truncated long frame times out and the next transmission is acquired', () => {
  const sr = 48000;
  const long = synthesize(new Uint8Array(1000), sr);
  const cut = Math.round((frameTiming(1000, sr).dataStart + 3) * sr);
  const bytes = enc.encode('after interruption');
  const got = listen(concat(long.subarray(0, cut), new Float32Array(sr * 2), synthesize(bytes, sr), new Float32Array(sr)), sr);
  assert.equal(got.messages.filter((m) => m.ok).length, 1);
  assert.deepEqual(got.messages.find((m) => m.ok).payload, bytes);
});

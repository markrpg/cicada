import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONFIG, THEMES, synthesize, frameTiming, Receiver } from '../web/modem.js';

const encode = (s) => new TextEncoder().encode(s);
function decode(pcm, sr) {
  const got = [];
  const receiver = new Receiver(sr, { message: (m) => got.push(m) });
  const padded = new Float32Array(pcm.length + sr * 3);
  padded.set(pcm, sr / 2);
  for (let i = 0; i < padded.length; i += 997) receiver.push(padded.subarray(i, i + 997));
  return got;
}
function channel(pcm, from, to, drift = 1) {
  const out = new Float32Array(Math.ceil(pcm.length * to / from * drift) + to);
  let seed = 314;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const delay = Math.round(to * 0.007);
  for (let i = 0; i < out.length - delay; i++) {
    const t = i * from / to / drift, j = Math.floor(t), f = t - j;
    const v = ((pcm[j] || 0) * (1 - f) + (pcm[j + 1] || 0) * f) * 0.1;
    out[i] += v; out[i + delay] += v * 0.35;
  }
  for (let i = 0; i < out.length; i++) out[i] += (random() - 0.5) * 0.02;
  return out;
}

test('Cicada remains the bit-identical default signal', () => {
  const bytes = encode('Hello from Cicada');
  const actual = synthesize(bytes, 48000);
  assert.deepEqual(actual, synthesize(bytes, 48000, 0, 'cicada'));
  const wav = readFileSync(new URL('../samples/delights.wav', import.meta.url));
  assert.equal(wav.length, actual.length * 2 + 44);
  for (let i = 0; i < actual.length; i++) assert.equal(Math.round(actual[i] * 32767) || 0, wav.readInt16LE(44 + i * 2));
});

test('both themes auto-detect and decode quantized Unicode text', () => {
  for (const { id } of THEMES) for (const sr of [44100, 48000]) {
    const bytes = encode('Hello from the terminal 🛸');
    const pcm = synthesize(bytes, sr, 0, id).map((v) => Math.round(v * 32767) / 32768);
    const got = decode(pcm, sr);
    assert.equal(got.length, 1, `${id}/${sr}: duplicate or missed frame`);
    assert.ok(got[0].ok, `${id}/${sr}`);
    assert.equal(got[0].theme, id);
    assert.deepEqual(got[0].payload, bytes);
  }
});

test('Alien handles both rate directions, noise, echo and clock drift', () => {
  const bytes = Uint8Array.from({ length: CONFIG.maxPayload }, (_, i) => (i * 73 + 17) & 255);
  for (const [from, to, drift] of [[44100, 48000, 1.00008], [48000, 44100, 0.99992]]) {
    const pcm = channel(synthesize(bytes, from, 2, 'alien'), from, to, drift);
    const got = decode(pcm, to);
    assert.equal(got.length, 1);
    assert.ok(got[0].ok, `rate ${from}/${to}, drift ${drift}`);
    assert.equal(got[0].theme, 'alien');
    assert.deepEqual(got[0].payload, bytes);
  }
});

test('mixed themes decode consecutively without choosing a receiving theme', () => {
  const a = synthesize(encode('Cicada first'), 48000);
  const b = synthesize(encode('Alien second'), 48000, 0, 'alien');
  const both = new Float32Array(a.length + b.length + 9600);
  both.set(a); both.set(b, a.length + 9600);
  const got = decode(both, 48000);
  assert.deepEqual(got.map((m) => [m.theme, m.ok]), [['cicada', true], ['alien', true]]);
});

test('each theme reports exact timing and rejects unknown themes', () => {
  for (const { id } of THEMES) {
    const timing = frameTiming(20, 48000, id);
    const pcm = synthesize(new Uint8Array(20), 48000, 0, id);
    assert.equal(timing.total, pcm.length / 48000);
    assert.equal(timing.theme, id);
    for (const value of pcm) assert.ok(Number.isFinite(value) && Math.abs(value) < 1);
  }
  assert.throws(() => synthesize(new Uint8Array(1), 48000, 0, 'unknown'), RangeError);
  assert.throws(() => frameTiming(1, 48000, 'unknown'), RangeError);
});

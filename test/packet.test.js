import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packText, packFile, unpack, previewText } from '../web/packet.js';

test('text round trip, short and compressible', async () => {
  for (const s of ['hi 🦗', 'la '.repeat(200)]) {
    const p = await packText(s);
    assert.deepEqual(await unpack(p.kind, p.bytes), { type: 'text', text: s });
  }
  assert.equal((await packText('la '.repeat(200))).kind & 1, 1);
});

test('file round trip keeps name, type and bytes', async () => {
  const data = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 255);
  const p = await packFile(new File([data], 'notes.bin', { type: 'application/x-test' }));
  const u = await unpack(p.kind, p.bytes);
  assert.equal(u.name, 'notes.bin');
  assert.equal(u.mime, 'application/x-test');
  assert.deepEqual(new Uint8Array(await u.blob.arrayBuffer()), data);
});

test('preview of uncompressed text drops a half-received character', () => {
  const b = new TextEncoder().encode('ok 🦗');
  assert.equal(previewText(0, b.subarray(0, b.length - 1)), 'ok ');
});

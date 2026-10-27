// Text and files on top of the modem's raw frames.
// kind: bit 0 = deflate-compressed, bit 1 = file. A file body is
// [name length][name][mime length][mime][bytes].

import { CONFIG } from './modem.js';

const COMPRESSED = 1, FILE = 2;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// Short text stays uncompressed so the receiver can show it streaming in.
async function shrink(kind, bytes) {
  const worthTrying = kind & FILE ? bytes.length > 24 : bytes.length > 120;
  if (worthTrying && typeof CompressionStream !== 'undefined') {
    const packed = await pipe(bytes, new CompressionStream('deflate-raw'));
    if (packed.length < bytes.length * (kind & FILE ? 1 : 0.75)) return check({ kind: kind | COMPRESSED, bytes: packed });
  }
  return check({ kind, bytes });
}

function check(p) {
  if (p.bytes.length > CONFIG.maxPayload) throw new RangeError(`Too large to chirp: ${p.bytes.length} bytes (max ${CONFIG.maxPayload})`);
  return p;
}

function field(s) {
  const b = enc.encode(s).subarray(0, 255);
  return [Uint8Array.of(b.length), b];
}

export function packText(text) {
  return shrink(0, enc.encode(text));
}

export async function packFile(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const parts = [...field(file.name || 'file'), ...field(file.type || ''), data];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (body.set(p, o), o + p.length), 0);
  return shrink(FILE, body);
}

export async function unpack(kind, bytes) {
  const body = kind & COMPRESSED ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
  if (!(kind & FILE)) return { type: 'text', text: dec.decode(body) };
  let o = 0;
  const read = () => {
    const n = body[o];
    const s = dec.decode(body.subarray(o + 1, o + 1 + n));
    o += 1 + n;
    return s;
  };
  const name = read(), mime = read();
  return { type: 'file', name, mime, blob: new Blob([body.subarray(o)], { type: mime || 'application/octet-stream' }) };
}

// Live text while bytes arrive. Compressed bytes can't be shown until the end.
export function previewText(kind, bytes) {
  if (kind & COMPRESSED) return '';
  if (kind & FILE) {
    const n = bytes[0];
    return bytes.length > n ? dec.decode(bytes.subarray(1, 1 + n)) : '';
  }
  return dec.decode(bytes).replace(/�+$/, '');
}

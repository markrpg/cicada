// node tools/render-wav.js "some text" out.wav [sampleRate]
import { writeFileSync } from 'node:fs';
import { synthesize } from '../web/modem.js';
import { packText } from '../web/packet.js';

const [text = 'Hello from Cicada', out = 'cicada.wav', rate = '48000'] = process.argv.slice(2);
const sr = Number(rate);
const { kind, bytes } = await packText(text);
const pcm = synthesize(bytes, sr, kind);
const wav = Buffer.alloc(44 + pcm.length * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length * 2, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(pcm.length * 2, 40);
pcm.forEach((v, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
writeFileSync(out, wav);
console.log(`${out}: ${bytes.length} bytes, ${(pcm.length / sr).toFixed(2)} s`);

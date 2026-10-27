// Reed–Solomon over GF(2^8), primitive polynomial 0x11d, first consecutive root 0.
// Polynomials are arrays with the highest-degree coefficient first.
// encode() appends nsym parity bytes; decode() fixes up to nsym/2 byte errors.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);
const inv = (a) => EXP[255 - LOG[a]];
const pow2 = (n) => EXP[((n % 255) + 255) % 255];

function scale(p, x) {
  return p.map((c) => mul(c, x));
}

function add(p, q) {
  const n = Math.max(p.length, q.length);
  const r = new Array(n).fill(0);
  for (let i = 0; i < p.length; i++) r[i + n - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + n - q.length] ^= q[i];
  return r;
}

function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++)
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  return r;
}

function evaluate(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

const generators = new Map();
function generator(nsym) {
  let g = generators.get(nsym);
  if (!g) {
    g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow2(i)]);
    generators.set(nsym, g);
  }
  return g;
}

export function encode(msg, nsym) {
  if (msg.length + nsym > 255) throw new RangeError('Reed–Solomon codeword longer than 255');
  const g = generator(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const c = out[i];
    if (c) for (let j = 1; j < g.length; j++) out[i + j] ^= mul(g[j], c);
  }
  out.set(msg);
  return out;
}

// Leading zero keeps the Berlekamp–Massey indexing simple.
function syndromes(cw, nsym) {
  const s = [0];
  for (let i = 0; i < nsym; i++) s.push(evaluate(cw, pow2(i)));
  return s;
}

function errorLocator(synd, nsym) {
  let loc = [1], old = [1];
  for (let i = 0; i < nsym; i++) {
    const k = i + 1;
    let delta = synd[k];
    for (let j = 1; j < loc.length; j++) delta ^= mul(loc[loc.length - 1 - j], synd[k - j]);
    old = old.concat([0]);
    if (delta) {
      if (old.length > loc.length) {
        const next = scale(old, delta);
        old = scale(loc, inv(delta));
        loc = next;
      }
      loc = add(loc, scale(old, delta));
    }
  }
  while (loc.length && loc[0] === 0) loc.shift();
  if ((loc.length - 1) * 2 > nsym) throw new Error('too many errors');
  return loc;
}

function errorPositions(locReversed, n) {
  const pos = [];
  for (let i = 0; i < n; i++) if (evaluate(locReversed, pow2(i)) === 0) pos.push(n - 1 - i);
  if (pos.length !== locReversed.length - 1) throw new Error('could not locate errors');
  return pos;
}

function correct(cw, synd, pos) {
  const coefPos = pos.map((p) => cw.length - 1 - p);
  let loc = [1];
  for (const c of coefPos) loc = polyMul(loc, add([1], [pow2(c), 0]));
  const product = polyMul([...synd].reverse(), loc);
  const evaluator = product.slice(product.length - loc.length).reverse();
  const X = coefPos.map((c) => pow2(-(255 - c)));
  const out = Uint8Array.from(cw);
  X.forEach((xi, i) => {
    const xiInv = inv(xi);
    let prime = 1;
    X.forEach((xj, j) => {
      if (j !== i) prime = mul(prime, 1 ^ mul(xiInv, xj));
    });
    const y = mul(xi, evaluate([...evaluator].reverse(), xiInv));
    if (prime === 0) throw new Error('could not compute error magnitude');
    out[pos[i]] ^= div(y, prime);
  });
  return out;
}

// Returns the corrected data bytes (parity stripped) and how many bytes were fixed.
export function decode(codeword, nsym) {
  const k = codeword.length - nsym;
  const synd = syndromes(codeword, nsym);
  if (synd.every((s) => s === 0)) return { data: codeword.slice(0, k), fixed: 0 };
  const loc = errorLocator(synd, nsym);
  const pos = errorPositions([...loc].reverse(), codeword.length);
  const fixedCw = correct(codeword, synd, pos);
  if (syndromes(fixedCw, nsym).some((s) => s !== 0)) throw new Error('correction failed');
  return { data: fixedCw.slice(0, k), fixed: pos.length };
}

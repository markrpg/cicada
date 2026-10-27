// Transfer cards: live progress, decoding text, final text/file states.

import { SegBar } from './ui-bar.js';

export const ICON = {
  in: '<svg viewBox="0 0 24 24"><path d="M17 7L7 17M7 9v8h8"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
  resend: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.7M20 4v4.7h-4.7M20 12a8 8 0 0 1-13.7 5.6L4 15.3M4 20v-4.7h4.7"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9L14 3.5z"/><path d="M14 3.5V9h5.5"/></svg>',
};

export function fmtBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}

const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const GLYPHS = '01<>/\\|=+*#%&$@?!░▒▓ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ';
const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
const SETTLE = 0.22; // seconds a new character scrambles before it locks

// Streams a string in: the freshest characters flicker through glyphs, then lock.
class Decoder {
  constructor(textEl) {
    this.el = textEl;
    this.settledEl = document.createElement('span');
    this.scrambleEl = document.createElement('span');
    this.scrambleEl.className = 'scramble';
    this.noiseEl = document.createElement('span');
    this.noiseEl.className = 'noise';
    textEl.append(this.settledEl, this.scrambleEl, this.noiseEl);
    this.target = '';
    this.times = [];
    this.shownSettled = '';
    this.last = 0;
    this.live = true;
  }

  setTarget(str) {
    if (str.length > 1400) str = '…' + str.slice(-1400);
    const now = performance.now() / 1000;
    const prev = this.target;
    const times = this.times;
    times.length = str.length;
    for (let i = 0; i < str.length; i++) if (prev[i] !== str[i] || times[i] === undefined) times[i] = now;
    this.target = str;
  }

  tick(nowMs) {
    if (nowMs - this.last < 33) return;
    this.last = nowMs;
    const now = nowMs / 1000;
    const { target, times } = this;
    let j = target.length;
    while (j > 0 && now - times[j - 1] < SETTLE) j--;
    const settled = target.slice(0, j);
    if (settled !== this.shownSettled) {
      this.settledEl.textContent = settled;
      this.shownSettled = settled;
    }
    let s = '';
    for (let i = j; i < target.length; i++) {
      const ch = target[i];
      s += ch === '\n' || ch === ' ' || now - times[i] > SETTLE * 0.7 ? ch : glyph();
    }
    this.scrambleEl.textContent = s;
    if (this.live) {
      let n = '';
      const len = 2 + ((Math.random() * 4) | 0);
      for (let i = 0; i < len; i++) n += glyph();
      this.noiseEl.textContent = n;
    }
  }

  lock(text) {
    this.live = false;
    this.target = text;
    this.settledEl.textContent = text;
    this.shownSettled = text;
    this.scrambleEl.textContent = '';
    this.noiseEl.textContent = '';
  }
}

const hex = (bytes, n = 72) => Array.from(bytes.subarray(0, n), (b) => b.toString(16).padStart(2, '0')).join(' ');

export class Card {
  constructor(dir, opts = {}) {
    this.dir = dir;
    const el = document.createElement('article');
    el.className = `card ${dir} live`;
    el.innerHTML = `
      <div class="meta">
        <span class="dir">${ICON[dir]}</span>
        <span class="what"></span>
        <span class="size"></span>
        <span class="tag" hidden>Echo</span>
        <span class="state"></span>
      </div>
      <div class="body"><p class="text"></p></div>
      <div class="prog">
        <div class="barwrap"><canvas class="bar"></canvas></div>
        <div class="nums"><span class="pct"><span class="pv">0</span><small>%</small></span><span class="stat"></span></div>
      </div>
      <div class="actions"></div>`;
    this.el = el;
    const q = (s) => el.querySelector(s);
    this.whatEl = q('.what');
    this.sizeEl = q('.size');
    this.tagEl = q('.tag');
    this.stateEl = q('.state');
    this.bodyEl = q('.body');
    this.textEl = q('.text');
    this.pctNode = q('.pv').firstChild;
    this.statEl = q('.stat');
    this.actionsEl = q('.actions');
    this.bar = new SegBar(q('.bar'), dir === 'in' ? 'rx' : 'tx');
    this.decoder = new Decoder(this.textEl);
    this.pct = 0;
    this.statStr = '';
    this.done = false;
    this.urls = [];
    this.time = clock();
    this.stateEl.textContent = this.time;
    this.setWhat(opts.what || (dir === 'in' ? 'Incoming' : 'Sending'));
    if (opts.bytes != null) this.sizeEl.textContent = fmtBytes(opts.bytes);
    if (opts.echo) this.setEcho();
  }

  setWhat(s) {
    this.whatEl.textContent = s;
    this.whatEl.title = s;
  }

  setEcho() {
    this.el.classList.add('echo');
    this.tagEl.hidden = false;
  }

  // frac 0..1, plus the stat line (bytes · time left).
  progress(units, total, stat) {
    this.bar.setTotal(total);
    this.bar.set(units);
    const pct = Math.floor((units / total) * 100);
    if (pct !== this.pct) {
      this.pct = pct;
      this.pctNode.data = String(pct);
    }
    if (stat !== this.statStr) {
      this.statStr = stat;
      this.statEl.textContent = stat;
    }
  }

  preview(text, bytes) {
    if (text) {
      this.textEl.classList.remove('hex');
      this.decoder.setTarget(text);
    } else if (bytes && bytes.length) {
      this.textEl.classList.add('hex');
      this.decoder.setTarget(hex(bytes));
    }
  }

  tick(now) {
    if (!this.done || !this.bar.settled) this.bar.draw(now);
    if (this.decoder.live) this.decoder.tick(now);
    if (this.done && this.bar.settled && !this.el.classList.contains('settled')) {
      this.el.classList.add('settled');
      return false;
    }
    return true;
  }

  finish(ok, label) {
    this.done = true;
    this.bar.finish(ok);
    this.el.classList.remove('live');
    this.pctNode.data = ok ? '100' : String(this.pct);
    this.stateEl.className = `state ${ok ? 'ok' : 'bad'}`;
    this.stateEl.innerHTML = `<span>${label || this.time}</span>${ok ? ICON.check : ICON.x}`;
    if (!ok) this.el.classList.add('bad-state');
  }

  showText(text) {
    this.textEl.classList.remove('hex');
    this.decoder.lock(text);
  }

  showFile({ name, mime, blob, size }) {
    this.decoder.lock('');
    this.textEl.remove();
    const row = document.createElement('div');
    row.className = 'file';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (mime && mime.startsWith('image/') && blob) {
      const url = URL.createObjectURL(blob);
      this.urls.push(url);
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.onload = () => img.naturalWidth < 96 && img.classList.add('tiny');
      img.src = url;
      thumb.append(img);
      this.el.classList.add('has-image');
    } else {
      thumb.innerHTML = ICON.file;
    }
    const info = document.createElement('div');
    info.className = 'file-info';
    const n = document.createElement('span');
    n.className = 'file-name';
    n.textContent = name;
    n.title = name;
    const m = document.createElement('span');
    m.className = 'file-meta';
    m.textContent = [mime || 'file', fmtBytes(size ?? blob?.size ?? 0)].join(' · ');
    info.append(n, m);
    row.append(thumb, info);
    this.bodyEl.append(row);
    this.setWhat(name);
  }

  action(label, icon, onClick, primary = false) {
    const b = document.createElement('button');
    b.className = `btn${primary ? ' primary' : ''}`;
    b.innerHTML = `${ICON[icon]}<span></span>`;
    b.lastChild.textContent = label;
    b.addEventListener('click', () => onClick(b));
    this.actionsEl.append(b);
    return b;
  }

  // Flash a button's label for a moment.
  static flash(btn, label, ms = 1600) {
    const span = btn.lastChild;
    const prev = span.textContent;
    span.textContent = label;
    btn.classList.add('done');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      span.textContent = prev;
      btn.classList.remove('done');
    }, ms);
  }

  destroy() {
    this.bar.destroy();
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.el.remove();
  }
}

export class Feed {
  constructor(root, empty) {
    this.root = root;
    this.empty = empty;
    this.cards = [];
    this.active = new Set();
  }

  add(card) {
    if (this.empty) {
      this.empty.remove();
      this.empty = null;
    }
    this.root.append(card.el);
    this.cards.push(card);
    this.active.add(card);
    while (this.cards.length > 40) this.cards.shift().destroy();
    this.scrollEnd();
    return card;
  }

  nearBottom() {
    const r = this.root;
    return r.scrollHeight - r.scrollTop - r.clientHeight < 80;
  }

  scrollEnd() {
    requestAnimationFrame(() => (this.root.scrollTop = this.root.scrollHeight));
  }

  tick(now) {
    for (const c of this.active) if (!c.tick(now)) this.active.delete(c);
  }
}

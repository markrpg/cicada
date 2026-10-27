import { CONFIG, synthesize, frameTiming, Receiver } from './modem.js';
import { packText, packFile, unpack, previewText } from './packet.js';
import { readClipboard, writeClipboard, saveBlob } from './platform.js';
import { Spectrogram } from './ui-spectro.js';
import { FX } from './ui-fx.js';
import { Card, Feed, fmtBytes, fmtTime, ICON } from './ui-feed.js';

const $ = (id) => document.getElementById(id);
const ui = {
  text: $('text'),
  send: $('send'),
  sendLabel: document.querySelector('.send-label'),
  listen: $('listen'),
  listenLabel: document.querySelector('.listen-label'),
  paste: $('paste'),
  file: $('file'),
  autosend: $('autosend'),
  staged: $('staged'),
  stagedThumb: $('staged-thumb'),
  stagedName: $('staged-name'),
  stagedMeta: $('staged-meta'),
  stagedX: $('staged-x'),
  toast: $('toast'),
  toastMsg: $('toast-msg'),
  toastX: $('toast-x'),
  drop: $('drop'),
  top: document.querySelector('.top'),
};

const spectro = new Spectrogram($('spectro'), $('bloom'));
const fx = new FX($('fx'));
const feed = new Feed($('feed'), $('empty'));
const SYM = CONFIG.symbolDur || 0.08;

// ---------------------------------------------------------------- audio

const A = {
  ctx: null,
  rxAn: null,
  txAn: null,
  sink: null,
  worklet: null, // promise for addModule, made once
  stream: null,
  micSrc: null,
  node: null,
  receiver: null,
  listening: false,
  wake: null,
};

function ensureCtx() {
  if (!A.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    A.ctx = new Ctx({ latencyHint: 'interactive' });
    const analyser = () => {
      const a = A.ctx.createAnalyser();
      a.fftSize = 1024;
      a.smoothingTimeConstant = 0;
      a.minDecibels = -100;
      a.maxDecibels = -28;
      return a;
    };
    A.rxAn = analyser();
    A.txAn = analyser();
    A.sink = A.ctx.createGain();
    A.sink.gain.value = 0;
    A.sink.connect(A.ctx.destination);
  }
  if (A.ctx.state !== 'running') A.ctx.resume().catch(() => {});
  return A.ctx;
}

const sampleRate = () => (A.ctx ? A.ctx.sampleRate : 48000);
const symbolsOf = (t) => Math.max(1, Math.round((t.dataEnd - t.dataStart) / SYM));

function micError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone permission was denied. Allow it for this site, then tap Listen.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found.';
    case 'NotReadableError':
      return 'Another app is using the microphone.';
    default:
      return `Microphone failed to start: ${err && err.message ? err.message : err}`;
  }
}

async function startListening() {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast(`The microphone only works over HTTPS or on localhost. This page is on ${location.origin}, so it can send but not listen.`, 0);
    return;
  }
  const ctx = ensureCtx();
  setListenUI('busy');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (err) {
    setListenUI('off');
    toast(micError(err));
    return;
  }
  try {
    if (!A.worklet) A.worklet = ctx.audioWorklet.addModule('capture-worklet.js');
    await A.worklet;
  } catch (err) {
    A.worklet = null;
    stream.getTracks().forEach((t) => t.stop());
    setListenUI('off');
    toast(`Audio capture failed to load: ${err.message || err}`);
    return;
  }
  await ctx.resume().catch(() => {});
  A.stream = stream;
  A.receiver = new Receiver(ctx.sampleRate, rxHandlers);
  A.micSrc = ctx.createMediaStreamSource(stream);
  A.node = new AudioWorkletNode(ctx, 'capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  const receiver = A.receiver;
  A.node.port.onmessage = (e) => receiver.push(e.data);
  A.micSrc.connect(A.node);
  A.node.connect(A.sink);
  A.micSrc.connect(A.rxAn);
  A.listening = true;
  stream.getAudioTracks()[0]?.addEventListener('ended', stopListening);
  setListenUI('on');
  wakeLock(true);
}

function stopListening() {
  if (!A.listening) return;
  A.listening = false;
  A.node.port.onmessage = null;
  A.micSrc.disconnect();
  A.node.disconnect();
  A.stream.getTracks().forEach((t) => t.stop());
  A.stream = A.micSrc = A.node = A.receiver = null;
  if (rx) {
    rx.card.finish(false, 'Stopped');
    rx = null;
  }
  setListenUI('off');
  wakeLock(false);
}

function setListenUI(state) {
  ui.listen.setAttribute('aria-pressed', String(state === 'on'));
  ui.listen.classList.toggle('busy', state === 'busy');
  ui.listenLabel.textContent = state === 'on' ? 'Listening' : 'Listen';
}

async function wakeLock(on) {
  try {
    if (on && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      A.wake = await navigator.wakeLock.request('screen');
    } else if (!on && A.wake) {
      await A.wake.release();
      A.wake = null;
    }
  } catch {
    /* not granted; the screen may sleep */
  }
}
document.addEventListener('visibilitychange', () => {
  if (A.listening && document.visibilityState === 'visible') wakeLock(true);
});

// ---------------------------------------------------------------- receive

let rx = null; // { card, kind, length, echo, last }

function peakOr(fallback) {
  const p = spectro.result;
  return p.active ? p.peak : fallback ?? 0.12 + Math.random() * 0.76;
}

const rxHandlers = {
  start({ kind, length }) {
    const now = A.ctx ? A.ctx.currentTime : 0;
    const echo = tx.windows.some((w) => now >= w.start && now <= w.end);
    if (rx) rx.card.finish(false, 'Lost');
    const card = feed.add(new Card('in', { bytes: length, echo }));
    rx = { card, kind, length, echo, last: performance.now() };
    card.progress(0, 1, `0 B / ${fmtBytes(length)}`);
    fx.bloom(peakOr(0.5), 'rx', echo);
  },

  progress({ received, total, preview }) {
    if (!rx) return;
    rx.last = performance.now();
    const bytes = Math.min(rx.length, Math.round((received / total) * rx.length));
    rx.card.progress(received, total, `${fmtBytes(bytes)} / ${fmtBytes(rx.length)} · ${fmtTime((total - received) * SYM)}`);
    let text = '';
    try {
      text = previewText(rx.kind, preview);
    } catch {
      /* partial bytes */
    }
    rx.card.preview(text, preview);
    fx.spark(peakOr(), 'rx', 6, 1, rx.echo);
  },

  message({ kind, payload, ok }) {
    const r = rx || { card: feed.add(new Card('in', { bytes: payload.length })), length: payload.length, echo: false };
    rx = null;
    settleIncoming(r, kind, payload, ok);
  },
};

async function settleIncoming(r, kind, payload, ok) {
  const { card, echo } = r;
  let item = null;
  try {
    item = await unpack(kind, payload);
  } catch {
    ok = false;
  }
  if (ok && item) {
    card.finish(true);
    if (item.type === 'text') {
      card.setWhat('Text');
      card.showText(item.text);
      card.action('Copy', 'copy', (b) => copyText(item.text, b), !echo);
    } else {
      card.showFile({ name: item.name || 'file', mime: item.mime, blob: item.blob, size: item.blob.size });
      card.action('Download', 'download', (b) => save(item.blob, item.name || 'file', b), !echo);
    }
    if (!echo) fx.bloom(0.5, 'ok');
  } else {
    card.finish(false, 'Too noisy');
    if (item && item.type === 'text') card.showText(item.text);
    else card.decoder.lock(card.decoder.target);
  }
  feed.scrollEnd();
}

async function copyText(text, btn) {
  try {
    await writeClipboard(text);
  } catch {
    const t = Object.assign(document.createElement('textarea'), { value: text });
    t.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(t);
    t.select();
    const done = document.execCommand && document.execCommand('copy');
    t.remove();
    if (!done) {
      toast('Copy was blocked by the browser.');
      return;
    }
  }
  Card.flash(btn, 'Copied');
}

async function save(blob, name, btn) {
  try {
    const where = await saveBlob(blob, name);
    Card.flash(btn, where ? `Saved to ${where}` : 'Saved', where ? 3200 : 1600);
  } catch (err) {
    toast(`Couldn't save ${name}: ${err.message || err}`);
  }
}

// ---------------------------------------------------------------- send

const tx = { cur: null, queue: [], windows: [] };

function enqueue(item) {
  const len = item.bytes.length;
  const card = new Card('out', { what: item.label, bytes: len });
  if (item.text != null) card.showText(item.text);
  else card.showFile(item.fileInfo);
  item.card = card;
  const t = frameTiming(len, sampleRate());
  card.progress(0, symbolsOf(t), `0 B / ${fmtBytes(len)} · ${fmtTime(t.total)}`);
  feed.add(card);
  tx.queue.push(item);
  pump();
  updateSendUI();
}

function pump() {
  if (tx.cur || !tx.queue.length) return;
  const item = tx.queue.shift();
  const ctx = ensureCtx();
  let pcm;
  try {
    pcm = synthesize(item.bytes, ctx.sampleRate, item.kind);
  } catch (err) {
    item.card.finish(false, 'Failed');
    toast(err.message || String(err));
    pump();
    return;
  }
  const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
  buf.getChannelData(0).set(pcm);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.connect(A.txAn);
  const t0 = ctx.currentTime + 0.06;
  const timing = frameTiming(item.bytes.length, ctx.sampleRate);
  const win = { start: t0, end: t0 + timing.total + 0.6 };
  tx.windows.push(win);
  const cur = { item, src, t0, timing, win, syms: symbolsOf(timing), lastSym: 0, bloomed: false, stopped: false };
  tx.cur = cur;
  src.onended = () => {
    src.disconnect();
    if (cur.stopped) win.end = ctx.currentTime + 0.6;
    cur.item.card.finish(!cur.stopped, cur.stopped ? 'Stopped' : '');
    if (!cur.stopped) addResend(cur.item);
    tx.cur = null;
    pump();
    updateSendUI();
  };
  src.start(t0);
}

function addResend(item) {
  item.card.action('Resend', 'resend', () =>
    enqueue({ kind: item.kind, bytes: item.bytes, label: item.label, text: item.text, fileInfo: item.fileInfo }),
  );
}

function stopSending() {
  for (const q of tx.queue) q.card.finish(false, 'Cancelled');
  tx.queue.length = 0;
  if (tx.cur) {
    tx.cur.stopped = true;
    try {
      tx.cur.src.stop();
    } catch {
      /* already ended */
    }
  }
  updateSendUI();
}

function txFrame() {
  const c = tx.cur;
  if (!c) return;
  const t = A.ctx.currentTime - c.t0;
  const { dataStart, dataEnd, total } = c.timing;
  if (!c.bloomed && t >= 0.04) {
    c.bloomed = true;
    fx.bloom(0.5, 'tx');
  }
  const frac = Math.min(1, Math.max(0, (t - dataStart) / (dataEnd - dataStart)));
  const units = frac * c.syms;
  const len = c.item.bytes.length;
  c.item.card.progress(units, c.syms, `${fmtBytes(Math.round(frac * len))} / ${fmtBytes(len)} · ${fmtTime(total - t)}`);
  const sym = Math.floor(units);
  if (sym > c.lastSym) {
    c.lastSym = sym;
    fx.spark(peakOr(), 'tx', 4, 0.9);
  }
}

async function sendText() {
  const text = ui.text.value;
  if (!text.trim()) return;
  ui.text.value = '';
  autosize();
  try {
    const p = await packText(text);
    enqueue({ kind: p.kind, bytes: p.bytes, label: 'Text', text });
  } catch (err) {
    ui.text.value = text;
    autosize();
    toast(err.message || String(err));
  }
  updateSendUI();
}

// ---------------------------------------------------------------- staged file

let staged = null; // { file, kind, bytes, url, err }

async function stageFile(file) {
  clearStaged();
  const s = { file, kind: 0, bytes: null, url: null, err: null };
  staged = s;
  ui.staged.hidden = false;
  ui.staged.classList.remove('err');
  ui.stagedName.textContent = file.name || 'file';
  ui.stagedName.title = file.name || '';
  ui.stagedMeta.textContent = fmtBytes(file.size);
  if (file.type.startsWith('image/')) {
    s.url = URL.createObjectURL(file);
    ui.stagedThumb.style.backgroundImage = `url("${s.url}")`;
    ui.stagedThumb.innerHTML = '';
  } else {
    ui.stagedThumb.style.backgroundImage = '';
    ui.stagedThumb.innerHTML = ICON.file;
  }
  updateSendUI();
  try {
    const p = await packFile(file);
    if (staged !== s) return;
    s.kind = p.kind;
    s.bytes = p.bytes;
    const t = frameTiming(p.bytes.length, sampleRate());
    ui.stagedMeta.textContent = `${fmtBytes(file.size)} · ${fmtTime(t.total)} to send`;
  } catch (err) {
    if (staged !== s) return;
    s.err = err;
    ui.staged.classList.add('err');
    ui.stagedMeta.textContent =
      file.size > CONFIG.maxPayload
        ? `${fmtBytes(file.size)} · over the ${fmtBytes(CONFIG.maxPayload)} limit`
        : err.message || 'Can’t send this file';
  }
  updateSendUI();
}

function clearStaged() {
  if (staged && staged.url) URL.revokeObjectURL(staged.url);
  staged = null;
  ui.staged.hidden = true;
  ui.file.value = '';
  updateSendUI();
}

function sendStaged() {
  const s = staged;
  if (!s || !s.bytes) return;
  staged = null;
  ui.staged.hidden = true;
  ui.file.value = '';
  // The outgoing card owns the thumbnail URL from here.
  enqueue({
    kind: s.kind,
    bytes: s.bytes,
    label: s.file.name || 'file',
    fileInfo: { name: s.file.name || 'file', mime: s.file.type, blob: s.file, size: s.file.size },
  });
  if (s.url) URL.revokeObjectURL(s.url);
}

// ---------------------------------------------------------------- composer

function updateSendUI() {
  const hasText = ui.text.value.trim().length > 0;
  const fileReady = !!(staged && staged.bytes);
  const canSend = hasText || fileReady;
  const busy = !!tx.cur || tx.queue.length > 0;
  const stop = busy && !canSend;
  ui.send.disabled = !canSend && !busy;
  ui.send.classList.toggle('stop', stop);
  ui.sendLabel.textContent = stop ? 'Stop' : 'Send';
  ui.send.setAttribute('aria-label', stop ? 'Stop sending' : 'Send');
}

function autosize() {
  const t = ui.text;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

ui.text.addEventListener('input', () => {
  autosize();
  updateSendUI();
});

const finePointer = matchMedia('(pointer: fine)').matches;
ui.text.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.metaKey || e.ctrlKey || (finePointer && !e.shiftKey)) {
    e.preventDefault();
    onSend();
  }
});

ui.text.addEventListener('paste', (e) => {
  const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
  if (f) {
    e.preventDefault();
    stageFile(f);
  }
});

function onSend() {
  ensureCtx();
  const fileReady = staged && staged.bytes;
  const hasText = ui.text.value.trim().length > 0;
  if (fileReady) sendStaged();
  if (hasText) sendText();
  if (!fileReady && !hasText && (tx.cur || tx.queue.length)) stopSending();
}
ui.send.addEventListener('click', onSend);

ui.listen.addEventListener('click', () => {
  if (A.listening) stopListening();
  else if (!ui.listen.classList.contains('busy')) startListening();
});

ui.paste.addEventListener('click', async () => {
  ensureCtx();
  let text;
  try {
    text = await readClipboard();
  } catch {
    toast('Clipboard access was blocked. Paste into the box instead.');
    ui.text.focus();
    return;
  }
  if (!text) {
    toast('The clipboard has no text.');
    return;
  }
  ui.text.value = text;
  autosize();
  updateSendUI();
  if (ui.autosend.checked) sendText();
});

try {
  ui.autosend.checked = localStorage.getItem('cicada.autosend') === '1';
} catch {
  /* storage unavailable */
}
ui.autosend.addEventListener('change', () => {
  try {
    localStorage.setItem('cicada.autosend', ui.autosend.checked ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
});

ui.file.addEventListener('change', () => {
  const f = ui.file.files && ui.file.files[0];
  if (f) stageFile(f);
});
ui.stagedX.addEventListener('click', clearStaged);

// drag and drop anywhere
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  ui.drop.hidden = false;
});
addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) ui.drop.hidden = true;
});
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  ui.drop.hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) stageFile(f);
});

// ---------------------------------------------------------------- toast

let toastTimer = 0;
function toast(msg, ms = 6000) {
  ui.toastMsg.textContent = msg;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (ui.toast.hidden = true), ms);
}
ui.toastX.addEventListener('click', () => (ui.toast.hidden = true));

// ---------------------------------------------------------------- frame loop

let lastT = performance.now();
let lastPeak = -1;
let lvl = 0;
let lvlShown = -1;
let perfT = 0, perfN = 0;

function layoutInsets() {
  fx.topInset = ui.top.getBoundingClientRect().bottom;
}
addEventListener('resize', layoutInsets);
layoutInsets();

function loop(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  // Auto-tune: drop the blurred bloom layer if frames run long.
  perfT += dt;
  perfN++;
  if (perfT > 2) {
    if (spectro.bloomOn && perfT / perfN > 0.024) spectro.setBloom(false);
    perfT = perfN = 0;
  }

  let an = null;
  if (A.listening) an = A.rxAn;
  else if (A.ctx && tx.windows.length && A.ctx.currentTime < tx.windows[tx.windows.length - 1].end + 4) an = A.txAn;

  const peak = spectro.frame(an);
  const pal = tx.cur ? 'tx' : 'rx';
  if (peak.active) {
    if (lastPeak < 0 || Math.abs(peak.peak - lastPeak) > 0.03) fx.spark(peak.peak, pal, 2, 0.7, !!(A.listening && tx.cur));
    lastPeak = peak.peak;
  } else {
    lastPeak = -1;
  }

  if (A.ctx) {
    txFrame();
    const t = A.ctx.currentTime;
    while (tx.windows.length > 1 && tx.windows[0].end < t - 10) tx.windows.shift();
  }

  fx.frame(dt, peak, pal);
  feed.tick(now);

  // Listen button breathes with the input level.
  const target = A.listening ? peak.level : 0;
  lvl += (target - lvl) * Math.min(1, dt * 18);
  if (Math.abs(lvl - lvlShown) > 0.02) {
    lvlShown = lvl;
    ui.listen.style.setProperty('--lvl', lvl.toFixed(3));
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

updateSendUI();

if (new URLSearchParams(location.search).has('debug')) window.cicada = { rxHandlers, fx, feed, A, tx, spectro };

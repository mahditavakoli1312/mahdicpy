'use strict';

/* ════════════════════════════ helpers ════════════════════════════ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem('mcpy_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mcpy_' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const fmtBytes = n => {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
};
const fmtDate = s => new Date(s * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
const fmtUptime = s => {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
function html(str) { const t = document.createElement('template'); t.innerHTML = str.trim(); return t.content.firstElementChild; }

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Copied to clipboard', 'ok', { timeout: 1600 });
}

/* ════════════════════════════ auth & api ════════════════════════════ */

const params = new URLSearchParams(location.search);
let TOKEN = params.get('t') || store.get('token', '');
if (params.get('t')) { store.set('token', TOKEN); history.replaceState(null, '', location.pathname); }

const state = { role: null, devices: [], serial: null, device: null, tab: store.get('tab', 'overview'), apps: [] };

async function api(path, { method = 'GET', body, raw, headers = {}, signal } = {}) {
  const opt = { method, headers: { 'X-Token': TOKEN, ...headers }, signal };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) opt.body = body;
    else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(path, opt);
  if (raw) return r;
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (r.status === 401) askToken();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const q = (path, extra = {}) => `${path}?${new URLSearchParams({ s: state.serial, ...extra })}`;
const dlUrl = (path, extra = {}) => q(path, { ...extra, t: TOKEN });
const devApi = (path, opts, extra) => api(q(path, extra), opts);

/* ════════════════════════════ toasts & modal ════════════════════════════ */

function toast(msg, type = 'info', { timeout = 4000, action } = {}) {
  const t = html(`<div class="toast ${type}"><div class="tx"></div></div>`);
  $('.tx', t).textContent = msg;
  if (action) {
    const b = html(`<button class="btn sm">${esc(action.label)}</button>`);
    b.onclick = () => { action.fn(); t.remove(); };
    t.append(b);
  }
  $('#toasts').append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
  t.onclick = e => { if (e.target === t || e.target.classList.contains('tx')) t.remove(); };
  return t;
}
const errToast = e => toast(e.message || String(e), 'err', { timeout: 6000 });

function openModal(inner, { wide = false } = {}) {
  const card = $('#modal-card');
  card.className = 'modal-card' + (wide ? ' wide' : '');
  card.innerHTML = inner;
  $('#modal').classList.remove('hidden');
  return card;
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-card').innerHTML = ''; }
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });

function confirmBox(title, text, okLabel = 'Confirm', danger = true) {
  return new Promise(res => {
    const c = openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p>
      <div class="foot"><button class="btn" data-x>Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`);
    $('[data-x]', c).onclick = () => { closeModal(); res(false); };
    $('[data-ok]', c).onclick = () => { closeModal(); res(true); };
  });
}

function askToken() {
  if ($('#modal-card [data-token]')) return;
  const c = openModal(`<h2>Access token required</h2>
    <p>Open the link printed by <span class="mono">mahdicpy web</span> in your terminal, or paste the token here.</p>
    <div class="field"><input data-token placeholder="token"></div>
    <div class="foot"><button class="btn primary" data-ok>Continue</button></div>`);
  $('[data-ok]', c).onclick = () => { TOKEN = $('[data-token]', c).value.trim(); store.set('token', TOKEN); location.reload(); };
}

/* ════════════════════════════ control protocol ════════════════════════════ */

const enc = new TextEncoder();
let clipSeq = 1;
const Ctl = {
  key(action, code, meta = 0, repeat = 0) {
    const v = new DataView(new ArrayBuffer(14));
    v.setUint8(0, 0); v.setUint8(1, action); v.setInt32(2, code); v.setInt32(6, repeat); v.setInt32(10, meta);
    return v.buffer;
  },
  text(str) {
    const u = enc.encode(str), b = new Uint8Array(5 + u.length), v = new DataView(b.buffer);
    v.setUint8(0, 1); v.setUint32(1, u.length); b.set(u, 5);
    return b.buffer;
  },
  touch(action, pid, x, y, w, h, pressure) {
    const v = new DataView(new ArrayBuffer(32));
    v.setUint8(0, 2); v.setUint8(1, action); v.setBigInt64(2, BigInt(pid));
    v.setInt32(10, x); v.setInt32(14, y); v.setUint16(18, w); v.setUint16(20, h);
    v.setUint16(22, pressure ? 0xffff : 0); v.setUint32(24, 0); v.setUint32(28, 0);
    return v.buffer;
  },
  scroll(x, y, w, h, hs, vs) {
    const fp = f => Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, f / 16)) * 32768)));
    const v = new DataView(new ArrayBuffer(21));
    v.setUint8(0, 3); v.setInt32(1, x); v.setInt32(5, y); v.setUint16(9, w); v.setUint16(11, h);
    v.setInt16(13, fp(hs)); v.setInt16(15, fp(vs)); v.setUint32(17, 0);
    return v.buffer;
  },
  back(action) { return new Uint8Array([4, action]).buffer; },
  notif() { return new Uint8Array([5]).buffer; },
  settingsPanel() { return new Uint8Array([6]).buffer; },
  collapse() { return new Uint8Array([7]).buffer; },
  getClip(copyKey) { return new Uint8Array([8, copyKey]).buffer; },
  setClip(text, paste) {
    const u = enc.encode(text), b = new Uint8Array(14 + u.length), v = new DataView(b.buffer);
    v.setUint8(0, 9); v.setBigUint64(1, BigInt(clipSeq++)); v.setUint8(9, paste ? 1 : 0); v.setUint32(10, u.length);
    b.set(u, 14);
    return b.buffer;
  },
  displayPower(on) { return new Uint8Array([10, on ? 1 : 0]).buffer; },
  rotate() { return new Uint8Array([11]).buffer; },
  reset() { return new Uint8Array([17]).buffer; },
};

const KEYCODES = {
  Enter: 66, Backspace: 67, Delete: 112, Tab: 61, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  Home: 122, End: 123, PageUp: 92, PageDown: 93, Insert: 124, ' ': 62,
  F1: 131, F2: 132, F3: 133, F4: 134, F5: 135, F6: 136, F7: 137, F8: 138, F9: 139, F10: 140, F11: 141, F12: 142,
};
const letterCode = k => /^[a-z]$/i.test(k) ? 29 + k.toLowerCase().charCodeAt(0) - 97 : /^[0-9]$/.test(k) ? 7 + +k : null;

/* ════════════════════════════ screen ════════════════════════════ */

const HAS_WEBCODECS = 'VideoDecoder' in window;

class Screen {
  constructor() {
    this.canvas = $('#screen');
    this.ctx = this.canvas.getContext('2d');
    this.ws = null; this.serial = null; this.size = { w: 0, h: 0 };
    this.decoder = null; this.config = null; this.codec = null; this.gotKey = false;
    this.frames = 0; this.bytes = 0; this.pointers = new Map(); this.retry = 0; this.live = false;
    this.pingSent = 0;
    setInterval(() => this.tick(), 1000);
    setInterval(() => this.ping(), 2000);
    new ResizeObserver(() => Inspector.layout()).observe(this.canvas);
  }

  connect(serial, restart = false) {
    this.close();
    this.serial = serial; this.intentional = false;
    if (!serial) { this.status('idle', 'Pick a device to start'); return; }
    const [max, bitrate, fps] = $('#quality').value.split(',');
    const p = new URLSearchParams({ s: serial, t: TOKEN, max, bitrate, fps, restart: restart ? 1 : 0, video: HAS_WEBCODECS ? 1 : 0 });
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/screen?${p}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.status('connecting', restart ? 'Restarting stream…' : 'Starting scrcpy-server…');
    ws.onmessage = e => typeof e.data === 'string' ? this.onJson(JSON.parse(e.data)) : this.onPacket(e.data);
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.live = false; this.setPill(false);
      if (this.intentional) return;
      const delay = Math.min(1000 * 2 ** this.retry++, 8000);
      this.status('connecting', `Connection lost — retrying in ${Math.round(delay / 1000)}s…`);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.serial === serial && this.connect(serial), delay);
    };
    if (!HAS_WEBCODECS) this.snapshotLoop(serial);
  }

  close() {
    this.intentional = true;
    clearTimeout(this.retryTimer);
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.ws = null; this.live = false; this.setPill(false);
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null; this.config = null; this.gotKey = false;
  }

  send(buf) { if (state.role === 'admin' && this.ws?.readyState === 1) this.ws.send(buf); }
  sendJson(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }

  status(kind, text) {
    const m = $('#screen-msg');
    m.classList.toggle('hidden', kind === 'live');
    m.classList.toggle('idle', kind === 'idle');
    $('#screen-msg-text').textContent = text || '';
    const pill = $('#pill-state');
    pill.className = 'pill ' + (kind === 'live' ? 'live' : kind === 'connecting' ? 'connecting' : '');
    $('b', pill).textContent = kind === 'live' ? 'live' : kind === 'connecting' ? 'connecting' : 'offline';
  }
  setPill(on) { if (!on) { $('#pill-fps').textContent = '— fps'; $('#pill-rate').textContent = '— Mbps'; } }

  onJson(m) {
    if (m.t === 'meta') {
      this.setSize(m.w, m.h);
      $('#pill-res').textContent = `${m.w}×${m.h}`;
      this.retry = 0;
      if (!HAS_WEBCODECS) this.status('live');
    } else if (m.t === 'size') {
      this.setSize(m.w, m.h);
    } else if (m.t === 'viewers') {
      $('#pill-viewers').textContent = `👁 ${m.n}`;
    } else if (m.t === 'clipboard') {
      onDeviceClipboard(m.text);
    } else if (m.t === 'pong') {
      if (m.id === this.pingSent) { const rtt = performance.now() - m.id; $('#pill-lat').textContent = `${rtt < 10 ? rtt.toFixed(1) : Math.round(rtt)} ms`; }
    } else if (m.t === 'closed') {
      this.status('connecting', `Stream closed (${m.reason}) — reconnecting…`);
    }
  }

  setSize(w, h) {
    if (!w || !h) return;
    this.size = { w, h };
    $('#pill-res').textContent = `${w}×${h}`;
  }

  onPacket(buf) {
    this.bytes += buf.byteLength;
    const v = new DataView(buf);
    const flags = v.getBigUint64(1);
    const isConfig = (flags >> 63n) === 1n, isKey = ((flags >> 62n) & 1n) === 1n;
    const pts = Number(flags & 0x3FFFFFFFFFFFFFFFn);
    const data = new Uint8Array(buf, 13);
    if (isConfig) { this.configure(data.slice()); return; }
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (!isKey && !this.gotKey) return;
    let payload = data;
    if (isKey) {
      payload = new Uint8Array(this.config.length + data.length);
      payload.set(this.config); payload.set(data, this.config.length);
      this.gotKey = true;
    }
    if (this.decoder.decodeQueueSize > 25) { this.gotKey = false; this.sendJson({ t: 'reset' }); return; }
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: pts, data: payload }));
    } catch (e) { console.warn(e); this.rebuildDecoder(); }
  }

  configure(config) {
    this.config = config;
    let i = 0;
    while (i + 4 < config.length && !(config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1 && (config[i + 3] & 0x1f) === 7)) i++;
    const s = config.subarray(i + 4, i + 7);
    this.codec = 'avc1.' + [...s].map(b => b.toString(16).padStart(2, '0')).join('');
    this.rebuildDecoder(false);
  }

  rebuildDecoder(requestKey = true) {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.gotKey = false;
    this.decoder = new VideoDecoder({
      output: f => this.onFrame(f),
      error: e => { console.warn('decoder', e); setTimeout(() => this.rebuildDecoder(), 100); },
    });
    this.decoder.configure({ codec: this.codec, optimizeForLatency: true });
    if (requestKey) this.sendJson({ t: 'reset' });
  }

  onFrame(f) {
    const w = f.displayWidth, h = f.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h; this.setSize(w, h); Inspector.layout();
    }
    this.ctx.drawImage(f, 0, 0);
    f.close();
    this.frames++;
    if (!this.live) { this.live = true; this.status('live'); }
  }

  async snapshotLoop(serial) {
    const img = new Image();
    while (this.serial === serial && !this.intentional) {
      try {
        const r = await api(q('/api/screenshot'), { raw: true });
        if (r.ok) {
          const url = URL.createObjectURL(await r.blob());
          await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
          const { w, h } = this.size.w ? this.size : { w: img.width, h: img.height };
          if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = h; }
          this.ctx.drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          this.frames++;
          if (!this.live) { this.live = true; this.status('live'); toast('Snapshot mode: this browser/context lacks WebCodecs. Use localhost or HTTPS for smooth video.', 'warn', { timeout: 8000 }); }
        }
      } catch { /* retry */ }
      await sleep(350);
    }
  }

  tick() {
    if (this.live) {
      $('#pill-fps').textContent = `${this.frames} fps`;
      $('#pill-rate').textContent = `${(this.bytes * 8 / 1e6).toFixed(1)} Mbps`;
    }
    this.frames = 0; this.bytes = 0;
  }
  ping() { if (this.ws?.readyState === 1) { this.pingSent = performance.now(); this.sendJson({ t: 'ping', id: this.pingSent }); } }

  /* ---- input ---- */
  pos(e) {
    const c = this.canvas, r = c.getBoundingClientRect();
    const x = (e.clientX - r.left - c.clientLeft) / c.clientWidth;
    const y = (e.clientY - r.top - c.clientTop) / c.clientHeight;
    return { x: Math.round(Math.max(0, Math.min(1, x)) * this.size.w), y: Math.round(Math.max(0, Math.min(1, y)) * this.size.h) };
  }
  touch(action, e, pid) {
    const p = this.pos(e);
    this.send(Ctl.touch(action, pid, p.x, p.y, this.size.w, this.size.h, action !== 1));
  }
  key(code, meta = 0) { this.send(Ctl.key(0, code, meta)); this.send(Ctl.key(1, code, meta)); }
  typeText(t) {
    if (/^[\x20-\x7e]+$/.test(t) && t.length <= 300) this.send(Ctl.text(t));
    else this.send(Ctl.setClip(t, true));
  }

  bindInput() {
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      c.focus();
      if (!this.size.w) return;
      if (e.pointerType === 'mouse' && e.button === 2) { this.send(Ctl.back(0)); this.send(Ctl.back(1)); return; }
      if (e.pointerType === 'mouse' && e.button === 1) { e.preventDefault(); this.key(3); return; }
      if (e.button !== 0) return;
      const pid = e.pointerType === 'mouse' ? -2 : e.pointerId;
      this.pointers.set(e.pointerId, pid);
      c.setPointerCapture(e.pointerId);
      this.touch(0, e, pid);
    });
    c.addEventListener('pointermove', e => {
      const pid = this.pointers.get(e.pointerId);
      if (pid !== undefined) this.touch(2, e, pid);
    });
    const up = e => {
      const pid = this.pointers.get(e.pointerId);
      if (pid === undefined) return;
      this.pointers.delete(e.pointerId);
      this.touch(1, e, pid);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      if (!this.size.w) return;
      const p = this.pos(e), k = e.deltaMode === 1 ? 40 : 1;
      const clamp = v => Math.max(-16, Math.min(16, v));
      this.send(Ctl.scroll(p.x, p.y, this.size.w, this.size.h, clamp(-e.deltaX * k / 60), clamp(-e.deltaY * k / 60)));
    }, { passive: false });

    c.addEventListener('keydown', e => {
      if (e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'c' || k === 'x') { this.send(Ctl.getClip(k === 'c' ? 1 : 2)); e.preventDefault(); }
        return; // ⌘V → paste event, other ⌘ shortcuts stay with the browser
      }
      if (e.key === 'Escape') { this.send(Ctl.back(0)); this.send(Ctl.back(1)); e.preventDefault(); return; }
      let meta = 0;
      if (e.shiftKey) meta |= 0x41;
      if (e.ctrlKey) meta |= 0x3000;
      if (e.altKey) meta |= 0x12;
      if (e.ctrlKey || e.altKey) {
        const code = letterCode(e.key) ?? KEYCODES[e.key];
        if (code != null) { this.key(code, meta); e.preventDefault(); }
        return;
      }
      if (KEYCODES[e.key] != null && e.key !== ' ') { this.key(KEYCODES[e.key], meta); e.preventDefault(); return; }
      if (e.key.length === 1) { this.typeText(e.key); e.preventDefault(); }
    });
    document.addEventListener('paste', e => {
      if (document.activeElement !== c) return;
      const t = e.clipboardData?.getData('text');
      if (t) { this.send(Ctl.setClip(t, true)); e.preventDefault(); toast('Pasted to device', 'ok', { timeout: 1200 }); }
    });
  }
}

let lastClipToast = 0;
function onDeviceClipboard(text) {
  if (!text || Date.now() - lastClipToast < 800) return;
  lastClipToast = Date.now();
  navigator.clipboard?.writeText(text)
    .then(() => toast(`📋 Device clipboard synced: ${text.slice(0, 80)}`, 'ok', { timeout: 2500 }))
    .catch(() => toast(`📋 Device clipboard: ${text.slice(0, 120)}`, 'info', { action: { label: 'Copy', fn: () => copyText(text) } }));
}

const mirror = new Screen();

/* ════════════════════════════ recording ════════════════════════════ */

const Recorder = {
  rec: null, chunks: [],
  toggle() { this.rec ? this.stop() : this.start(); },
  start() {
    if (!mirror.live) return toast('Nothing to record yet', 'warn');
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    const mimeType = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!mimeType) return toast('Recording is not supported in this browser', 'err');
    this.chunks = [];
    this.rec = new MediaRecorder(mirror.canvas.captureStream(60), { mimeType, videoBitsPerSecond: 8e6 });
    this.rec.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: mimeType });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mahdicpy-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
      a.click();
      toast(`Recording saved (${fmtBytes(blob.size)})`, 'ok');
    };
    this.rec.start(1000);
    this.t0 = Date.now();
    $('#btn-rec').classList.add('on');
    toast('Recording… press ⏺ again to stop', 'info', { timeout: 2500 });
  },
  stop() { this.rec?.stop(); this.rec = null; $('#btn-rec').classList.remove('on'); },
};

/* ════════════════════════════ devices ════════════════════════════ */

async function refreshDevices() {
  try { state.devices = await api('/api/devices'); }
  catch { return; }
  renderDevices();
  const ready = state.devices.filter(d => d.state === 'device');
  if (!state.serial || !state.devices.some(d => d.serial === state.serial)) {
    const saved = store.get('serial');
    const pick = ready.find(d => d.serial === saved) || ready[0];
    if (pick && pick.serial !== state.serial) selectDevice(pick.serial);
    else if (!pick && state.serial) { state.serial = null; mirror.connect(null); updateTitle(); }
  }
  state.device = state.devices.find(d => d.serial === state.serial) || null;
}

function renderDevices() {
  const list = $('#device-list');
  if (!state.devices.length) {
    list.innerHTML = `<div class="empty-devices">No devices yet.<br>• Plug in a phone with <b>USB debugging</b> on<br>• or press <b>＋</b> to connect over Wi-Fi</div>`;
    return;
  }
  list.innerHTML = state.devices.map(d => {
    const bad = d.state !== 'device';
    const tags = [
      `<span class="tag ${d.wifi ? 'wifi' : 'usb'}">${d.wifi ? 'Wi-Fi' : 'USB'}</span>`,
      bad ? `<span class="tag warn">${esc(d.state === 'unauthorized' ? 'accept prompt on phone' : d.state)}</span>` : '',
      d.android ? `<span>Android ${esc(d.android)}</span>` : '',
      d.battery != null ? `<span>🔋${d.battery}%</span>` : '',
      d.viewers ? `<span>👁 ${d.viewers}</span>` : '',
    ].join('');
    return `<button class="device ${d.serial === state.serial ? 'active' : ''} ${bad ? 'bad' : ''}" data-serial="${esc(d.serial)}">
      <div class="device-ico">${d.wifi ? '📶' : '📱'}</div>
      <div class="device-meta"><div class="device-name">${esc(d.name || d.model || d.serial)}</div>
      <div class="device-sub">${tags}</div></div></button>`;
  }).join('');
  $$('.device', list).forEach(b => b.onclick = () => {
    const d = state.devices.find(x => x.serial === b.dataset.serial);
    if (d?.state === 'device') selectDevice(d.serial);
    else toast(d?.state === 'unauthorized' ? 'Unlock the phone and accept "Allow USB debugging".' : `Device is ${d?.state}`, 'warn');
  });
}

function selectDevice(serial) {
  if (serial === state.serial && mirror.ws) return;
  state.serial = serial;
  state.device = state.devices.find(d => d.serial === serial) || null;
  state.apps = [];
  store.set('serial', serial);
  renderDevices();
  updateTitle();
  Inspector.clear();
  mirror.connect(serial);
  if (state.role === 'admin') renderTab();
}

function updateTitle() {
  const d = state.device;
  $('#dev-title').textContent = d ? `${d.brand ? d.brand[0].toUpperCase() + d.brand.slice(1) + ' ' : ''}${d.name || d.model || d.serial}` : 'No device';
  document.title = d ? `${d.name || d.serial} · mahdicpy` : 'mahdicpy';
}

/* ════════════════════════════ charts ════════════════════════════ */

class Spark {
  constructor(canvas, { max = null, color = '#8b5cf6' } = {}) {
    this.c = canvas; this.data = []; this.max = max; this.color = color;
  }
  push(v) { this.data.push(v); if (this.data.length > 60) this.data.shift(); this.draw(); }
  draw() {
    const c = this.c, dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    c.width = W * dpr; c.height = H * dpr;
    const x = c.getContext('2d'); x.scale(dpr, dpr);
    const vals = this.data.filter(v => v != null);
    if (vals.length < 2) return;
    const max = this.max ?? Math.max(...vals) * 1.15, min = this.max != null ? 0 : Math.min(...vals) * 0.85;
    const pts = this.data.map((v, i) => [i / 59 * W, H - 3 - ((v ?? min) - min) / (max - min || 1) * (H - 6)]);
    const off = W - pts[pts.length - 1][0];
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, this.color + '55'); g.addColorStop(1, this.color + '00');
    x.beginPath(); pts.forEach(([a, b], i) => i ? x.lineTo(a + off, b) : x.moveTo(a + off, b));
    x.lineTo(W, H); x.lineTo(pts[0][0] + off, H); x.fillStyle = g; x.fill();
    x.beginPath(); pts.forEach(([a, b], i) => i ? x.lineTo(a + off, b) : x.moveTo(a + off, b));
    x.strokeStyle = this.color; x.lineWidth = 1.8; x.lineJoin = 'round'; x.stroke();
  }
}

/* ════════════════════════════ tabs ════════════════════════════ */

const TABS = {};
let tabCleanup = null;

function renderTabs() {
  $('#tabs').innerHTML = Object.entries(TABS).map(([k, t]) =>
    `<button class="tab ${k === state.tab ? 'active' : ''}" data-tab="${k}">${t.label}</button>`).join('');
  $$('.tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
}
function switchTab(k, opts) {
  state.tab = k; store.set('tab', k); state.tabOpts = opts || null;
  renderTabs(); renderTab();
}
function renderTab() {
  if (tabCleanup) { try { tabCleanup(); } catch { /* ignore */ } tabCleanup = null; }
  const body = $('#tab-body');
  body.className = 'tab-body';
  body.innerHTML = '';
  if (!state.serial) { body.innerHTML = '<div class="empty">Connect a device to use the developer tools.</div>'; return; }
  const t = TABS[state.tab] || TABS.overview;
  tabCleanup = t.render(body, state.tabOpts) || null;
  state.tabOpts = null;
}

/* ─────────── Overview ─────────── */
TABS.overview = {
  label: '📊 Overview',
  render(body) {
    body.innerHTML = `
      <div class="grid2" id="ov-info"><div class="empty">Loading device info…</div></div>
      <div class="card">
        <div class="toolbar" style="margin-bottom:12px">
          <h3 style="margin:0;flex:1">Live performance</h3>
          <input id="ov-pkg" list="ov-pkgs" placeholder="watch an app (package)…" style="width:220px">
          <datalist id="ov-pkgs"></datalist>
          <button class="btn sm" id="ov-fg" title="Watch the app in the foreground">◎ Foreground</button>
        </div>
        <div class="charts" id="ov-charts"></div>
      </div>
      <div class="card"><h3>Quick actions</h3><div class="actions" id="ov-actions"></div></div>
      <div class="card"><h3>Type on device</h3>
        <div class="toolbar"><input class="grow" id="ov-text" placeholder="Text to type (any language — sent via clipboard)">
        <button class="btn" id="ov-send">Send</button><button class="btn" id="ov-send-enter">Send + ⏎</button></div></div>`;
    let alive = true, timer;
    const pkgInput = $('#ov-pkg', body);
    pkgInput.value = store.get('watchPkg', '');
    const defs = [
      ['cpu', 'CPU', '%', 100, '#a855f7'], ['mem', 'RAM used', '', null, '#6366f1'], ['temp', 'Battery temp', '°C', null, '#f59e0b'],
      ['pss', 'App memory (PSS)', '', null, '#06b6d4'], ['jank', 'App jank', '%', 100, '#f87171'],
    ];
    const charts = {};
    $('#ov-charts', body).innerHTML = defs.map(([k, l]) =>
      `<div class="chart ${k === 'pss' || k === 'jank' ? 'app-chart' : ''}" data-k="${k}"><div class="top"><span class="k">${l}</span><span class="v" id="cv-${k}">—</span></div><canvas></canvas></div>`).join('');
    defs.forEach(([k, , , max, color]) => charts[k] = new Spark($(`[data-k=${k}] canvas`, body), { max, color }));
    const showApp = () => $$('.app-chart', body).forEach(e => e.style.display = pkgInput.value ? '' : 'none');
    showApp();

    devApi('/api/info').then(i => {
      if (!alive) return;
      const ramUsed = i.ram_total - i.ram_avail;
      const bat = i.battery;
      $('#ov-info', body).innerHTML = [
        ['Device', `${i.brand} ${i.model}`, i.emulator ? 'emulator' : ''],
        ['Android', `${i.android} <small>API ${i.sdk}</small>`],
        ['Chip', `${i.chip} <small>${i.abi}</small>`],
        ['Screen', `${i.screen} <small>${i.density} dpi</small>`],
        ['RAM', `${fmtBytes(ramUsed)} <small>/ ${fmtBytes(i.ram_total)}</small>`, '', ramUsed / i.ram_total * 100],
        ['Storage', i.storage ? `${i.storage.used} <small>/ ${i.storage.size}</small>` : '—', '', i.storage ? parseInt(i.storage.pct) : null],
        ['Battery', `${bat}% <small>${i.temperature}°C${i.charging ? ' · ⚡' : ''}</small>`, '', bat],
        ['Wi-Fi IP', i.ip || '<small>not connected</small>'],
        ['Uptime', fmtUptime(i.uptime)],
        ['Security patch', i.patch || '—'],
        ['Locale', i.locale || '—'],
        ['Serial', `<span class="mono" style="font-size:12px">${esc(i.serial)}</span>`],
      ].map(([k, v, sub, pct]) => `<div class="stat"><div class="k">${k}</div><div class="v" title="${esc(String(v).replace(/<[^>]+>/g, ''))}">${v}</div>
        ${pct != null ? `<div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div>` : ''}</div>`).join('');
    }).catch(errToast);

    devApi('/api/apps').then(r => {
      state.apps = r.packages;
      $('#ov-pkgs', body).innerHTML = r.packages.map(p => `<option value="${esc(p)}">`).join('');
    }).catch(() => {});

    const poll = async () => {
      if (!alive) return;
      try {
        const pkg = pkgInput.value.trim();
        const s = await devApi('/api/stats', undefined, pkg ? { pkg } : {});
        if (!alive) return;
        charts.cpu.push(s.cpu); $('#cv-cpu', body).textContent = s.cpu != null ? `${s.cpu}%` : '…';
        charts.mem.push(s.mem_used / 1048576); $('#cv-mem', body).textContent = fmtBytes(s.mem_used);
        charts.temp.push(s.temp); $('#cv-temp', body).textContent = `${s.temp.toFixed(1)}°C`;
        if (pkg) {
          charts.pss.push(s.app_pss ? s.app_pss / 1048576 : null);
          $('#cv-pss', body).textContent = s.pid ? fmtBytes(s.app_pss) : 'not running';
          charts.jank.push(s.jank_pct);
          $('#cv-jank', body).textContent = s.frames ? `${s.jank_pct}% · ${s.frames}f` : '—';
        }
      } catch { /* device busy */ }
      timer = setTimeout(poll, 1500);
    };
    poll();
    pkgInput.onchange = () => { store.set('watchPkg', pkgInput.value.trim()); charts.pss.data = []; charts.jank.data = []; showApp(); };
    $('#ov-fg', body).onclick = async () => {
      const r = await devApi('/api/apps');
      if (r.foreground) { pkgInput.value = r.foreground; pkgInput.onchange(); toast(`Watching ${r.foreground}`, 'ok'); }
    };

    const actions = [
      ['📷 Screenshot', () => downloadShot()],
      ['💥 Recent crashes', () => showCrashes()],
      ['📶 Switch to Wi-Fi', () => goWireless()],
      ['🛠 Developer options', () => shell('am start -a android.settings.APPLICATION_DEVELOPMENT_SETTINGS')],
      ['⚙️ Settings', () => shell('am start -a android.settings.SETTINGS')],
      ['🔒 Lock screen', () => mirror.key(26)],
      ['🔄 Restart stream', () => mirror.connect(state.serial, true)],
      ['⏻ Reboot', async () => { if (await confirmBox('Reboot device?', 'The device will restart and disconnect.', 'Reboot')) shell('reboot'); }],
    ];
    const box = $('#ov-actions', body);
    actions.forEach(([l, fn]) => { const b = html(`<button class="btn sm">${l}</button>`); b.onclick = fn; box.append(b); });

    const send = enter => {
      const t = $('#ov-text', body).value;
      if (!t) return;
      mirror.typeText(t);
      if (enter) setTimeout(() => mirror.key(66), 150);
      $('#ov-text', body).value = '';
    };
    $('#ov-send', body).onclick = () => send(false);
    $('#ov-send-enter', body).onclick = () => send(true);
    $('#ov-text', body).onkeydown = e => { if (e.key === 'Enter') send(true); };
    return () => { alive = false; clearTimeout(timer); };
  },
};

async function shell(cmd) {
  try { const r = await devApi('/api/shell', { method: 'POST', body: { cmd } }); return r; }
  catch (e) { errToast(e); }
}
function downloadShot() {
  const a = document.createElement('a'); a.href = dlUrl('/api/screenshot', { dl: 1 }); a.click();
  toast('Capturing full-resolution screenshot…', 'info', { timeout: 1500 });
}
async function showCrashes() {
  const c = openModal('<h2>Recent crashes</h2><p>Loading crash buffer…</p>', { wide: true });
  try {
    const r = await devApi('/api/crashes');
    c.innerHTML = `<h2>Recent crashes</h2><p>From <span class="mono">logcat -b crash</span></p>
      <div class="preview-text"></div>
      ${r.anr ? `<h4 style="margin:14px 0 6px">ANR traces</h4><div class="preview-text anr"></div>` : ''}
      <div class="foot"><button class="btn" data-copy>Copy</button><button class="btn primary" data-x>Close</button></div>`;
    $('.preview-text', c).textContent = r.crash.trim() || 'No crashes recorded 🎉';
    if (r.anr) $('.anr', c).textContent = r.anr;
    $('[data-copy]', c).onclick = () => copyText(r.crash);
    $('[data-x]', c).onclick = closeModal;
  } catch (e) { closeModal(); errToast(e); }
}
async function goWireless() {
  toast('Switching to Wi-Fi…', 'info', { timeout: 2000 });
  try {
    const r = await devApi('/api/tcpip', { method: 'POST', body: {} });
    if (r.ok) { toast(`Connected over Wi-Fi as ${r.serial} — you can unplug the cable`, 'ok', { timeout: 6000 }); await refreshDevices(); selectDevice(r.serial); }
    else toast(r.out, 'err');
  } catch (e) { errToast(e); }
}

/* ─────────── Logcat ─────────── */
TABS.logcat = {
  label: '📜 Logcat',
  render(body, opts) {
    body.className = 'tab-body flush';
    const saved = store.get('logcat', { level: 'V', q: '', pkg: '' });
    if (opts?.pkg) saved.pkg = opts.pkg;
    body.innerHTML = `<div class="logcat-wrap">
      <div class="logcat-bar">
        <select id="lc-level" title="Minimum level">${['V', 'D', 'I', 'W', 'E', 'F'].map(l => `<option ${l === saved.level ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input id="lc-q" placeholder="filter: text, tag:Foo, /regex/" style="flex:1;min-width:140px" value="${esc(saved.q)}">
        <input id="lc-pkg" list="lc-pkgs" placeholder="package" style="width:160px" value="${esc(saved.pkg)}">
        <datalist id="lc-pkgs"></datalist>
        <button class="btn sm" id="lc-fg" title="Only the foreground app">◎</button>
        <button class="btn sm" id="lc-pause" title="Pause">⏸</button>
        <button class="btn sm" id="lc-clear" title="Clear view">⌫</button>
        <button class="btn sm" id="lc-wipe" title="Clear device log buffer">🗑</button>
        <button class="btn sm" id="lc-save" title="Export">⬇</button>
      </div>
      <div class="logcat" id="lc-out"></div>
      <div class="logcat-status"><span id="lc-status">connecting…</span><label class="check"><input type="checkbox" id="lc-follow" checked> follow</label></div>
    </div>`;
    const out = $('#lc-out', body);
    const lines = [];
    let paused = false, abort = null, alive = true, pending = [], raf = 0, crashSeen = 0;
    const MAX = 6000;
    const re = /^(\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+) ([VDIWEF]) (.*?)\s*: (.*)$/;
    const LV = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };

    const filt = () => {
      const lv = LV[$('#lc-level', body).value];
      const raw = $('#lc-q', body).value.trim();
      let test = () => true, tag = null, rx = null;
      const tm = raw.match(/^tag:(\S+)\s*(.*)$/);
      let rest = raw;
      if (tm) { tag = tm[1].toLowerCase(); rest = tm[2]; }
      if (/^\/.+\/$/.test(rest)) { try { rx = new RegExp(rest.slice(1, -1), 'i'); } catch { rx = null; } }
      const low = rest.toLowerCase();
      test = l => (LV[l.lv] ?? 0) >= lv && (!tag || (l.tag || '').toLowerCase().includes(tag)) &&
        (!rest || (rx ? rx.test(l.raw) : l.raw.toLowerCase().includes(low)));
      return { test, hl: rx || (rest && !rx ? low : null) };
    };
    let F = filt();

    const row = l => {
      const d = document.createElement('div');
      d.className = `ll L-${l.lv}` + (l.crash ? ' crash' : '');
      if (l.tag == null) { d.textContent = l.raw; return d; }
      const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = l.time;
      const lv = document.createElement('span'); lv.className = 'lv'; lv.textContent = l.lv;
      const tg = document.createElement('span'); tg.className = 'tg'; tg.textContent = l.tag; tg.title = `${l.tag} · pid ${l.pid}`;
      tg.onclick = () => { $('#lc-q', body).value = `tag:${l.tag}`; refilter(); };
      const ms = document.createElement('span'); ms.className = 'ms';
      if (F.hl) {
        const text = l.msg, m = typeof F.hl === 'string' ? null : text.match(F.hl);
        const idx = m ? m.index : text.toLowerCase().indexOf(F.hl);
        const len = m ? m[0].length : F.hl.length;
        if (idx >= 0 && len) {
          const mk = document.createElement('mark'); mk.textContent = text.substr(idx, len);
          ms.append(text.slice(0, idx), mk, text.slice(idx + len));
        } else ms.textContent = text;
      } else ms.textContent = l.msg;
      d.append(ts, lv, tg, ms);
      return d;
    };
    const flush = () => {
      raf = 0;
      if (!pending.length) return;
      const frag = document.createDocumentFragment();
      for (const l of pending) if (F.test(l)) frag.append(row(l));
      pending = [];
      out.append(frag);
      while (out.childElementCount > 2500) out.firstElementChild.remove();
      if ($('#lc-follow', body).checked) out.scrollTop = out.scrollHeight;
      status();
    };
    const status = () => $('#lc-status', body).textContent =
      `${lines.length.toLocaleString()} lines · ${out.childElementCount.toLocaleString()} shown${paused ? ' · paused' : ''}`;
    const refilter = () => {
      F = filt();
      store.set('logcat', { level: $('#lc-level', body).value, q: $('#lc-q', body).value, pkg: $('#lc-pkg', body).value });
      out.innerHTML = '';
      pending = lines.slice(-2500); flush();
    };
    const add = text => {
      const m = text.match(re);
      const l = m ? { date: m[1], time: m[2], pid: m[3], lv: m[5], tag: m[6], msg: m[7], raw: text }
        : { lv: 'I', tag: null, msg: text, raw: text };
      if (/FATAL EXCEPTION|ANR in /.test(text)) {
        l.crash = true;
        if (Date.now() - crashSeen > 3000) {
          crashSeen = Date.now();
          toast(`💥 ${text.includes('ANR') ? 'ANR' : 'Crash'} detected: ${l.msg.slice(0, 100)}`, 'err', { timeout: 7000 });
        }
      }
      lines.push(l);
      if (lines.length > MAX) lines.splice(0, lines.length - MAX);
      if (!paused) { pending.push(l); if (!raf) raf = requestAnimationFrame(flush); }
    };

    const start = async () => {
      abort?.abort();
      abort = new AbortController();
      const pkg = $('#lc-pkg', body).value.trim();
      $('#lc-status', body).textContent = 'connecting…';
      try {
        const r = await api(q('/api/logcat', pkg ? { pkg, tail: 500 } : { tail: 500 }), { raw: true, signal: abort.signal });
        const reader = r.body.getReader(), dec = new TextDecoder();
        let buf = '';
        while (alive) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n'); buf = parts.pop();
          parts.forEach(p => p && add(p.replace(/\r$/, '')));
        }
        if (alive) add('--------- stream ended');
      } catch (e) { if (e.name !== 'AbortError') add(`--------- ${e.message}`); }
    };
    start();

    devApi('/api/apps').then(r => { $('#lc-pkgs', body).innerHTML = r.packages.map(p => `<option value="${esc(p)}">`).join(''); }).catch(() => {});
    let deb;
    $('#lc-q', body).oninput = () => { clearTimeout(deb); deb = setTimeout(refilter, 200); };
    $('#lc-level', body).onchange = refilter;
    $('#lc-pkg', body).onchange = () => { refilter(); lines.length = 0; out.innerHTML = ''; start(); };
    $('#lc-fg', body).onclick = async () => {
      const r = await devApi('/api/apps');
      $('#lc-pkg', body).value = r.foreground || ''; $('#lc-pkg', body).onchange();
    };
    $('#lc-pause', body).onclick = e => {
      paused = !paused; e.target.textContent = paused ? '▶' : '⏸';
      if (!paused) refilter(); status();
    };
    $('#lc-clear', body).onclick = () => { lines.length = 0; out.innerHTML = ''; status(); };
    $('#lc-wipe', body).onclick = async () => { await devApi('/api/logcat/clear', { method: 'POST', body: {} }); lines.length = 0; out.innerHTML = ''; toast('Device log buffer cleared', 'ok'); };
    $('#lc-save', body).onclick = () => {
      const blob = new Blob([lines.filter(F.test).map(l => l.raw).join('\n')], { type: 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `logcat-${Date.now()}.txt`; a.click();
    };
    out.addEventListener('scroll', () => {
      const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      $('#lc-follow', body).checked = atBottom;
    });
    return () => { alive = false; abort?.abort(); };
  },
};

/* ─────────── Apps ─────────── */
const coldStarts = {};
TABS.apps = {
  label: '📦 Apps',
  render(body) {
    body.innerHTML = `
      <div class="toolbar">
        <input class="grow" id="ap-q" placeholder="Search packages…">
        <label class="check"><input type="checkbox" id="ap-sys"> system</label>
        <label class="btn sm" style="cursor:pointer">⬆ Install APK<input type="file" accept=".apk" multiple hidden id="ap-file"></label>
      </div>
      <div class="list" id="ap-list" style="max-height:34vh;overflow:auto"><div class="empty">Loading…</div></div>
      <div id="ap-detail"></div>`;
    let pkgs = [], fg = null, sel = store.get('appSel', null);
    const list = $('#ap-list', body);
    const draw = () => {
      const f = $('#ap-q', body).value.toLowerCase();
      const shown = pkgs.filter(p => p.toLowerCase().includes(f));
      list.innerHTML = shown.length ? shown.slice(0, 400).map(p => `<div class="row ${p === sel ? 'sel' : ''}" data-p="${esc(p)}">
        ${p === fg ? '<i class="fg-dot" title="foreground"></i>' : '<span class="ico">📦</span>'}
        <span class="name mono">${esc(p)}</span>
        <span class="acts"><button class="btn sm" data-a="launch">▶</button><button class="btn sm" data-a="stop">■</button></span></div>`).join('')
        : '<div class="empty">No packages</div>';
      $$('.row', list).forEach(r => r.onclick = e => {
        const a = e.target.dataset.a;
        if (a) { appAction(r.dataset.p, a); return; }
        sel = r.dataset.p; store.set('appSel', sel); draw(); detail(sel);
      });
    };
    const load = async () => {
      try {
        const r = await devApi('/api/apps', undefined, $('#ap-sys', body).checked ? { system: 1 } : {});
        pkgs = r.packages; fg = r.foreground; draw();
        if (sel && pkgs.includes(sel)) detail(sel);
      } catch (e) { errToast(e); }
    };
    const detail = async pkg => {
      const box = $('#ap-detail', body);
      box.innerHTML = `<div class="card"><div class="empty">Loading ${esc(pkg)}…</div></div>`;
      let a;
      try { a = await devApi('/api/app', undefined, { pkg }); } catch (e) { box.innerHTML = ''; return errToast(e); }
      const perms = Object.entries(a.permissions);
      const cs = coldStarts[pkg] || [];
      box.innerHTML = `<div class="card">
        <div class="toolbar" style="margin-bottom:12px"><h3 style="margin:0;flex:1;text-transform:none;letter-spacing:0;font-size:15px;color:var(--text)" class="mono">${esc(pkg)}</h3>
        ${a.debuggable ? '<span class="tag usb">debuggable</span>' : ''}${a.pid ? `<span class="tag wifi">running · pid ${esc(a.pid)}</span>` : '<span class="tag">stopped</span>'}</div>
        <div class="kv">
          <span class="k">Version</span><span class="v">${esc(a.version)} (${esc(a.code)})</span>
          <span class="k">SDK</span><span class="v">min ${esc(a.minSdk || '?')} · target ${esc(a.targetSdk || '?')}</span>
          <span class="k">Installed</span><span class="v">${esc(a.installed || '—')}</span>
          <span class="k">Updated</span><span class="v">${esc(a.updated || '—')}</span>
          <span class="k">Installer</span><span class="v">${esc(a.installer || '—')}</span>
          <span class="k">Path</span><span class="v">${esc(a.path || '—')}</span>
        </div>
        <div class="actions" style="margin-top:14px">
          <button class="btn sm primary" data-a="launch">▶ Launch</button>
          <button class="btn sm" data-a="restart">↻ Restart</button>
          <button class="btn sm" data-a="stop">■ Force stop</button>
          <button class="btn sm" data-a="coldstart">⏱ Cold start time</button>
          <button class="btn sm" data-a="logcat">📜 Logcat</button>
          <button class="btn sm" data-a="watch">📊 Watch perf</button>
          <button class="btn sm" data-a="settings">⚙ App info</button>
          <button class="btn sm" data-a="apk">⬇ APK</button>
          <button class="btn sm danger" data-a="clear">Clear data</button>
          <button class="btn sm danger" data-a="uninstall">Uninstall</button>
        </div>
        ${cs.length ? `<div style="margin-top:14px;display:flex;align-items:baseline;gap:14px"><span class="big-num">${Math.round(cs.reduce((a, b) => a + b) / cs.length)} ms</span>
          <span class="muted">avg cold start of ${cs.length} run(s): ${cs.join(', ')} ms</span></div>` : ''}
      </div>
      ${perms.length ? `<div class="card"><h3>Runtime permissions</h3>${perms.map(([p, g]) => `<div class="perm"><span title="${esc(p)}">${esc(p.replace(/^android\.permission\./, ''))}</span>
        <label class="switch"><input type="checkbox" data-perm="${esc(p)}" ${g ? 'checked' : ''}><i></i></label></div>`).join('')}</div>` : ''}`;
      $$('[data-a]', box).forEach(b => b.onclick = async () => {
        const act = b.dataset.a;
        if (act === 'logcat') return switchTab('logcat', { pkg });
        if (act === 'watch') { store.set('watchPkg', pkg); return switchTab('overview'); }
        if (act === 'apk') { const l = document.createElement('a'); l.href = dlUrl('/api/apk', { pkg }); l.click(); return; }
        if ((act === 'clear' || act === 'uninstall') &&
          !await confirmBox(act === 'clear' ? 'Clear app data?' : 'Uninstall app?', `${pkg} — this cannot be undone.`, act === 'clear' ? 'Clear data' : 'Uninstall')) return;
        b.disabled = true;
        const r = await appAction(pkg, act);
        b.disabled = false;
        if (act === 'coldstart' && r?.total_time) { (coldStarts[pkg] ||= []).push(r.total_time); detail(pkg); }
        if (act === 'uninstall') { sel = null; load(); $('#ap-detail', body).innerHTML = ''; }
        if (['launch', 'stop', 'restart', 'clear'].includes(act)) setTimeout(() => detail(pkg), 800);
      });
      $$('[data-perm]', box).forEach(i => i.onchange = async () => {
        try {
          const r = await devApi('/api/app/action', { method: 'POST', body: { pkg, action: i.checked ? 'grant' : 'revoke', perm: i.dataset.perm } });
          if (r.out) { toast(r.out, 'err'); i.checked = !i.checked; } else toast(`${i.checked ? 'Granted' : 'Revoked'} ${i.dataset.perm.split('.').pop()}`, 'ok');
        } catch (e) { errToast(e); i.checked = !i.checked; }
      });
    };
    $('#ap-q', body).oninput = draw;
    $('#ap-sys', body).onchange = load;
    $('#ap-file', body).onchange = e => [...e.target.files].forEach(f => uploadFile(f));
    load();
  },
};

async function appAction(pkg, action) {
  try {
    const r = await devApi('/api/app/action', { method: 'POST', body: { pkg, action } });
    const msg = r.total_time ? `⏱ ${pkg} cold start: ${r.total_time} ms` : `${action}: ${r.out || 'done'}`;
    toast(msg, /fail|error|exception/i.test(r.out) ? 'err' : 'ok');
    return r;
  } catch (e) { errToast(e); }
}

/* ─────────── Files ─────────── */
const PREVIEW_IMG = /\.(png|jpe?g|gif|webp|bmp)$/i, PREVIEW_TXT = /\.(txt|log|json|xml|md|csv|ini|prop|conf|sh|yml|yaml|html|js|kt|java|trace)$/i, PREVIEW_VID = /\.(mp4|webm|3gp)$/i;
TABS.files = {
  label: '📁 Files',
  render(body) {
    let path = store.get('filesPath', '/sdcard');
    body.innerHTML = `
      <div class="toolbar">
        <select id="fl-loc" title="Quick locations">
          <option value="">Jump to…</option>
          ${['/sdcard', '/sdcard/Download', '/sdcard/DCIM/Camera', '/sdcard/Pictures', '/sdcard/Movies', '/sdcard/Android/data', '/data/local/tmp', '/system'].map(p => `<option>${p}</option>`).join('')}
        </select>
        <button class="btn sm" id="fl-up">↑ Up</button>
        <button class="btn sm" id="fl-refresh">↻</button>
        <span style="flex:1"></span>
        <button class="btn sm" id="fl-mkdir">＋ Folder</button>
        <label class="btn sm primary" style="cursor:pointer">⬆ Upload<input type="file" multiple hidden id="fl-file"></label>
      </div>
      <div class="crumbs" id="fl-crumbs"></div>
      <div class="list" id="fl-list"><div class="empty">Loading…</div></div>`;
    const list = $('#fl-list', body);
    const go = async p => {
      path = p.replace(/\/+$/, '') || '/';
      store.set('filesPath', path);
      const parts = path.split('/').filter(Boolean);
      $('#fl-crumbs', body).innerHTML = `<button data-p="/">/</button>` +
        parts.map((x, i) => `<span class="dim">›</span><button data-p="/${esc(parts.slice(0, i + 1).join('/'))}">${esc(x)}</button>`).join('');
      $$('#fl-crumbs button', body).forEach(b => b.onclick = () => go(b.dataset.p));
      list.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const r = await devApi('/api/files', undefined, { path });
        if (!r.entries.length) { list.innerHTML = '<div class="empty">Empty folder (or no permission)</div>'; return; }
        list.innerHTML = r.entries.map(e => `<div class="row" data-n="${esc(e.name)}" data-d="${e.dir ? 1 : 0}">
          <span class="ico">${e.dir ? '📁' : PREVIEW_IMG.test(e.name) ? '🖼' : PREVIEW_VID.test(e.name) ? '🎞' : /\.apk$/i.test(e.name) ? '📦' : '📄'}</span>
          <span class="name">${esc(e.name)}</span>
          <span class="acts">${e.dir ? '' : '<button class="btn sm" data-a="dl" title="Download">⬇</button>'}
            <button class="btn sm" data-a="mv" title="Rename">✎</button><button class="btn sm danger" data-a="rm" title="Delete">🗑</button></span>
          <span class="meta">${e.dir ? '' : fmtBytes(e.size)}</span>
          <span class="meta" style="width:110px;text-align:right">${fmtDate(e.mtime)}</span></div>`).join('');
        $$('.row', list).forEach(row => row.onclick = async ev => {
          const name = row.dataset.n, full = `${path === '/' ? '' : path}/${name}`, a = ev.target.dataset.a;
          if (a === 'dl') return download(full);
          if (a === 'rm') {
            if (await confirmBox('Delete?', full, 'Delete')) fileOp({ op: 'delete', path: full }).then(() => go(path));
            return;
          }
          if (a === 'mv') {
            const to = prompt('Rename to', name);
            if (to && to !== name) fileOp({ op: 'rename', path: full, to: `${path === '/' ? '' : path}/${to}` }).then(() => go(path));
            return;
          }
          if (row.dataset.d === '1') go(full); else preview(full, name);
        });
      } catch (e) { list.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    };
    const download = full => { const l = document.createElement('a'); l.href = dlUrl('/api/file', { path: full }); l.click(); };
    const preview = async (full, name) => {
      if (!(PREVIEW_IMG.test(name) || PREVIEW_TXT.test(name) || PREVIEW_VID.test(name))) return download(full);
      const c = openModal(`<h2>${esc(name)}</h2><p class="mono">${esc(full)}</p><div id="pv" class="empty">Loading…</div>
        <div class="foot"><button class="btn" data-dl>⬇ Download</button><button class="btn primary" data-x>Close</button></div>`, { wide: true });
      $('[data-x]', c).onclick = closeModal;
      $('[data-dl]', c).onclick = () => download(full);
      const url = dlUrl('/api/file', { path: full });
      const pv = $('#pv', c);
      if (PREVIEW_IMG.test(name)) pv.outerHTML = `<img class="preview-img" src="${esc(url)}">`;
      else if (PREVIEW_VID.test(name)) pv.outerHTML = `<video class="preview-img" src="${esc(url)}" controls autoplay></video>`;
      else {
        const r = await fetch(url); const t = await r.text();
        pv.className = 'preview-text'; pv.textContent = t.length > 500000 ? t.slice(0, 500000) + '\n…(truncated)' : t;
      }
    };
    $('#fl-loc', body).onchange = e => { if (e.target.value) go(e.target.value); e.target.value = ''; };
    $('#fl-up', body).onclick = () => go(path.split('/').slice(0, -1).join('/') || '/');
    $('#fl-refresh', body).onclick = () => go(path);
    $('#fl-mkdir', body).onclick = () => {
      const n = prompt('New folder name');
      if (n) fileOp({ op: 'mkdir', path: `${path}/${n}` }).then(() => go(path));
    };
    $('#fl-file', body).onchange = async e => { for (const f of e.target.files) await uploadFile(f, path); go(path); };
    TABS.files.refresh = () => go(path);
    go(path);
    return () => { TABS.files.refresh = null; };
  },
};
async function fileOp(b) {
  try { const r = await devApi('/api/file/op', { method: 'POST', body: b }); toast(r.ok ? 'Done' : r.out, r.ok ? 'ok' : 'err'); }
  catch (e) { errToast(e); }
}

function uploadFile(file, dir = '/sdcard/Download') {
  const isApk = /\.apk$/i.test(file.name);
  const url = isApk ? q('/api/install') : q('/api/file', { path: dir });
  const t = toast(`${isApk ? 'Installing' : 'Uploading'} ${file.name}… 0%`, 'info', { timeout: 0 });
  return new Promise(res => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('X-Token', TOKEN);
    x.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    x.upload.onprogress = e => { $('.tx', t).textContent = `Uploading ${file.name}… ${Math.round(e.loaded / e.total * 100)}%${isApk && e.loaded === e.total ? ' — installing' : ''}`; };
    x.onload = () => {
      t.remove();
      let r = {}; try { r = JSON.parse(x.responseText); } catch { /* ignore */ }
      if (r.ok) toast(isApk ? `✅ Installed ${file.name}` : `✅ Uploaded to ${dir}/${file.name}`, 'ok');
      else toast(`${file.name}: ${r.out || r.error || 'failed'}`, 'err', { timeout: 8000 });
      res(r);
    };
    x.onerror = () => { t.remove(); toast(`Upload failed: ${file.name}`, 'err'); res({}); };
    x.send(file);
  });
}

/* ─────────── Inspector ─────────── */
const Inspector = {
  nodes: [], dump: null, sel: null, on: false,
  clear() { this.nodes = []; this.dump = null; this.sel = null; this.draw(); },
  async capture() {
    const r = await devApi('/api/ui');
    const doc = new DOMParser().parseFromString(r.xml, 'text/xml');
    const out = [];
    const walk = (n, depth) => {
      for (const c of n.children) {
        if (c.tagName !== 'node') continue;
        const m = (c.getAttribute('bounds') || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
        const a = {}; for (const at of c.attributes) a[at.name] = at.value;
        const b = m ? m.slice(1).map(Number) : [0, 0, 0, 0];
        out.push({ a, b, depth, idx: out.length, area: (b[2] - b[0]) * (b[3] - b[1]) });
        walk(c, depth + 1);
      }
    };
    walk(doc.documentElement, 0);
    let W = r.width, H = r.height;
    if (!W && out.length) { W = Math.max(...out.map(n => n.b[2])); H = Math.max(...out.map(n => n.b[3])); }
    this.dump = { W, H, activity: r.activity };
    this.nodes = out; this.sel = null;
    this.draw();
    return this.nodes;
  },
  layout() {
    const c = mirror.canvas, L = $('#inspect-layer');
    L.style.left = `${c.offsetLeft + c.clientLeft}px`; L.style.top = `${c.offsetTop + c.clientTop}px`;
    L.style.width = `${c.clientWidth}px`; L.style.height = `${c.clientHeight}px`;
  },
  toggle(force) {
    this.on = force ?? !this.on;
    $('#inspect-layer').classList.toggle('on', this.on);
    $('#btn-inspect').classList.toggle('on', this.on);
    this.layout();
    if (this.on && !this.nodes.length) this.capture().then(() => toast('UI captured — hover the screen to inspect', 'ok')).catch(errToast);
    if (this.on && state.tab !== 'inspector') switchTab('inspector');
    this.draw();
  },
  at(fx, fy) {
    if (!this.dump) return null;
    const x = fx * this.dump.W, y = fy * this.dump.H;
    let best = null;
    for (const n of this.nodes) {
      const [l, t, r, b] = n.b;
      if (x >= l && x <= r && y >= t && y <= b && n.area > 0 && (!best || n.area <= best.area)) best = n;
    }
    return best;
  },
  box(n, cls) {
    const { W, H } = this.dump, [l, t, r, b] = n.b;
    return `<div class="inspect-box ${cls}" style="left:${l / W * 100}%;top:${t / H * 100}%;width:${(r - l) / W * 100}%;height:${(b - t) / H * 100}%"></div>`;
  },
  draw(hover) {
    const L = $('#inspect-layer');
    if (!this.on || !this.dump) { L.innerHTML = ''; return; }
    let s = '';
    if (this.sel) s += this.box(this.sel, 'sel');
    if (hover && hover !== this.sel) {
      s += this.box(hover, '');
      const id = hover.a['resource-id']?.split('/').pop();
      const lbl = `${hover.a.class?.split('.').pop()}${id ? ' #' + id : ''}${hover.a.text ? ` "${hover.a.text.slice(0, 30)}"` : ''}`;
      const [l, t] = hover.b;
      s += `<div class="inspect-tip" style="left:${Math.min(l / this.dump.W * 100, 60)}%;top:calc(${t / this.dump.H * 100}% - 22px)">${esc(lbl)}</div>`;
    }
    L.innerHTML = s;
  },
  select(n) {
    this.sel = n; this.draw();
    if (state.tab === 'inspector') TABS.inspector.showNode?.(n);
  },
};
(() => {
  const L = $('#inspect-layer');
  const rel = e => { const r = L.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  L.addEventListener('mousemove', e => Inspector.draw(Inspector.at(...rel(e))));
  L.addEventListener('mouseleave', () => Inspector.draw());
  L.addEventListener('click', e => { const n = Inspector.at(...rel(e)); if (n) Inspector.select(n); });
})();

TABS.inspector = {
  label: '🔍 Inspector',
  render(body) {
    body.innerHTML = `
      <div class="toolbar">
        <button class="btn primary" id="in-cap">⟳ Capture UI</button>
        <button class="btn" id="in-toggle">${Inspector.on ? '✓ Inspecting screen' : '⌖ Inspect on screen'}</button>
        <input class="grow" id="in-q" placeholder="Find by text, id, class…">
      </div>
      <div class="hint" id="in-act"></div>
      <div class="card" style="padding:6px"><div class="tree" id="in-tree"><div class="empty">Press <b>Capture UI</b> to dump the view hierarchy (uiautomator).</div></div></div>
      <div id="in-node"></div>`;
    const tree = $('#in-tree', body);
    const drawTree = () => {
      if (!Inspector.nodes.length) return;
      $('#in-act', body).innerHTML = Inspector.dump?.activity ? `Activity: <span class="mono">${esc(Inspector.dump.activity)}</span> · ${Inspector.nodes.length} nodes` : '';
      const f = $('#in-q', body).value.toLowerCase();
      tree.innerHTML = Inspector.nodes.filter(n => !f || JSON.stringify(n.a).toLowerCase().includes(f)).slice(0, 1500).map(n => {
        const id = n.a['resource-id']?.split('/').pop();
        return `<div class="tn ${n === Inspector.sel ? 'sel' : ''}" data-i="${n.idx}" style="padding-left:${8 + (f ? 0 : n.depth * 12)}px">
          <span class="c">${esc(n.a.class?.split('.').pop())}</span>${id ? ` <span class="i">#${esc(id)}</span>` : ''}${n.a.text ? ` <span class="x">"${esc(n.a.text.slice(0, 40))}"</span>` : ''}${n.a['content-desc'] ? ` <span class="dim">[${esc(n.a['content-desc'].slice(0, 30))}]</span>` : ''}</div>`;
      }).join('');
      $$('.tn', tree).forEach(t => {
        t.onclick = () => Inspector.select(Inspector.nodes[t.dataset.i]);
        t.onmouseenter = () => Inspector.on && Inspector.draw(Inspector.nodes[t.dataset.i]);
      });
    };
    TABS.inspector.showNode = n => {
      drawTree();
      $('.tn.sel', tree)?.scrollIntoView({ block: 'nearest' });
      const a = n.a, id = a['resource-id'] || '', short = id.split('/').pop(), [l, t, r, b] = n.b;
      const cx = Math.round((l + r) / 2), cy = Math.round((t + b) / 2);
      const snippets = [
        id && ['Espresso', `onView(withId(R.id.${short})).perform(click())`],
        a.text && ['Espresso', `onView(withText("${a.text}")).perform(click())`],
        id && ['UiAutomator', `device.findObject(By.res("${id}"))`],
        a.text && ['UiAutomator', `device.findObject(By.text("${a.text}"))`],
        ['Compose', a.text ? `composeTestRule.onNodeWithText("${a.text}").performClick()` : (a['content-desc'] ? `composeTestRule.onNodeWithContentDescription("${a['content-desc']}").performClick()` : null)],
        ['Appium XPath', `//${a.class}${id ? `[@resource-id="${id}"]` : a.text ? `[@text="${a.text}"]` : ''}`],
        ['Maestro', a.text ? `- tapOn: "${a.text}"` : id ? `- tapOn:\n    id: "${short}"` : `- tapOn:\n    point: "${cx},${cy}"`],
        ['adb', `adb shell input tap ${cx} ${cy}`],
      ].filter(s => s && s[1]);
      $('#in-node', body).innerHTML = `<div class="card"><h3>Selected node</h3>
        <div class="kv">${['class', 'resource-id', 'text', 'content-desc', 'package', 'bounds', 'clickable', 'enabled', 'focused', 'scrollable', 'checked', 'selected']
          .filter(k => a[k] !== undefined && a[k] !== '').map(k => `<span class="k">${k}</span><span class="v">${esc(a[k])}</span>`).join('')}
          <span class="k">size</span><span class="v">${r - l} × ${b - t} px</span></div>
        <h3 style="margin-top:16px">Test selectors</h3>
        ${snippets.map(([lbl, code]) => `<div class="snip"><span class="lbl">${lbl}</span><code>${esc(code)}</code><button class="btn sm" data-c="${esc(code)}">Copy</button></div>`).join('')}
        <div class="actions" style="margin-top:12px"><button class="btn sm" id="in-tap">👆 Tap it</button></div></div>`;
      $$('[data-c]', body).forEach(b => b.onclick = () => copyText(b.dataset.c));
      $('#in-tap', body).onclick = async () => { await shell(`input tap ${cx} ${cy}`); setTimeout(() => Inspector.capture().then(drawTree), 900); };
    };
    const cap = async () => {
      $('#in-cap', body).disabled = true;
      try { await Inspector.capture(); drawTree(); } catch (e) { errToast(e); }
      $('#in-cap', body).disabled = false;
    };
    $('#in-cap', body).onclick = cap;
    $('#in-toggle', body).onclick = e => { Inspector.toggle(); e.target.textContent = Inspector.on ? '✓ Inspecting screen' : '⌖ Inspect on screen'; };
    $('#in-q', body).oninput = drawTree;
    if (Inspector.nodes.length) { drawTree(); if (Inspector.sel) TABS.inspector.showNode(Inspector.sel); } else cap();
    return () => { TABS.inspector.showNode = null; };
  },
};

/* ─────────── Dev toggles ─────────── */
const TOGGLE_HINTS = {
  layout_bounds: 'Draw view bounds, margins and paddings', show_taps: 'Visual feedback for touches',
  pointer_location: 'Overlay with touch coordinates', gpu_overdraw: 'Color-code overdraw (blue → red)',
  gpu_profile: 'On-screen rendering time bars', dont_keep: 'Destroy activities when leaving — tests state restore',
  force_rtl: 'Mirror layouts for RTL languages (فارسی/عربی). Restart the app after toggling',
  stay_awake: 'Screen never sleeps while charging', dark_mode: 'System night mode (Android 10+)',
  demo_mode: 'Clean status bar for store screenshots: 12:00, full battery & signal',
  animations: 'Window, transition & animator scale — 0 speeds up UI tests', font_scale: 'Test large-text accessibility',
  density: 'Simulate smaller / bigger screens',
};
TABS.toggles = {
  label: '🧪 Dev toggles',
  render(body) {
    body.innerHTML = `<div class="card" style="padding:0" id="tg-list"><div class="empty">Reading device settings…</div></div>
      <div class="hint">Toggles change real device settings. Most apply instantly; some need the app to be restarted.</div>`;
    devApi('/api/toggles').then(list => {
      $('#tg-list', body).innerHTML = list.map(t => `<div class="toggle-row"><div><div class="t">${esc(t.label)}</div><div class="d">${esc(TOGGLE_HINTS[t.key] || '')}</div></div>
        ${t.kind === 'bool' ? `<label class="switch"><input type="checkbox" data-k="${t.key}" ${t.value ? 'checked' : ''}><i></i></label>`
          : `<select data-k="${t.key}">${t.options.map(o => `<option ${String(o) === String(t.value) ? 'selected' : ''}>${o}</option>`).join('')}
             ${t.options.includes(String(t.value)) ? '' : `<option selected>${esc(t.value)}</option>`}</select>`}</div>`).join('');
      $$('[data-k]', body).forEach(i => i.onchange = async () => {
        const value = i.type === 'checkbox' ? i.checked : i.value;
        try { await devApi('/api/toggles', { method: 'POST', body: { key: i.dataset.k, value } }); toast(`${i.closest('.toggle-row').querySelector('.t').textContent}: ${value === true ? 'on' : value === false ? 'off' : value}`, 'ok', { timeout: 1800 }); }
        catch (e) { errToast(e); }
      });
    }).catch(errToast);
  },
};
async function flipToggle(key) {
  const list = await devApi('/api/toggles');
  const t = list.find(x => x.key === key);
  await devApi('/api/toggles', { method: 'POST', body: { key, value: !t.value } });
  toast(`${t.label}: ${!t.value ? 'on' : 'off'}`, 'ok');
  if (state.tab === 'toggles') renderTab();
}

/* ─────────── Network ─────────── */
TABS.network = {
  label: '🔌 Network',
  render(body) {
    body.innerHTML = `
      <div class="card"><h3>adb reverse — device → your computer</h3>
        <div class="hint" style="margin-bottom:10px">Let the app on the phone reach a dev server on this machine at <span class="mono">localhost</span>.</div>
        <div class="chips" style="margin-bottom:10px">${[['Metro (RN)', 8081], ['Vite', 5173], ['Next/Node', 3000], ['Django', 8000], ['Flask', 5000], ['Tomcat', 8080], ['Flutter DevTools', 9100]]
          .map(([n, p]) => `<span class="chip" data-rev="${p}">${n} · ${p}</span>`).join('')}</div>
        <div class="toolbar"><input id="rv-l" placeholder="tcp:3000 (device)" style="width:150px"><span class="dim">→</span><input id="rv-r" placeholder="tcp:3000 (computer)" style="width:150px"><button class="btn" id="rv-add">Add</button></div>
        <div class="list" id="rv-list" style="margin-top:10px"></div></div>
      <div class="card"><h3>adb forward — computer → device</h3>
        <div class="toolbar"><input id="fw-l" placeholder="tcp:9222 (computer)" style="width:150px"><span class="dim">→</span><input id="fw-r" placeholder="localabstract:chrome_devtools_remote" class="grow"><button class="btn" id="fw-add">Add</button></div>
        <div class="chips" style="margin-top:8px"><span class="chip" data-fw="tcp:9222|localabstract:chrome_devtools_remote">Chrome DevTools · 9222</span></div>
        <div class="list" id="fw-list" style="margin-top:10px"></div></div>
      <div class="card"><h3>Deep link / intent tester</h3>
        <div class="toolbar"><input class="grow" id="dl-uri" placeholder="myapp://product/42  or  https://example.com/path"><input id="dl-pkg" placeholder="package (optional)" style="width:170px"><button class="btn primary" id="dl-go">Open</button></div>
        <div class="chips" id="dl-hist" style="margin-top:8px"></div><div id="dl-res"></div></div>
      <div class="card"><h3>Send broadcast</h3>
        <div class="toolbar"><input class="grow" id="bc-a" placeholder="com.example.ACTION_REFRESH"><button class="btn" id="bc-go">Send</button></div><div id="bc-res"></div></div>`;
    const load = async () => {
      try {
        const r = await devApi('/api/ports');
        const draw = (el, items, kind) => {
          el.innerHTML = items.length ? items.map(p => `<div class="row"><span class="name mono">${esc(p.local)} → ${esc(p.remote)}</span>
            <button class="btn sm danger" data-rm="${esc(p.local)}">Remove</button></div>`).join('') : '<div class="empty" style="padding:12px">None</div>';
          $$('[data-rm]', el).forEach(b => b.onclick = () => port(kind, b.dataset.rm, '', true));
        };
        draw($('#rv-list', body), r.reverse, 'reverse');
        draw($('#fw-list', body), r.forward, 'forward');
      } catch (e) { errToast(e); }
    };
    const port = async (kind, local, remote, remove = false) => {
      const fix = s => /^\d+$/.test(s) ? `tcp:${s}` : s;
      try {
        const r = await devApi('/api/ports', { method: 'POST', body: { kind, local: fix(local), remote: fix(remote || local), remove } });
        toast(r.ok ? `${kind} ${remove ? 'removed' : 'added'}` : r.out, r.ok ? 'ok' : 'err');
      } catch (e) { errToast(e); }
      load();
    };
    $$('[data-rev]', body).forEach(c => c.onclick = () => port('reverse', c.dataset.rev, c.dataset.rev));
    $$('[data-fw]', body).forEach(c => c.onclick = () => { const [l, r] = c.dataset.fw.split('|'); port('forward', l, r); });
    $('#rv-add', body).onclick = () => port('reverse', $('#rv-l', body).value, $('#rv-r', body).value);
    $('#fw-add', body).onclick = () => port('forward', $('#fw-l', body).value, $('#fw-r', body).value);

    const hist = () => {
      const h = store.get('deeplinks', []);
      $('#dl-hist', body).innerHTML = h.map(u => `<span class="chip" data-u="${esc(u)}">${esc(u.length > 50 ? u.slice(0, 50) + '…' : u)}</span>`).join('');
      $$('[data-u]', body).forEach(c => c.onclick = () => { $('#dl-uri', body).value = c.dataset.u; open(); });
    };
    const open = async () => {
      const uri = $('#dl-uri', body).value.trim();
      if (!uri) return;
      store.set('deeplinks', [uri, ...store.get('deeplinks', []).filter(x => x !== uri)].slice(0, 10));
      hist();
      try {
        const r = await devApi('/api/intent', { method: 'POST', body: { uri, pkg: $('#dl-pkg', body).value.trim() } });
        $('#dl-res', body).innerHTML = `${r.total_time ? `<div style="margin-top:10px"><span class="big-num">${r.total_time} ms</span> <span class="muted">to display</span></div>` : ''}<div class="result"></div>`;
        $('.result', $('#dl-res', body)).textContent = r.out;
      } catch (e) { errToast(e); }
    };
    $('#dl-go', body).onclick = open;
    $('#dl-uri', body).onkeydown = e => e.key === 'Enter' && open();
    $('#bc-go', body).onclick = async () => {
      const r = await devApi('/api/broadcast', { method: 'POST', body: { action: $('#bc-a', body).value.trim() } });
      $('#bc-res', body).innerHTML = '<div class="result"></div>'; $('.result', $('#bc-res', body)).textContent = r.out;
    };
    hist(); load();
  },
};

/* ─────────── Shell ─────────── */
const SNIPPETS = [
  ['focus', "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"],
  ['props', 'getprop | head -60'], ['top', 'top -b -n 1 | head -20'], ['packages', 'pm list packages -3'],
  ['disk', 'df -h'], ['battery', 'dumpsys battery'], ['wifi', 'ip addr show wlan0'],
  ['activities', 'dumpsys activity activities | grep -E "Run #|mResumed"'], ['display', 'wm size; wm density; dumpsys display | grep mBaseDisplayInfo | head -1'],
  ['ps', 'ps -A | head -40'], ['settings', 'settings list global | head -50'],
];
const shellHistory = store.get('shellHist', []);
TABS.shell = {
  label: '⌨ Shell',
  render(body) {
    body.innerHTML = `<div class="chips">${SNIPPETS.map(([n, c]) => `<span class="chip" data-c="${esc(c)}" title="${esc(c)}">${n}</span>`).join('')}</div>
      <div class="term" id="sh-out"><span class="meta">adb shell on ${esc(state.serial)} — ↑/↓ history, Ctrl+L clear\n\n</span></div>
      <div class="term-input"><input id="sh-in" placeholder="command…" autocomplete="off" spellcheck="false"><button class="btn primary" id="sh-go">Run</button></div>`;
    const out = $('#sh-out', body), inp = $('#sh-in', body);
    let hi = shellHistory.length;
    const run = async cmd => {
      cmd = cmd.trim(); if (!cmd) return;
      if (shellHistory[shellHistory.length - 1] !== cmd) shellHistory.push(cmd);
      if (shellHistory.length > 100) shellHistory.shift();
      store.set('shellHist', shellHistory); hi = shellHistory.length;
      const c = document.createElement('div'); c.className = 'cmd'; c.textContent = cmd; out.append(c);
      const res = document.createElement('div'); res.textContent = '…'; out.append(res);
      out.scrollTop = out.scrollHeight; inp.value = '';
      try {
        const r = await devApi('/api/shell', { method: 'POST', body: { cmd, timeout: 60 } });
        res.textContent = r.out || '';
        if (r.rc) res.className = 'err';
        const m = document.createElement('div'); m.className = 'meta'; m.textContent = `exit ${r.rc} · ${r.ms} ms\n`; out.append(m);
      } catch (e) { res.textContent = e.message; res.className = 'err'; }
      out.scrollTop = out.scrollHeight;
    };
    $('#sh-go', body).onclick = () => run(inp.value);
    inp.onkeydown = e => {
      if (e.key === 'Enter') run(inp.value);
      else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); inp.value = shellHistory[hi] || ''; e.preventDefault(); }
      else if (e.key === 'ArrowDown') { hi = Math.min(shellHistory.length, hi + 1); inp.value = shellHistory[hi] || ''; e.preventDefault(); }
      else if (e.key === 'l' && e.ctrlKey) { out.innerHTML = ''; e.preventDefault(); }
    };
    $$('[data-c]', body).forEach(c => c.onclick = () => run(c.dataset.c));
    inp.focus();
  },
};

/* ════════════════════════════ navbar & native ════════════════════════════ */

function bindNavbar() {
  $$('#navbar [data-key]').forEach(b => b.onclick = () => {
    const k = +b.dataset.key;
    if (k === 4) { mirror.send(Ctl.back(0)); mirror.send(Ctl.back(1)); } else mirror.key(k);
  });
  const acts = {
    screenoff: () => { mirror.send(Ctl.displayPower(false)); toast('Phone screen off — mirroring continues. Press ⏻ to wake.', 'info'); },
    rotate: () => mirror.send(Ctl.rotate()),
    notif: () => mirror.send(Ctl.notif()),
    shot: downloadShot,
    copyframe: () => mirror.canvas.toBlob(b => navigator.clipboard.write([new ClipboardItem({ 'image/png': b })])
      .then(() => toast('Frame copied to clipboard', 'ok')).catch(() => toast('Clipboard not available here', 'err'))),
    record: () => Recorder.toggle(),
    inspect: () => Inspector.toggle(),
    fullscreen: () => document.fullscreenElement ? document.exitFullscreen() : $('#phone').requestFullscreen(),
  };
  $$('#navbar [data-act]').forEach(b => b.onclick = () => acts[b.dataset.act]());

  const PRESETS = [['mirror', 'Smart mirror'], ['game', 'Game · 120fps low latency'], ['hq', 'High quality'], ['low', 'Low bandwidth'],
    ['present', 'Presentation · show touches'], ['stealth', 'Stealth · phone screen off'], ['desktop', 'Desktop · virtual 1080p'], ['rec', 'Record to ~/Movies']];
  const menu = $('#native-menu');
  menu.innerHTML = PRESETS.map(([k, l]) => `<button data-p="${k}">${esc(l)}<small>mahdicpy ${k}</small></button>`).join('');
  $('#btn-native').onclick = e => { e.stopPropagation(); menu.classList.toggle('open'); };
  document.addEventListener('click', () => menu.classList.remove('open'));
  $$('button', menu).forEach(b => b.onclick = async () => {
    try { await devApi('/api/native', { method: 'POST', body: { preset: b.dataset.p } }); toast(`Opening native window (${b.dataset.p}) on the host`, 'ok'); }
    catch (e) { errToast(e); }
  });

  const qsel = $('#quality');
  qsel.value = store.get('quality', qsel.value);
  qsel.onchange = () => { store.set('quality', qsel.value); mirror.connect(state.serial, true); };
}

/* ════════════════════════════ connect modal ════════════════════════════ */

function connectModal() {
  const c = openModal(`<h2>Connect a device</h2><p>USB devices show up automatically. For wireless:</p>
    <div class="modal-sec"><h4>📶 Connect by IP</h4><div class="toolbar"><input class="grow" id="cn-ip" placeholder="192.168.1.20 or 192.168.1.20:5555"><button class="btn primary" id="cn-go">Connect</button></div>
      <div class="hint" style="margin-top:6px">Works after "adb tcpip 5555", or use "Switch to Wi-Fi" in Overview while on USB.</div></div>
    <div class="modal-sec"><h4>🔗 Pair (Android 11+)</h4>
      <div class="hint" style="margin-bottom:8px">Phone: Developer options › Wireless debugging › <b>Pair device with pairing code</b></div>
      <div class="toolbar"><input id="pr-addr" placeholder="IP:port" class="grow"><input id="pr-code" placeholder="code" style="width:100px"><button class="btn" id="pr-go">Pair</button></div>
      <div class="hint" style="margin-top:6px">Then connect using the IP:port under "IP address &amp; Port".</div></div>
    <div id="cn-res"></div>
    <div class="foot"><button class="btn" data-x>Close</button></div>`);
  $('[data-x]', c).onclick = closeModal;
  const res = (r) => { $('#cn-res', c).innerHTML = '<div class="result"></div>'; $('.result', c).textContent = r.out || r.error; };
  $('#cn-go', c).onclick = async () => {
    try { const r = await api('/api/connect', { method: 'POST', body: { target: $('#cn-ip', c).value.trim() } }); res(r); if (r.ok) { toast('Connected', 'ok'); closeModal(); refreshDevices(); } }
    catch (e) { res({ error: e.message }); }
  };
  $('#pr-go', c).onclick = async () => {
    try { const r = await api('/api/pair', { method: 'POST', body: { addr: $('#pr-addr', c).value.trim(), code: $('#pr-code', c).value.trim() } }); res(r); if (r.ok) toast('Paired — now connect with the IP:port', 'ok'); }
    catch (e) { res({ error: e.message }); }
  };
}

/* ════════════════════════════ command palette ════════════════════════════ */

function paletteCommands() {
  const cmds = [
    ...Object.entries(TABS).map(([k, t]) => [`Go to ${t.label.replace(/^\S+\s/, '')}`, 'tab', () => switchTab(k)]),
    ['Home', 'key', () => mirror.key(3)], ['Back', 'key', () => { mirror.send(Ctl.back(0)); mirror.send(Ctl.back(1)); }],
    ['Recent apps', 'key', () => mirror.key(187)], ['Power', 'key', () => mirror.key(26)],
    ['Screenshot (full res)', 'capture', downloadShot], ['Start / stop recording', 'capture', () => Recorder.toggle()],
    ['Inspect UI', 'dev', () => Inspector.toggle(true)], ['Recent crashes', 'dev', showCrashes],
    ['Toggle layout bounds', 'toggle', () => flipToggle('layout_bounds')], ['Toggle show taps', 'toggle', () => flipToggle('show_taps')],
    ['Toggle GPU overdraw', 'toggle', () => flipToggle('gpu_overdraw')], ['Toggle dark mode', 'toggle', () => flipToggle('dark_mode')],
    ['Toggle demo mode (clean status bar)', 'toggle', () => flipToggle('demo_mode')], ['Toggle RTL layout', 'toggle', () => flipToggle('force_rtl')],
    ['Toggle don\'t keep activities', 'toggle', () => flipToggle('dont_keep')],
    ['Rotate device', 'key', () => mirror.send(Ctl.rotate())], ['Notification panel', 'key', () => mirror.send(Ctl.notif())],
    ['Restart stream', 'stream', () => mirror.connect(state.serial, true)], ['Switch to Wi-Fi', 'device', goWireless],
    ['Connect device…', 'device', connectModal],
    ...state.devices.filter(d => d.state === 'device').map(d => [`Switch to ${d.name || d.serial}`, 'device', () => selectDevice(d.serial)]),
    ...state.apps.slice(0, 300).map(p => [`Launch ${p}`, 'app', () => appAction(p, 'launch')]),
  ];
  return cmds;
}
function openPalette() {
  if (state.role !== 'admin') return;
  const P = $('#palette'), inp = $('#palette-input'), list = $('#palette-list');
  P.classList.remove('hidden'); inp.value = ''; inp.focus();
  if (!state.apps.length && state.serial) devApi('/api/apps').then(r => { state.apps = r.packages; draw(); }).catch(() => {});
  let sel = 0, items = [];
  const fuzzy = (s, qq) => { let i = 0; s = s.toLowerCase(); for (const ch of qq) { i = s.indexOf(ch, i); if (i < 0) return false; i++; } return true; };
  const draw = () => {
    const qq = inp.value.toLowerCase().replace(/\s+/g, '');
    items = paletteCommands().filter(c => fuzzy(c[0], qq)).slice(0, 60);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items.map((c, i) => `<div class="pi ${i === sel ? 'sel' : ''}" data-i="${i}">${esc(c[0])}<span>${c[1]}</span></div>`).join('') || '<div class="empty">No match</div>';
    $$('.pi', list).forEach(el => el.onclick = () => run(+el.dataset.i));
    $('.pi.sel', list)?.scrollIntoView({ block: 'nearest' });
  };
  const run = i => { close(); items[i]?.[2](); };
  const close = () => { P.classList.add('hidden'); inp.onkeydown = null; };
  inp.oninput = () => { sel = 0; draw(); };
  inp.onkeydown = e => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') run(sel);
    else if (e.key === 'Escape') close();
  };
  P.onmousedown = e => { if (e.target === P) close(); };
  draw();
}

/* ════════════════════════════ drag & drop ════════════════════════════ */

function bindDrop() {
  let depth = 0;
  const D = $('#drop');
  window.addEventListener('dragenter', e => { if (state.role === 'admin' && e.dataTransfer?.types.includes('Files')) { depth++; D.classList.remove('hidden'); } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; D.classList.add('hidden'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault(); depth = 0; D.classList.add('hidden');
    if (!state.serial || state.role !== 'admin') return;
    for (const f of e.dataTransfer.files) await uploadFile(f);
    TABS.files.refresh?.();
  });
}

/* ════════════════════════════ share box ════════════════════════════ */

function renderShare(me) {
  const box = $('#share-box');
  const u = me.urls;
  const isLocal = /^(127\.|localhost)/.test(new URL(u.admin).hostname);
  box.innerHTML = isLocal
    ? `<div class="hint" style="padding:0 4px">Share with your team: run <span class="mono">mahdicpy web --lan</span></div>`
    : `<div class="share-row" data-u="${esc(u.admin)}"><b>🔑 Full access link</b><span>copy</span></div>
       <div class="share-row" data-u="${esc(u.view)}"><b>👁 View-only link</b><span>copy</span></div>`;
  $$('[data-u]', box).forEach(r => r.onclick = () => copyText(r.dataset.u));
}

/* ════════════════════════════ boot ════════════════════════════ */

async function boot() {
  let me;
  try { me = await api('/api/me'); } catch { return; }
  state.role = me.role;
  $('#role-badge').textContent = me.role === 'admin' ? 'full access' : 'view only';
  $('#role-badge').classList.toggle('view', me.role !== 'admin');
  $('#version').textContent = `v${me.version} · scrcpy ${me.scrcpy}`;
  document.body.classList.toggle('viewer', me.role !== 'admin');
  if (me.role === 'admin') {
    renderShare(me);
    mirror.bindInput();
    bindNavbar();
    bindDrop();
    renderTabs();
    const fab = html('<button class="tools-fab" title="Developer tools">🛠</button>');
    fab.onclick = () => document.body.classList.toggle('tools-open');
    document.body.append(fab);
    $('#btn-connect').onclick = connectModal;
    $('#btn-palette').onclick = openPalette;
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
      if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
      if (e.key === 'Escape' && Inspector.on && document.activeElement !== mirror.canvas) Inspector.toggle(false);
    });
  }
  await refreshDevices();
  if (!state.serial) mirror.status('idle', state.devices.length ? 'Device not ready — check the phone' : 'Connect an Android device via USB or Wi-Fi');
  setInterval(refreshDevices, 4000);
}
boot();

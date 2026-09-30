(() => {
  'use strict';

  // ---------- constants ----------
  const KEY = 'nanopomodoro:v1';
  const RATE = 2;      // bases per second shown (a real pore does ~400 b/s)
  const SP = 11;       // px between bases along the strand
  const OPEN_PORE = 215; // pA
  const MODES = {
    focus: { label: 'Focus', run: 'Sequencing run' },
    short: { label: 'Short break', run: 'Pore flush · short break' },
    long: { label: 'Long break', run: 'Flow cell wash · long break' },
  };
  const DEFAULTS = { focus: 25, short: 5, long: 15, every: 4, auto: false, sound: true };
  const BASES = 'ACGT';
  const COLORS = { A: '#3ecf8e', C: '#4c8dff', G: '#f5b83d', T: '#ff5d6c' };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);

  // ---------- deterministic randomness ----------
  function h32(a, b) {
    let x = (a ^ Math.imul(b | 0, 0x9e3779b1)) >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b);
    x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    return x >>> 0;
  }
  const newSeed = () => (Math.random() * 2 ** 32) >>> 0;
  const baseIdx = (i) => h32(state.seed, i) & 3;
  const baseAt = (i) => BASES[baseIdx(i)];

  // ---------- state (persisted, timestamp based) ----------
  function fresh() {
    return {
      settings: { ...DEFAULTS },
      mode: 'focus',
      duration: DEFAULTS.focus * 60000,
      remaining: DEFAULTS.focus * 60000,
      endAt: null,
      running: false,
      cycle: 0,
      seed: newSeed(),
      stats: { sessions: 0, bases: 0 },
    };
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && MODES[s.mode]) {
        return { ...fresh(), ...s, settings: { ...DEFAULTS, ...s.settings }, stats: { sessions: 0, bases: 0, ...s.stats } };
      }
    } catch (e) { /* storage unavailable */ }
    return fresh();
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  let state = load();

  const remainingNow = () => (state.running ? Math.max(0, state.endAt - Date.now()) : state.remaining);
  const elapsedSec = () => (state.duration - remainingNow()) / 1000;
  const offsetNow = () => (state.mode === 'focus' ? elapsedSec() * RATE : 0);

  // ---------- actions ----------
  function start() {
    if (state.running) return;
    unlockAudio();
    askNotify();
    state.running = true;
    state.endAt = Date.now() + state.remaining;
    save(); render();
  }

  function pause() {
    if (!state.running) return;
    state.remaining = remainingNow();
    state.running = false;
    state.endAt = null;
    save(); render();
  }

  function reset() {
    state.running = false;
    state.endAt = null;
    state.remaining = state.duration;
    save(); render();
  }

  function setMode(mode, startAt) {
    state.mode = mode;
    state.duration = state.settings[mode] * 60000;
    state.remaining = state.duration;
    state.seed = newSeed();
    state.running = startAt != null;
    state.endAt = state.running ? startAt + state.duration : null;
  }

  function nextMode() {
    if (state.mode !== 'focus') return 'focus';
    return state.cycle >= state.settings.every ? 'long' : 'short';
  }

  // natural = the timer ran out (vs. skipped)
  function finish(natural) {
    const was = state.mode;
    const endedAt = state.endAt;
    const away = natural && Date.now() - endedAt > 60000;
    if (was === 'focus') {
      state.stats.bases += Math.floor(offsetNow());
      if (natural) { state.stats.sessions++; state.cycle++; }
    }
    if (was === 'long') state.cycle = 0;
    const next = nextMode();
    // auto-start continues from the exact end time so no time is lost
    setMode(next, natural && state.settings.auto && !away ? endedAt : null);
    save(); render();

    if (natural) {
      const msg = was === 'focus'
        ? `Focus session done — time for a ${MODES[next].label.toLowerCase()}.`
        : 'Break over — back to sequencing.';
      toast(away ? `Your ${MODES[was].label.toLowerCase()} session finished while you were away — next up: ${MODES[next].label.toLowerCase()}.` : msg);
      if (!away) { chime(); notify(msg); }
    }
  }

  function tick() {
    if (state.running && Date.now() >= state.endAt) {
      // another tab may already have advanced the session
      const disk = load();
      if (disk.endAt !== state.endAt || disk.mode !== state.mode) { state = disk; render(); return; }
      finish(true);
      return;
    }
    renderTime();
  }

  // ---------- sound & notifications ----------
  let actx = null;
  function unlockAudio() {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) { /* no audio */ }
  }
  function chime() {
    if (!state.settings.sound) return;
    unlockAudio();
    if (!actx) return;
    [660, 880, 990].forEach((f, i) => {
      const t0 = actx.currentTime + i * 0.22;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      o.connect(g).connect(actx.destination);
      o.start(t0); o.stop(t0 + 0.45);
    });
  }
  function askNotify() {
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
  }
  function notify(body) {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      try { new Notification('NanoPomodoro', { body }); } catch (e) { /* ignore */ }
    }
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 10000);
  }

  // ---------- DOM rendering ----------
  const fmt = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function renderTime() {
    const rem = remainingNow();
    const t = fmt(rem);
    $('time').textContent = t;
    $('fill').style.width = `${(1 - rem / state.duration) * 100}%`;
    document.title = `${t} · ${MODES[state.mode].label}`;
    const bases = state.stats.bases + Math.floor(offsetNow());
    $('statBases').textContent = bases.toLocaleString();
  }

  function render() {
    document.body.classList.toggle('is-break', state.mode !== 'focus');
    document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === state.mode)));
    $('runLabel').textContent = MODES[state.mode].run;
    $('startBtn').textContent = state.running ? 'Pause' : state.remaining < state.duration ? 'Resume' : 'Start';
    $('status').textContent = state.running
      ? (state.mode === 'focus' ? 'Sequencing · −180 mV' : 'Open pore · −180 mV')
      : 'Voltage off';
    $('speed').textContent = state.mode === 'focus' ? `${RATE} b/s · real pores ~400 b/s` : '';

    const dots = $('dots');
    dots.innerHTML = '';
    for (let i = 0; i < state.settings.every; i++) {
      const d = document.createElement('i');
      if (i < state.cycle) d.className = 'on';
      dots.appendChild(d);
    }
    $('statSessions').textContent = state.stats.sessions;

    const s = state.settings;
    const inputs = { setFocus: s.focus, setShort: s.short, setLong: s.long, setEvery: s.every };
    for (const [id, v] of Object.entries(inputs)) if (document.activeElement !== $(id)) $(id).value = v;
    $('setAuto').checked = s.auto;
    $('setSound').checked = s.sound;
    lastCalls = null;
    renderTime();
  }

  let lastCalls = null;
  function renderCalls() {
    const el = $('calls');
    if (state.mode !== 'focus') {
      if (lastCalls !== 'idle') { el.textContent = '— pore idle, no strand captured —'; $('readLen').textContent = ''; lastCalls = 'idle'; }
      return;
    }
    const n = Math.floor(offsetNow());
    const key = `${state.seed}:${n}`;
    if (key === lastCalls) return;
    lastCalls = key;
    $('readLen').textContent = `${n.toLocaleString()} nt`;
    if (n === 0) { el.textContent = 'Waiting for the strand to translocate…'; return; }
    let html = '';
    for (let i = Math.max(0, n - 72); i < n; i++) {
      const b = baseAt(i);
      html += `<span class="${b}">${b}</span>`;
    }
    el.innerHTML = html;
  }

  // ---------- canvas ----------
  const scene = $('scene');
  const trace = $('trace');

  function fit(c) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  // Strand path: s = 0 at the pore constriction, s < 0 upstream (cis), s > 0 downstream (trans).
  const TURN_R = 34;
  const TURN_LEN = (Math.PI / 2) * TURN_R;
  function strandPt(s, cx, y0, t) {
    const up = s < 0;
    const dir = up ? -1 : 1;       // vertical direction
    const side = up ? -1 : 1;      // cis strand trails left, trans strand exits right
    const straight = up ? 118 : 50;
    let u = Math.abs(s);
    if (u <= straight) return [cx, y0 + dir * u];
    u -= straight;
    const yT = y0 + dir * straight;
    if (u <= TURN_LEN) {
      const th = u / TURN_R;
      return [cx + side * TURN_R * (1 - Math.cos(th)), yT + dir * TURN_R * Math.sin(th)];
    }
    u -= TURN_LEN;
    const k = Math.min(1, u / 80);
    const wob = Math.sin(u / 34 + (up ? 1 : -1) * t * 0.9) * 13 * k + Math.sin(u / 13 + t * 1.7) * 3 * k;
    return [cx + side * (TURN_R + u), yT + dir * TURN_R + wob];
  }

  const PORE = [[-50, -58], [-22, -58], [-19, -14], [-6, 4], [-8, 42], [-34, 46], [-46, 28], [-52, -20]];

  function drawMembrane(ctx, w, cx, my, t) {
    const off = 21;
    for (let x = 6; x < w; x += 12) {
      if (Math.abs(x - cx) < 54) continue;
      for (const side of [-1, 1]) {
        const j = Math.sin(x * 0.7 + side + t * 1.3) * 0.9;
        const hy = my + side * off + j;
        ctx.strokeStyle = '#34465a';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x - 2, hy); ctx.quadraticCurveTo(x - 3 + j, my + side * 10, x - 2, my + side * 2);
        ctx.moveTo(x + 2, hy); ctx.quadraticCurveTo(x + 3 - j, my + side * 10, x + 2, my + side * 2);
        ctx.stroke();
        ctx.fillStyle = '#5a7189';
        ctx.beginPath(); ctx.arc(x, hy, 5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function drawPore(ctx, cx, my) {
    const g = ctx.createLinearGradient(0, my - 60, 0, my + 48);
    g.addColorStop(0, '#26b3a4'); g.addColorStop(1, '#125a58');
    for (const m of [1, -1]) {
      ctx.beginPath();
      PORE.forEach(([dx, dy], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, cx + m * dx, my + dy));
      ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = 'rgba(120,240,225,.55)'; ctx.lineWidth = 1.2; ctx.stroke();
      // beta-barrel ribs
      ctx.strokeStyle = 'rgba(5,30,30,.35)';
      for (let y = -48; y < 40; y += 10) {
        ctx.beginPath(); ctx.moveTo(cx - m * 44, my + y); ctx.lineTo(cx - m * 24, my + y + 3); ctx.stroke();
      }
    }
  }

  function drawMotor(ctx, cx, my, t, on) {
    ctx.save();
    ctx.translate(cx, my - 82);
    ctx.rotate(on && !reduceMotion ? Math.sin(t * 7) * 0.03 : 0);
    const g = ctx.createRadialGradient(-10, -8, 4, 0, 0, 40);
    g.addColorStop(0, 'rgba(190,160,255,.95)'); g.addColorStop(1, 'rgba(110,80,210,.9)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, 38, 21, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(150,120,240,.9)';
    ctx.beginPath(); ctx.ellipse(-20, -12, 14, 10, -0.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(22, -10, 12, 9, 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawStrand(ctx, w, cx, y0, t) {
    const offset = offsetNow();
    const sMin = -(w + 40);
    const sMax = Math.min(w + 40, offset * SP);
    // backbone
    ctx.strokeStyle = 'rgba(214,226,238,.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let s = sMin; s <= sMax; s += 4) {
      const [x, y] = strandPt(s, cx, y0, t);
      s === sMin ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    const [ex, ey] = strandPt(sMax, cx, y0, t);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // bases
    const iLo = Math.max(0, Math.floor(offset - sMax / SP));
    const iHi = Math.ceil(offset - sMin / SP);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = iLo; i <= iHi; i++) {
      const s = (offset - i) * SP;
      if (s < sMin || s > sMax) continue;
      const [x, y] = strandPt(s, cx, y0, t);
      const [x2, y2] = strandPt(s + 1, cx, y0, t);
      let nx = -(y2 - y), ny = x2 - x;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len; ny /= len;
      ctx.strokeStyle = COLORS[baseAt(i)];
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + nx * 7, y + ny * 7); ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  // ions flowing through the pore; phase advances only while voltage is on
  const IONS = Array.from({ length: 34 }, (_, i) => ({
    phase: Math.random(),
    lane: Math.random() * 2 - 1,
    end: Math.random() * 2 - 1,
    k: i % 2,
  }));
  let ionClock = 0;
  let lastFrame = 0;

  function drawIons(ctx, cx, my, w, h) {
    const focus = state.mode === 'focus';
    const n = focus ? 10 : IONS.length;   // a strand in the pore blocks most of the current
    const lerp = (a, b, p) => a + (b - a) * p;
    for (let i = 0; i < n; i++) {
      const ion = IONS[i];
      const p = (ion.phase + ionClock) % 1;
      let x, y;
      if (p < 0.4) {
        const q = p / 0.4;
        x = lerp(cx + ion.lane * w * 0.3, cx + ion.lane * 12, q * q);
        y = lerp(my - 145, my - 56, q);
      } else if (p < 0.6) {
        const q = (p - 0.4) / 0.2;
        x = cx + ion.lane * lerp(12, 4, q);
        y = lerp(my - 56, my + 44, q);
      } else {
        const q = (p - 0.6) / 0.4;
        x = lerp(cx + ion.lane * 4, cx + ion.end * w * 0.3, Math.sqrt(q));
        y = lerp(my + 44, h - 12, q);
      }
      ctx.globalAlpha = p < 0.08 ? p / 0.08 : p > 0.92 ? (1 - p) / 0.08 : 1;
      ctx.fillStyle = ion.k ? '#ffd166' : '#8fd3ff';
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function label(ctx, text, x, y, tx, ty) {
    ctx.strokeStyle = 'rgba(131,151,170,.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.fillStyle = '#8397aa';
    ctx.fillText(text, tx + (tx > x ? 4 : -4 - ctx.measureText(text).width), ty + 4);
  }

  function drawScene(t) {
    const { ctx, w, h } = fit(scene);
    const cx = w / 2;
    const my = Math.round(h * 0.55);
    const y0 = my + 4; // constriction
    const focus = state.mode === 'focus';

    ctx.fillStyle = 'rgba(76,141,255,.05)'; ctx.fillRect(0, 0, w, my - 26);
    ctx.fillStyle = 'rgba(255,93,108,.04)'; ctx.fillRect(0, my + 26, w, h - my - 26);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = '#5d7185';
    ctx.fillText('cis  −', w - 48, 18);
    ctx.fillText('trans  +', 10, h - 10);

    drawMembrane(ctx, w, cx, my, t);
    drawPore(ctx, cx, my);
    drawIons(ctx, cx, my, w, h);
    if (focus) {
      drawStrand(ctx, w, cx, y0, t);
      drawMotor(ctx, cx, my, t, state.running);
    }

    if (w > 460) {
      label(ctx, 'membrane', cx + 150, my - 22, cx + 190, my - 58);
      label(ctx, 'nanopore', cx + 44, my + 20, cx + 110, my + 70);
      if (focus) {
        label(ctx, 'motor protein', cx + 36, my - 90, cx + 100, my - 122);
        const [sx, sy] = strandPt(-(118 + TURN_LEN + 70), cx, y0, t);
        label(ctx, 'ssDNA', sx, sy + 6, sx - 24, sy + 44);
      }
    }
  }

  function kmerLevel(j) {
    let code = 0;
    for (let m = -2; m <= 2; m++) code = code * 4 + (j + m >= 0 ? baseIdx(j + m) : 0);
    return 55 + (h32(0x5eed, code) % 1000) / 1000 * 95;
  }

  function drawTrace() {
    const { ctx, w, h } = fit(trace);
    const padL = 34, padR = 6, padT = 8, padB = 8;
    const yOf = (pA) => padT + (1 - pA / 250) * (h - padT - padB);
    ctx.font = '11px system-ui, sans-serif';
    for (const pA of [0, 100, 200]) {
      const y = yOf(pA);
      ctx.strokeStyle = '#1b2733'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = '#5d7185'; ctx.fillText(String(pA), 6, y + 4);
    }

    const el = elapsedSec();
    if (el <= 0) {
      ctx.fillStyle = '#5d7185';
      ctx.fillText('No signal — press Start to apply voltage', padL + 10, h / 2 + 4);
      return;
    }

    const WIN = 12, SR = 25; // seconds shown, samples per second
    const focus = state.mode === 'focus';
    const first = Math.max(0, Math.floor((el - WIN) * SR));
    const last = Math.floor(el * SR);
    const xOf = (ts) => padL + ((ts - (el - WIN)) / WIN) * (w - padL - padR);
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#2fd3c0';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let si = first; si <= last; si++) {
      const ts = si / SR;
      const noise = (h32(state.seed ^ 0xabc, si) / 2 ** 32 - 0.5);
      let v;
      if (focus) v = kmerLevel(Math.floor(ts * RATE)) + noise * 9;
      else v = (h32(state.seed, si >> 3) % 29 === 0 ? 120 : OPEN_PORE) + noise * 12;
      const x = xOf(ts), y = yOf(v);
      si === first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function frame(now) {
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    if (state.running) ionClock += dt * (state.mode === 'focus' ? 0.05 : 0.22);
    const t = reduceMotion ? 0 : now / 1000;
    drawScene(t);
    drawTrace();
    renderCalls();
    requestAnimationFrame(frame);
  }

  // ---------- events ----------
  $('startBtn').addEventListener('click', () => (state.running ? pause() : start()));
  $('resetBtn').addEventListener('click', reset);
  $('skipBtn').addEventListener('click', () => finish(false));
  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.mode === state.mode) return;
    if (state.running && !confirm('Stop the current session and switch?')) return;
    setMode(b.dataset.mode, null);
    save(); render();
  }));

  function readSettings() {
    const num = (id, lo, hi, fb) => {
      const v = Math.round(Number($(id).value));
      return Number.isFinite(v) && v >= lo ? Math.min(hi, v) : fb;
    };
    const s = state.settings;
    s.focus = num('setFocus', 1, 180, s.focus);
    s.short = num('setShort', 1, 60, s.short);
    s.long = num('setLong', 1, 120, s.long);
    s.every = num('setEvery', 1, 12, s.every);
    s.auto = $('setAuto').checked;
    s.sound = $('setSound').checked;
    // apply new length right away if the current session hasn't started
    if (!state.running && state.remaining === state.duration) {
      state.duration = s[state.mode] * 60000;
      state.remaining = state.duration;
    }
    save(); render();
  }
  ['setFocus', 'setShort', 'setLong', 'setEvery', 'setAuto', 'setSound'].forEach((id) => $(id).addEventListener('change', readSettings));

  $('clearStats').addEventListener('click', () => {
    if (!confirm('Reset session count and total bases?')) return;
    state.stats = { sessions: 0, bases: 0 };
    state.cycle = 0;
    save(); render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, button, summary, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); state.running ? pause() : start(); }
    else if (e.key === 'r' || e.key === 'R') reset();
    else if (e.key === 's' || e.key === 'S') finish(false);
  });

  // keep several open tabs in sync
  window.addEventListener('storage', (e) => { if (e.key === KEY) { state = load(); render(); } });
  document.addEventListener('visibilitychange', tick);

  // ---------- boot ----------
  render();
  tick(); // catches a session that ended while the page was closed
  setInterval(tick, 250);
  requestAnimationFrame(frame);
})();

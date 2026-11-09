// ============================================================
// POMODORO
// ============================================================
const POMO_LEN = { focus: 1500, break: 300 };
const pomo = { mode: 'focus', left: POMO_LEN.focus, end: 0, running: false, sessions: 0 };
const mmss = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
function pomoSave() { try { localStorage.setItem('kanban_pomo', JSON.stringify({ day: todayISO(), sessions: pomo.sessions, mode: pomo.mode, left: pomo.left, end: pomo.end, running: pomo.running })); } catch (_) {} }
function pomoRender() {
  const left = pomo.running ? Math.max(0, Math.ceil((pomo.end - Date.now()) / 1000)) : pomo.left;
  $('#pomoTime').textContent = mmss(left);
  $('#pomoMode').textContent = (pomo.mode === 'focus' ? 'Фокус' : 'Перерыв') + ' · 🍅 сегодня: ' + pomo.sessions;
  $('#pomoToggle').textContent = pomo.running ? '⏸' : '▶';
  document.title = pomo.running ? mmss(left) + ' · Канбан' : 'Канбан';
  return left;
}
function pomoBeep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(c.currentTime + 0.35);
  } catch (_) {}
  if (navigator.vibrate) try { navigator.vibrate([200, 100, 200]); } catch (_) {}
}
function pomoSwitch() { pomo.running = false; pomo.mode = pomo.mode === 'focus' ? 'break' : 'focus'; pomo.left = POMO_LEN[pomo.mode]; pomoSave(); pomoRender(); }
function initPomo() {
  try { const s = JSON.parse(localStorage.getItem('kanban_pomo') || '{}'); if (s.day === todayISO()) pomo.sessions = s.sessions | 0; if (['focus','break'].includes(s.mode)) { pomo.mode = s.mode; pomo.left = Math.max(0, Math.min(86400, Number(s.left) || POMO_LEN[pomo.mode])); if (s.running && Number.isFinite(s.end)) { pomo.end = s.end; pomo.running = s.end > Date.now(); if (!pomo.running) pomo.left = 0; } } } catch (_) {}
  $('#focusBtn').onclick = () => { $('#pomo').hidden = !$('#pomo').hidden; };
  $('#pomoToggle').onclick = () => {
    if (pomo.running) { pomo.left = Math.max(0, Math.ceil((pomo.end - Date.now()) / 1000)); pomo.running = false; }
    else { pomo.end = Date.now() + pomo.left * 1000; pomo.running = true; }
    pomoSave(); pomoRender();
  };
  $('#pomoReset').onclick = () => { pomo.running = false; pomo.left = POMO_LEN[pomo.mode]; pomoSave(); pomoRender(); };
  $('#pomoSkip').onclick = pomoSwitch;
  setInterval(() => {
    if (!pomo.running || pomoRender() > 0) return;
    const wasFocus = pomo.mode === 'focus';
    if (wasFocus) { pomo.sessions++; pomoSave(); }
    pomoSwitch(); pomoBeep();
    showToast(wasFocus ? 'Сессия завершена — перерыв 5 мин' : 'Перерыв окончен — за работу!', null, null, 6000);
  }, 500);
  pomoRender();
}

// ============================================================
// SERVICE WORKER
// ============================================================
// ============================================================
// AUDIO NOTES
// ============================================================
const fmtDur = s => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const isAudio = f => !!f && String(f.type || '').startsWith('audio/');
const AP = { el: new Audio(), id: null, scope: '', url: null, rate: 1, uis: new Set(), tok: 0 };
AP.el.preload = 'metadata';

async function prepAudio(file) {
  if (file._meta) return file._meta;
  const m = { dur: file._dur || 0, peaks: null };
  if (file.size <= 25 * 1048576) {
    let ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const ch = buf.getChannelData(0), N = 56, step = Math.max(1, Math.floor(ch.length / N)), p = [];
      for (let i = 0; i < N; i++) { let mx = 0; for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j += 4) mx = Math.max(mx, Math.abs(ch[j])); p.push(mx); }
      const top = Math.max(...p) || 1;
      m.peaks = p.map(v => Math.round(Math.max(8, Math.sqrt(v / top) * 100)));
      m.dur = buf.duration;
    } catch (_) {} finally { try { ctx && ctx.close(); } catch (_) {} }
  }
  return file._meta = m;
}

function apState(ui) { const a = AP.el; return AP.id === ui.key ? { playing: !a.paused && !a.ended, t: a.currentTime, dur: isFinite(a.duration) ? a.duration : 0 } : null; }
function apSync() {
  for (const ui of AP.uis) {
    if (!ui.root.isConnected) { if (ui.seen) AP.uis.delete(ui); continue; }
    ui.seen = true; ui.render(apState(ui));
  }
}
['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata', 'durationchange'].forEach(ev => AP.el.addEventListener(ev, apSync));
AP.el.addEventListener('ended', () => { AP.el.currentTime = 0; });

async function apLoad(ui) {
  const tok = ++AP.tok, a = AP.el;
  let blob = null; try { blob = await ui.getBlob(); } catch (_) {}
  if (tok !== AP.tok) return false;
  if (!blob) { showToast('Файл не найден'); return false; }
  a.pause(); if (AP.url) revokeTrackedURL(AP.url);
  AP.url = createTrackedURL(blob); AP.id = ui.key; AP.scope = ui.scope;
  a.src = AP.url; a.defaultPlaybackRate = a.playbackRate = AP.rate;
  await new Promise(res => { const d = () => { a.removeEventListener('loadedmetadata', d); a.removeEventListener('error', d); res(); }; a.addEventListener('loadedmetadata', d); a.addEventListener('error', d); setTimeout(d, 4000); });
  if (tok !== AP.tok) return false;
  // WebM из MediaRecorder приходит без длительности — «лечим», чтобы работала перемотка
  if (a.duration === Infinity) await new Promise(res => { a.addEventListener('timeupdate', function h() { a.removeEventListener('timeupdate', h); a.currentTime = 0; res(); }); a.currentTime = 1e7; setTimeout(res, 1500); });
  if ('mediaSession' in navigator) try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: String(ui.name || 'Аудио').replace(/\.[a-z0-9]+$/i, ''), artist: 'Канбан' });
    navigator.mediaSession.setActionHandler('play', () => a.play());
    navigator.mediaSession.setActionHandler('pause', () => a.pause());
  } catch (_) {}
  return true;
}
async function apPlay(ui, fr) {
  const a = AP.el;
  if (AP.id !== ui.key || !a.src) { ui.root.classList.add('loading'); const ok = await apLoad(ui); ui.root.classList.remove('loading'); if (!ok) return; }
  const d = isFinite(a.duration) ? a.duration : ui.dur;
  if (fr != null && d) a.currentTime = fr * d;
  try { await a.play(); } catch (_) { showToast('Не удалось воспроизвести запись'); }
}
function apToggle(ui) { const a = AP.el; if (AP.id === ui.key && a.src) { a.paused ? apPlay(ui) : a.pause(); } else apPlay(ui); }
function apStop(scope) {
  if (scope && AP.scope !== scope) return;
  const a = AP.el; AP.tok++; a.pause(); a.removeAttribute('src'); a.load();
  if (AP.url) revokeTrackedURL(AP.url);
  AP.url = null; AP.id = null; apSync();
}

function createAudioPlayer(f, o = {}) {
  const key = f.id, root = document.createElement('div'), n = o.compact ? 32 : 56, src = f.peaks && f.peaks.length ? f.peaks : null;
  root.className = 'ap' + (o.compact ? ' compact' : '');
  const bars = Array.from({ length: n }, (_, i) => `<i style="height:${src ? src[Math.floor(i * src.length / n)] : 30}%"></i>`).join('');
  root.innerHTML = `<button type="button" class="ap-play" aria-label="Воспроизвести / пауза"><svg class="i-play" viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z" fill="currentColor"/></svg><svg class="i-pause" viewBox="0 0 24 24" width="16" height="16"><path d="M7 5h4v14H7zm6 0h4v14h-4z" fill="currentColor"/></svg></button>`
    + `<div class="ap-body"><div class="ap-wave" role="slider" tabindex="0" aria-label="Позиция записи" aria-valuemin="0" aria-valuemax="100"><div class="ap-bars">${bars}</div><div class="ap-bars ap-fill">${bars}</div></div>`
    + `<div class="ap-meta"><span class="ap-time"></span>${o.compact ? '' : `<span class="ap-name">${escapeHtml(String(f.name || 'Запись').replace(/\.[a-z0-9]+$/i, ''))}</span><button type="button" class="ap-speed" title="Скорость">1×</button>`}</div></div>`;
  const w = root.querySelector('.ap-wave'), tm = root.querySelector('.ap-time'), sp = root.querySelector('.ap-speed');
  const ui = { key, root, name: f.name, scope: o.scope || '', dur: f.dur || 0, scrub: null, getBlob: o.getBlob };
  ui.render = st => {
    const dur = (st && st.dur) || ui.dur, p = ui.scrub != null ? ui.scrub : (st && dur ? Math.min(1, st.t / dur) : 0);
    root.classList.toggle('playing', !!(st && st.playing));
    w.style.setProperty('--p', (p * 100) + '%'); w.setAttribute('aria-valuenow', Math.round(p * 100));
    tm.textContent = st ? (o.compact ? fmtDur(st.t) : fmtDur(st.t) + ' / ' + fmtDur(dur)) : fmtDur(dur);
    if (sp) sp.textContent = AP.rate + '×';
  };
  const frac = e => { const r = w.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  root.addEventListener('pointerdown', e => e.stopPropagation());
  root.querySelector('.ap-play').onclick = e => { e.stopPropagation(); apToggle(ui); };
  w.onpointerdown = e => { try { w.setPointerCapture(e.pointerId); } catch (_) {} ui.scrub = frac(e); apSync(); };
  w.onpointermove = e => { if (ui.scrub != null) { ui.scrub = frac(e); apSync(); } };
  w.onpointerup = e => { if (ui.scrub == null) return; const fr = frac(e); ui.scrub = null; apPlay(ui, fr); };
  w.onpointercancel = () => { ui.scrub = null; apSync(); };
  w.onkeydown = e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); if (AP.id === key) AP.el.currentTime = Math.max(0, AP.el.currentTime + (e.key === 'ArrowRight' ? 5 : -5)); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); apToggle(ui); }
  };
  const nm = root.querySelector('.ap-name'); if (nm && o.onRename) { nm.style.cursor = 'pointer'; nm.title = 'Переименовать'; nm.onclick = o.onRename; }
  if (sp) sp.onclick = () => { AP.rate = AP.rate === 1 ? 1.5 : AP.rate === 1.5 ? 2 : 1; AP.el.defaultPlaybackRate = AP.el.playbackRate = AP.rate; apSync(); };
  AP.uis.add(ui); ui.render(apState(ui));
  return root;
}

function renderAudioList() {
  const box = $('#audioList'); if (!box) return;
  box.innerHTML = '';
  [...tempFiles.map(f => ({ f, old: true })), ...newFiles.map(f => ({ f, old: false }))].filter(it => isAudio(it.f)).forEach(({ f, old }) => {
    let meta = f, getBlob = async () => (await mediaGet(f.id))?.full;
    if (!old) { f._aid = f._aid || 'tmp_' + generateId(); const m = f._meta || {}; meta = { id: f._aid, name: f.name, dur: m.dur || f._dur, peaks: m.peaks }; meta.name = f._name || f.name; getBlob = async () => f; }
    const row = document.createElement('div'); row.className = 'audio-item';
    row.appendChild(createAudioPlayer(meta, { scope: 'modal', getBlob, onRename: async () => {
      const v = await askForText('Название записи', String(meta.name || '').replace(/\.[a-z0-9]+$/i, ''), 80);
      if (!v) return; if (old) f.name = v; else f._name = v; renderFiles();
    } }));
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'audio-rm'; rm.textContent = '×'; rm.setAttribute('aria-label', 'Удалить запись');
    rm.onclick = () => { if (AP.id === meta.id) apStop(); if (old) tempFiles = tempFiles.filter(x => x !== f); else newFiles = newFiles.filter(x => x !== f); renderFiles(); };
    row.appendChild(rm); box.appendChild(row);
  });
}

const rec = { acc: 0, seg: 0, mr: null, stream: null, ctx: null, an: null, chunks: [], t0: 0, tick: 0, lv: [], cancel: false, done: null };
function bindAudio() { $('#recStartBtn').onclick = recStart; $('#recStop').onclick = recStop; $('#recCancel').onclick = recAbort; $('#recPause').onclick = recPause; }
async function recStart() {
  if (rec.mr) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { showToast('Запись звука не поддерживается в этом браузере'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { showToast(e.name === 'NotAllowedError' ? 'Нет доступа к микрофону — разрешите его в настройках браузера' : e.name === 'NotFoundError' ? 'Микрофон не найден' : 'Не удалось включить микрофон'); return; }
  apStop();
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  let mr; try { mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); } catch (_) { stream.getTracks().forEach(t => t.stop()); showToast('Не удалось начать запись'); return; }
  Object.assign(rec, { mr, stream, chunks: [], cancel: false, lv: [], acc: 0, seg: Date.now() }); $('#recPause').textContent = 'Пауза';
  mr.ondataavailable = e => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.done = new Promise(res => { mr.onstop = async () => { await recFinish(); res(); }; });
  try { rec.ctx = new (window.AudioContext || window.webkitAudioContext)(); rec.ctx.resume?.(); rec.an = rec.ctx.createAnalyser(); rec.an.fftSize = 256; rec.ctx.createMediaStreamSource(stream).connect(rec.an); } catch (_) { rec.an = null; }
  mr.start(1000);
  $('#recPanel').hidden = false; $('#recStartBtn').hidden = true;
  rec.tick = setInterval(recTick, 80);
}
function recElapsed() { return (rec.acc + (rec.mr && rec.mr.state === 'recording' ? Date.now() - rec.seg : 0)) / 1000; }
function recPause() {
  if (!rec.mr) return;
  if (rec.mr.state === 'recording') { rec.acc += Date.now() - rec.seg; rec.mr.pause(); $('#recPause').textContent = 'Продолжить'; }
  else if (rec.mr.state === 'paused') { rec.seg = Date.now(); rec.mr.resume(); $('#recPause').textContent = 'Пауза'; }
}
function recTick() {
  const s = recElapsed(); $('#recTime').textContent = fmtDur(s);
  let lvl = 0.05;
  if (rec.an) { const d = new Uint8Array(rec.an.fftSize); rec.an.getByteTimeDomainData(d); let sum = 0; for (const v of d) sum += (v - 128) ** 2; lvl = Math.min(1, Math.sqrt(sum / d.length) / 40); }
  if (rec.mr.state !== 'recording') return;
  rec.lv.push(lvl);
  const box = $('#recLevels'), n = 40, last = rec.lv.slice(-n);
  if (box.children.length !== n) box.innerHTML = '<i></i>'.repeat(n);
  [...box.children].forEach((el, i) => { const v = last[i - (n - last.length)]; el.style.height = (v == null ? 6 : Math.max(8, v * 100)) + '%'; });
  if (s >= 1200) recStop();
}
function recStop() { if (!rec.mr) return Promise.resolve(); if (rec.mr.state === 'recording') { rec.acc += Date.now() - rec.seg; rec.seg = Date.now(); } try { if (rec.mr.state !== 'inactive') rec.mr.stop(); } catch (_) {} return rec.done; }
function recAbort() { if (!rec.mr) return; rec.cancel = true; recStop(); }
async function recFinish() {
  const dur = rec.acc / 1000, type = (rec.mr.mimeType || 'audio/webm').split(';')[0], cancel = rec.cancel, chunks = rec.chunks;
  clearInterval(rec.tick); rec.stream.getTracks().forEach(t => t.stop()); try { rec.ctx && rec.ctx.close(); } catch (_) {}
  rec.mr = null; rec.stream = null; rec.ctx = null; rec.an = null;
  $('#recPanel').hidden = true; $('#recStartBtn').hidden = false;
  if (cancel || !chunks.length) return;
  const d = new Date(), p = n => String(n).padStart(2, '0'), ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  const file = new File(chunks, `Запись ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}-${p(d.getMinutes())}.${ext}`, { type });
  file._dur = dur; await prepAudio(file); newFiles.push(file); renderFiles();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  try { await navigator.serviceWorker.register('sw.js', { scope: './' }); }
  catch (e) { console.info('[kanban] sw.js не найден:', e.message); }
}

// ============================================================
// INIT
// ============================================================
async function init() {
  initTheme();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  try { db = await openDB(); }
  catch (e) { console.error(e); alert('Не удалось открыть базу данных: ' + e.message); return; }

  await loadData();
  // Reconcile persisted tasks with native alarms after an APK upgrade or WebView restart.
  Object.values(state._tasksByBoard).flat().forEach(syncNativeReminder);
  loadUIState();
  updateBoardSelect();

  $('#myDayBtn').onclick = () => { filterDeadline = filterDeadline === 'attention' ? '' : 'attention'; $('#deadlineFilter').value = filterDeadline; saveUIState(); switchView('kanban'); renderBoard(); };
  $('#sortSelect').value = sortMode;
  $('#deadlineFilter').value = filterDeadline;
  $('#priorityFilter').value = filterPriority;

  renderBoard();
  bindEvents();
  setupDragAndDrop();
  mmBind();
  setupBroadcast();
  switchView(currentView || 'kanban');
  updateStorageInfo();

  setInterval(updateStorageInfo, 15000);
  setInterval(() => {
    const now = Date.now();
    for (let i = undoStack.length - 1; i >= 0; i--) {
      if (undoStack[i].expiresAt <= now) {
        const exp = undoStack.splice(i, 1)[0];
        try { exp.onExpire?.(); } catch (_) {}
      }
    }
  }, 2000);
  setTimeout(() => mediaCleanupOrphans(), 2000);
  initPomo();
  const quickAddInput = $('#quickAdd');
  const quickAddButton = $('#quickAddSubmit');
  async function submitQuickAdd() {
    if (!quickAddInput.value.trim() || quickAddButton.disabled) return;
    quickAddButton.disabled = true;
    try {
      if (await quickAddTask(quickAddInput.value)) quickAddInput.value = '';
    } finally {
      quickAddButton.disabled = false;
    }
  }
  quickAddInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    void submitQuickAdd();
  });
  quickAddButton.addEventListener('click', submitQuickAdd);
  quickAddButton.disabled = false;
  registerServiceWorker();
}

init();
})();

// ============================================================
// POMODORO
// ============================================================
const POMO_LEN = { focus: 1500, break: 300 };
const pomo = { mode: 'focus', left: POMO_LEN.focus, end: 0, running: false, sessions: 0 };
const mmss = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
function pomoSave() { try { localStorage.setItem('kanban_pomo', JSON.stringify({ day: todayISO(), sessions: pomo.sessions, mode: pomo.mode, left: pomo.left, end: pomo.end, running: pomo.running })); } catch (_) {} }
function pomoRender(now = Date.now()) {
  const left = pomo.running ? Math.max(0, Math.ceil((pomo.end - now) / 1000)) : pomo.left;
  $('#pomoTime').textContent = mmss(left);
  $('#pomoMode').textContent = (pomo.mode === 'focus' ? 'Фокус' : 'Перерыв') + ' · 🍅 сегодня: ' + pomo.sessions;
  $('#pomoToggle').textContent = pomo.running ? '⏸' : '▶';
  document.title = pomo.running ? mmss(left) + ' · Comrade' : 'Comrade';
  return left;
}
function pomoBeep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(c.currentTime + 0.35);
  } catch (_) {}
  try { globalThis.KanbanHaptics?.postMessage('done'); } catch (_) {}
}
function pomoSwitch() { pomo.running = false; pomo.mode = pomo.mode === 'focus' ? 'break' : 'focus'; pomo.left = POMO_LEN[pomo.mode]; pomoSave(); pomoRender(); }
function initPomo() {
  $('#focusBtn').onclick = () => { $('#pomo').hidden = !$('#pomo').hidden; };
  if (globalThis.KanbanPomo?.postMessage) { initNativePomo(); return; }
  try { const s = JSON.parse(localStorage.getItem('kanban_pomo') || '{}'); if (s.day === todayISO()) pomo.sessions = s.sessions | 0; if (['focus','break'].includes(s.mode)) { pomo.mode = s.mode; pomo.left = Math.max(0, Math.min(86400, Number(s.left) || POMO_LEN[pomo.mode])); if (s.running && Number.isFinite(s.end)) { pomo.end = s.end; pomo.running = s.end > Date.now(); if (!pomo.running) pomo.left = 0; } } } catch (_) {}
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

function initNativePomo() {
  const buttons = ['#pomoToggle', '#pomoReset', '#pomoSkip'].map(selector => $(selector));
  let pending = null, ticker = null, initialized = false;
  let legacy;
  try { legacy = JSON.parse(localStorage.getItem('kanban_pomo') || 'null'); } catch (_) {}
  function unlock() {
    clearTimeout(pending?.timeout);
    pending = null;
    for (const button of buttons) button.disabled = false;
  }
  function request(type) {
    if (pending) return;
    const id = generateId();
    for (const button of buttons) button.disabled = true;
    pending = { id, timeout: setTimeout(() => {
      unlock(); showToast('Pomodoro не получил ответ от Android');
    }, 5000) };
    try { globalThis.KanbanPomo.postMessage(JSON.stringify({ id, type, legacy: initialized ? undefined : legacy })); }
    catch (_) { unlock(); showToast('Pomodoro не удалось связаться с Android'); }
  }
  function tick() {
    clearTimeout(ticker);
    const left = pomoRender(performance.now());
    if (!pomo.running || document.hidden) return;
    if (left === 0) request('read');
    else ticker = setTimeout(tick, 250);
  }
  window.kanbanPomoResult = raw => {
    let state;
    try { state = JSON.parse(raw); } catch (_) { return; }
    if (state.id !== pending?.id) return;
    unlock();
    if (state.error) { showToast(state.error); return; }
    initialized = true;
    pomo.mode = state.mode;
    pomo.running = state.running;
    pomo.left = Math.ceil(state.ms / 1000);
    pomo.end = performance.now() + state.ms;
    pomo.sessions = state.sessions;
    $('#pomoStatus').textContent = state.notificationsAllowed ? 'Android может задерживать уведомления' : 'Уведомления выключены';
    if (state.completed) showToast(state.completed === 'focus' ? 'Сессия завершена — перерыв 5 мин' : 'Перерыв окончен');
    tick();
  };
  window.kanbanNotificationPermissionResult = () => request('read');
  buttons[0].onclick = () => request('toggle');
  buttons[1].onclick = () => request('reset');
  buttons[2].onclick = () => request('skip');
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(ticker);
    else request('read');
  });
  request('read');
}

// ============================================================
// TASK REMINDERS
// ============================================================
function taskReminderRows() {
  const rows = [];
  const validId = id => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(id);
  for (const board of state.boards) {
    if (!validId(board.id)) continue;
    const done = new Set(board.columns.filter(column => column.isDone).map(column => column.id));
    for (const task of state._tasksByBoard[board.id] || []) {
      if (!task.reminderTime || !task.deadline || !isValidISODate(task.deadline) || !validId(task.id) || done.has(task.columnId)) continue;
      rows.push({ task: task.id, board: board.id, title: task.title.slice(0, 200), date: task.deadline, time: task.reminderTime });
    }
  }
  return rows;
}

const reminderSync = { timer: null, outstanding: null, confirmed: null, waiting: false, askPermission: false };
function queueTaskReminders(askPermission = false) {
  reminderSync.waiting = true;
  reminderSync.askPermission ||= askPermission;
  if (reminderSync.outstanding || reminderSync.timer != null) return;
  reminderSync.timer = setTimeout(syncTaskReminders, 0);
}
function syncTaskReminders() {
  reminderSync.timer = null;
  reminderSync.waiting = false;
  const rows = taskReminderRows();
  const snapshot = JSON.stringify(rows);
  const askPermission = reminderSync.askPermission;
  reminderSync.askPermission = false;
  if (snapshot === reminderSync.confirmed && !askPermission) return;
  const id = generateId();
  const raw = JSON.stringify({ id, rows, askPermission });
  if (rows.length > 1500 || raw.length > 512 * 1024) {
    showToast('Слишком много напоминаний для Android');
    return;
  }
  const finish = ok => {
    clearTimeout(reminderSync.outstanding?.timeout);
    reminderSync.outstanding = null;
    if (ok) reminderSync.confirmed = snapshot;
    else showToast('Не удалось обновить напоминания Android');
    if (reminderSync.waiting) queueTaskReminders();
  };
  reminderSync.outstanding = { id, finish, timeout: setTimeout(() => finish(false), 10000) };
  try { globalThis.KanbanTaskReminders.postMessage(raw); } catch (_) { finish(false); }
}
window.kanbanTaskRemindersResult = raw => {
  let result;
  try { result = JSON.parse(raw); } catch (_) { return; }
  if (result.id === reminderSync.outstanding?.id) reminderSync.outstanding.finish(result.ok);
};

let reminderTarget = null, reminderUiReady = false;
async function openReminderTask() {
  const target = reminderTarget;
  if (!reminderUiReady || !target) return;
  reminderTarget = null;
  if (savingTask || importInProgress || drag || switchingBoard) {
    showToast('Завершите текущее действие, чтобы открыть задачу', 'Открыть', () => {
      reminderTarget = target; void openReminderTask();
    }, 10000);
    return;
  }
  if (!state._tasksByBoard[target.board]?.some(task => task.id === target.task)) {
    showToast('Задача из напоминания удалена или перемещена');
    return;
  }
  if (state.activeBoardId !== target.board && !(await switchBoard(target.board))) return;
  if ($('#taskModal').classList.contains('open')) {
    if (editingTaskId === target.task) return;
    await tryCloseTaskModal();
    if ($('#taskModal').classList.contains('open')) return;
  }
  if (state.activeBoardId !== target.board || !state.tasks.some(task => task.id === target.task)) return;
  switchView('kanban');
  openTaskModal(target.task);
}
window.kanbanOpenReminder = raw => {
  let target;
  try { target = JSON.parse(raw); } catch (_) { return; }
  if (typeof target.board !== 'string' || typeof target.task !== 'string') return;
  reminderTarget = target;
  void openReminderTask();
};

// ============================================================
// SERVICE WORKER
// ============================================================
// ============================================================
// AUDIO NOTES
// ============================================================
const fmtDur = s => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const isAudio = f => !!f && String(f.type || '').startsWith('audio/');
const AP = { el: new Audio(), id: null, scope: '', url: null, rate: 1, uis: new Set(), tok: 0, nativeId: null, nativeState: null };
AP.el.preload = 'metadata';

const mediaSteps = new Map();
function mediaCommand(id, type, fields = {}) {
  globalThis.KanbanMedia.postMessage(JSON.stringify({ id, type, ...fields }));
}
function mediaStep(id, expected, send) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(null, new Error('Android не ответил')), 20000);
    function finish(event, error) {
      clearTimeout(timer);
      mediaSteps.delete(id);
      if (error) reject(error); else resolve(event);
    }
    mediaSteps.set(id, { expected, finish });
    try { send(); } catch (error) { finish(null, error); }
  });
}
function mediaDiscard(id) {
  mediaSteps.get(id)?.finish(null, new Error('Передача отменена'));
  try { mediaCommand(id, 'discard'); } catch (_) {}
}
let mediaQueue = Promise.resolve();
function stageNativeMedia(id, blob, isCurrent, options = {}) {
  const transfer = mediaQueue.then(async () => {
    const chunkSize = 256 * 1024;
    const header = new TextEncoder().encode(id);
    if (!isCurrent()) throw new Error('Передача отменена');
    try {
      await mediaStep(id, 'begin', () => mediaCommand(id, 'begin', { size: blob.size, ...options }));
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const data = await blob.slice(offset, offset + chunkSize).arrayBuffer();
        if (!isCurrent()) throw new Error('Передача отменена');
        const frame = new Uint8Array(header.length + data.byteLength);
        frame.set(header);
        frame.set(new Uint8Array(data), header.length);
        await mediaStep(id, 'chunk', () => globalThis.KanbanMedia.postMessage(frame.buffer));
      }
      return await mediaStep(id, 'loaded', () => mediaCommand(id, 'finish'));
    } catch (error) {
      mediaDiscard(id);
      throw error;
    }
  });
  mediaQueue = transfer.catch(() => {});
  return transfer;
}

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

window.kanbanMediaNativeResult = raw => {
  let event;
  try { event = JSON.parse(raw); } catch (_) { return; }
  const step = mediaSteps.get(event.id);
  if (step && (event.type === 'error' || event.type === step.expected)) {
    step.finish(event, event.type === 'error' ? new Error(event.message) : null);
  } else if (event.id === AP.nativeId) {
    if (event.type === 'state') { AP.nativeState = event; apSync(); }
    if (event.type === 'unavailable') showToast(event.message);
    if (event.type === 'error') { apStop(); showToast(event.message); }
  }
};
function apState(ui) {
  if (AP.id !== ui.key) return null;
  if (AP.nativeId) return AP.nativeState;
  const a = AP.el;
  return { playing: !a.paused && !a.ended, t: a.currentTime, dur: isFinite(a.duration) ? a.duration : 0 };
}
function apSync() {
  for (const ui of AP.uis) {
    if (!ui.root.isConnected) { if (ui.seen) AP.uis.delete(ui); continue; }
    ui.seen = true; ui.render(apState(ui));
  }
}
['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata', 'durationchange'].forEach(ev => AP.el.addEventListener(ev, apSync));
AP.el.addEventListener('ended', () => { AP.el.currentTime = 0; });

async function apLoad(ui) {
  apStop();
  AP.scope = ui.scope;
  const tok = AP.tok, a = AP.el;
  let blob = null; try { blob = await ui.getBlob(); } catch (_) {}
  if (tok !== AP.tok) return false;
  if (!blob) { showToast('Файл не найден'); return false; }
  if (globalThis.KanbanMedia?.postMessage && globalThis.crypto?.randomUUID) {
    const id = AP.nativeId = crypto.randomUUID();
    try {
      const result = await stageNativeMedia(id, blob, () => AP.tok === tok);
      if (tok !== AP.tok) return false;
      if (result.dur <= 0) throw new Error('Длительность записи неизвестна');
      AP.id = ui.key;
      AP.nativeState = result;
      apSync();
      return true;
    } catch (_) {
      if (tok !== AP.tok) return false;
      mediaDiscard(id);
      AP.nativeId = null;
    }
  }
  AP.url = createTrackedURL(blob); AP.id = ui.key;
  a.src = AP.url; a.defaultPlaybackRate = a.playbackRate = AP.rate;
  await new Promise(res => { const d = () => { a.removeEventListener('loadedmetadata', d); a.removeEventListener('error', d); res(); }; a.addEventListener('loadedmetadata', d); a.addEventListener('error', d); setTimeout(d, 4000); });
  if (tok !== AP.tok) return false;
  // WebM из MediaRecorder приходит без длительности — «лечим», чтобы работала перемотка
  if (a.duration === Infinity) await new Promise(res => { a.addEventListener('timeupdate', function h() { a.removeEventListener('timeupdate', h); a.currentTime = 0; res(); }); a.currentTime = 1e7; setTimeout(res, 1500); });
  if ('mediaSession' in navigator) try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: String(ui.name || 'Аудио').replace(/\.[a-z0-9]+$/i, ''), artist: 'Comrade' });
    navigator.mediaSession.setActionHandler('play', () => a.play());
    navigator.mediaSession.setActionHandler('pause', () => a.pause());
  } catch (_) {}
  return true;
}
async function apPlay(ui, fr) {
  const a = AP.el;
  if (AP.id !== ui.key || (!AP.nativeId && !a.src)) { ui.root.classList.add('loading'); const ok = await apLoad(ui); ui.root.classList.remove('loading'); if (!ok) return; }
  if (AP.nativeId) {
    try { mediaCommand(AP.nativeId, 'play', { fraction: fr, rate: AP.rate }); }
    catch (_) { showToast('Не удалось воспроизвести запись'); }
    return;
  }
  const d = isFinite(a.duration) ? a.duration : ui.dur;
  if (fr != null && d) a.currentTime = fr * d;
  try { await a.play(); } catch (_) { showToast('Не удалось воспроизвести запись'); }
}
function apToggle(ui) {
  if (AP.id !== ui.key || !apState(ui)?.playing) { void apPlay(ui); return; }
  if (AP.nativeId) mediaCommand(AP.nativeId, 'pause'); else AP.el.pause();
}
function apStop(scope) {
  if (scope && AP.scope !== scope) return;
  if (AP.nativeId) mediaDiscard(AP.nativeId);
  AP.nativeId = AP.nativeState = null;
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
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (AP.id !== key) return;
      const offset = e.key === 'ArrowRight' ? 5 : -5;
      if (AP.nativeId) mediaCommand(AP.nativeId, 'seek', { offset: offset * 1000 });
      else AP.el.currentTime = Math.max(0, AP.el.currentTime + offset);
    }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); apToggle(ui); }
  };
  const nm = root.querySelector('.ap-name'); if (nm && o.onRename) { nm.style.cursor = 'pointer'; nm.title = 'Переименовать'; nm.onclick = o.onRename; }
  if (sp) sp.onclick = () => {
    AP.rate = AP.rate === 1 ? 1.5 : AP.rate === 1.5 ? 2 : 1;
    if (AP.nativeId && AP.nativeState) mediaCommand(AP.nativeId, 'rate', { rate: AP.rate });
    else AP.el.defaultPlaybackRate = AP.el.playbackRate = AP.rate;
    apSync();
  };
  AP.uis.add(ui); ui.render(apState(ui));
  return root;
}

function renderAudioList() {
  const box = $('#audioList'); if (!box) return;
  box.innerHTML = '';
  const resultBoxes = new Map();
  for (const row of $('#taskResultsList').children) {
    const target = row.querySelector('.result-audio-list');
    if (target) { target.replaceChildren(); resultBoxes.set(row.dataset.resultId, target); }
  }
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
    row.appendChild(rm); (resultBoxes.get(old ? f.resultId : f._resultId) || box).appendChild(row);
  });
}

// Android owns microphone capture. WebView only controls and receives the final file.
const rec = { id: null, session: null, resultId: '', starting: false, active: false,
  finishing: false, paused: false, ready: null, done: null, resolve: null, lv: [] };
function bindAudio() {
  $('#recStartBtn').onclick = () => recStart();
  $('#recStop').onclick = () => recStop();
  $('#recCancel').onclick = recAbort;
  $('#recPause').onclick = recPause;
}
function voiceCommand(id, type) {
  try { window.KanbanVoice.postMessage(JSON.stringify({ id, type })); return true; }
  catch (_) { return false; }
}
function voicePromise() {
  if (!rec.done) rec.done = new Promise(resolve => { rec.resolve = resolve; });
  return rec.done;
}
function voiceResolve(ok) {
  const resolve = rec.resolve;
  rec.done = rec.resolve = null;
  if (resolve) resolve(ok);
}
function voicePanel() {
  $('#recPanel').hidden = !rec.id;
  $('#recStartBtn').hidden = !!rec.id;
  $('#recPause').disabled = !rec.active || rec.finishing;
  $('#recPause').textContent = rec.paused ? 'Продолжить' : 'Пауза';
  $('#recStop').disabled = rec.starting || rec.finishing;
  $('#recStop').textContent = rec.ready && !rec.finishing ? 'Повторить' : rec.finishing ? 'Сохранение…' : 'Готово';
}
function voiceReset(ok) {
  voiceResolve(ok);
  Object.assign(rec, { id: null, session: null, resultId: '', starting: false,
    active: false, finishing: false, paused: false, ready: null, lv: [] });
  voicePanel();
}
function voiceStillInEditor(id) {
  return rec.id === id && rec.session === tempResults && $('#taskModal').classList.contains('open') &&
    (!rec.resultId || tempResults.some(r => r.id === rec.resultId));
}
function recStart(resultId = '') {
  if (rec.id || savingTask) return;
  if (resultId && !tempResults.some(r => r.id === resultId)) return;
  if (!window.KanbanVoice?.postMessage) { showToast('Нативная запись недоступна в этой сборке'); return; }
  apStop();
  const id = 'voice_' + generateId();
  Object.assign(rec, { id, session: tempResults, resultId, starting: true, lv: [] });
  $('#recTime').textContent = '0:00';
  $('#recLevels').replaceChildren();
  voicePanel();
  if (resultId) $('#recPanel').scrollIntoView({ block: 'nearest' });
  if (!voiceCommand(id, 'start')) { voiceReset(false); showToast('Не удалось запустить диктофон Android'); }
}
function recPause() {
  if (!rec.active || rec.finishing) return;
  if (!voiceCommand(rec.id, rec.paused ? 'resume' : 'pause')) showToast('Не удалось переключить паузу');
}
function recStop() {
  if (!rec.id) return Promise.resolve(true);
  if (rec.starting) return Promise.resolve(false);
  if (rec.finishing) return voicePromise();
  const pending = voicePromise();
  rec.finishing = true;
  voicePanel();
  if (rec.ready) void receiveVoiceFile(rec.id);
  else if (!voiceCommand(rec.id, 'stop')) {
    rec.finishing = false; voicePanel(); voiceResolve(false);
    showToast('Не удалось остановить диктофон');
  }
  return pending;
}
function recAbort() {
  if (!rec.id) return;
  voiceCommand(rec.id, 'cancel');
  voiceReset(false);
}
function voiceLevel(ms, level) {
  $('#recTime').textContent = fmtDur(ms / 1000);
  if (rec.paused) return;
  const n = 40, box = $('#recLevels');
  rec.lv.push(Math.min(1, Math.max(0, Number(level) || 0)));
  if (rec.lv.length > n) rec.lv.shift();
  if (box.children.length !== n) box.innerHTML = '<i></i>'.repeat(n);
  const last = rec.lv;
  [...box.children].forEach((el, i) => {
    const v = last[i - (n - last.length)];
    el.style.height = (v == null ? 6 : Math.max(8, Math.sqrt(v) * 100)) + '%';
  });
}
async function receiveVoiceFile(id) {
  const ready = rec.ready;
  if (!ready || !voiceStillInEditor(id)) return;
  try {
    const response = await fetch('/voice-capture/' + encodeURIComponent(ready.token), { cache: 'no-store' });
    if (!response.ok) throw new Error('Файл записи недоступен');
    const blob = await response.blob();
    if (blob.size !== ready.size || blob.size === 0 || blob.size > MAX_VIDEO_SIZE) throw new Error('Запись передана не полностью');
    if (!voiceStillInEditor(id)) return;
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const file = new File([blob], `Запись ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}-${p(d.getMinutes())}.m4a`, { type: 'audio/mp4' });
    file._dur = ready.ms / 1000;
    file._meta = { dur: file._dur, peaks: ready.peaks || [] };
    if (rec.resultId) file._resultId = rec.resultId;
    newFiles.push(file);
    // Acknowledge only after the complete attachment is staged in this editor.
    voiceCommand(id, 'ack');
    voiceReset(true);
    renderFiles();
  } catch (error) {
    if (!voiceStillInEditor(id)) return;
    rec.finishing = false;
    voiceResolve(false);
    voicePanel();
    showToast('Не удалось получить запись. Нажмите «Повторить»: ' + error.message, null, null, 7000);
  }
}
window.kanbanVoiceNativeResult = function(payload) {
  let event;
  try { event = JSON.parse(payload); } catch (_) { return; }
  if (event.id !== rec.id) return;
  if (!voiceStillInEditor(event.id)) { recAbort(); return; }
  switch (event.type) {
    case 'started':
      rec.starting = false; rec.active = true; voicePanel(); break;
    case 'paused':
    case 'resumed':
      rec.paused = event.type === 'paused';
      voiceLevel(event.ms, 0); voicePanel(); break;
    case 'level':
      voiceLevel(event.ms, event.level); break;
    case 'ready':
      if (rec.ready) return;
      if (!/^[a-f0-9-]{36}$/.test(event.token) || !Number.isSafeInteger(event.size) ||
          event.size <= 0 || event.size > MAX_VIDEO_SIZE || !Number.isFinite(event.ms)) {
        recAbort(); showToast('Некорректный файл записи'); return;
      }
      rec.starting = rec.active = rec.paused = false;
      rec.ready = event;
      rec.finishing = true; voicePromise(); voicePanel();
      void receiveVoiceFile(event.id); break;
    case 'cancelled':
      voiceReset(false); break;
    case 'error':
      voiceReset(false); showToast(event.message || 'Ошибка диктофона Android', null, null, 7000); break;
  }
};

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
  loadUIState();
  updateBoardSelect();

  // Open the cross-board plan without changing board filters or task fields.
  $('#myDayBtn').onclick = () => { void comradeOpenDailyPlan(); };
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
  reminderUiReady = true;
  void openReminderTask();

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
  $('#quickAdd').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (await quickAddTask(e.target.value)) e.target.value = '';
  });
  bindDailyPlan();
  registerServiceWorker();
}

init();
})();


(() => {
'use strict';

// ============================================================
// CONSTANTS
// ============================================================
const DB_NAME = 'kanban_db_v2';
const DB_VERSION = 1;
const STORE_TASKS = 'tasks';
const STORE_SETTINGS = 'settings';
const STORE_MEDIA = 'media';
const VALID_VIEWS = ['kanban', 'dashboard', 'mindmap', 'calendar', 'search'];

const DEFAULT_COLUMNS = () => ([
  { id: 'col_todo',     title: 'To Do',       color: '#a3a3a3', isDone: false, wipLimit: 0 },
  { id: 'col_progress', title: 'In Progress', color: '#60a5fa', isDone: false, wipLimit: 0 },
  { id: 'col_done',     title: 'Done',        color: '#34d399', isDone: true,  wipLimit: 0 }
]);

const PRIORITY_LABELS = { none: 'Без', low: 'Низкий', medium: 'Средний', high: 'Высокий' };
const PRIORITY_ORDER = { high: 3, medium: 2, low: 1, none: 0 };
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;
const IMG_MAX_DIM = 1600;
const IMG_THUMB_DIM = 320;
const IMG_QUALITY = 0.82;
const ALLOWED_IMAGE_MIME = ['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif'];
const ALLOWED_VIDEO_MIME = ['video/mp4','video/webm','video/quicktime','video/x-m4v'];
const LEGACY_KEYS = ['kanban_tasks_v2', 'kanban_tasks_v3', 'kanban_data_v4'];
const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DONE_TITLE_RE = /(done|выполн|готов|заверш|finish|complete)/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNDO_TTL = 5500;

// ============================================================
// STATE
// ============================================================
let db = null;

let state = {
  boards: [],
  activeBoardId: '',
  boardName: '',
  columns: [],
  tasks: [],
  _tasksByBoard: {}
};

let currentView = 'kanban';
let theme = 'light';
let searchQuery = '';
let filterTag = '';
let filterPriority = '';
let sortMode = 'manual';
let filterDeadline = '';
let calendarCursor = new Date();

let drag = null;
let lastPointer = { x: 0, y: 0 };
let autoScrollInterval = null;
let autoScrollDir = { x: 0, y: 0 };
let lastDragEndTime = 0;

let editingTaskId = null;
let editingPriority = 'none';
let tempChecklist = [];
let tempFiles = [], newFiles = [];
const mm = { k: 1, x: 40, y: 40, sel: null, nodes: {}, ptrs: new Map(), down: null, drag: null, pinch: null, lastTap: null, fitBoard: '' };
let modalInitialSnapshot = null;
let lastFocusBeforeModal = null;
let editingBoardName = '';
let editingColumns = [];

const undoStack = [];
let lightboxToken = 0;
const thumbCache = new Map();
const objectURLs = new Set();
const pendingMediaDeletes = new Map();

let broadcast = null;
try { broadcast = new BroadcastChannel('kanban_sync'); } catch (_) {}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ============================================================
// BOARDS: core helpers
// ============================================================
function getBoard(id) { return state.boards.find(b => b.id === id); }
function getActiveBoard() { return getBoard(state.activeBoardId); }

const cardsOnly = () => state.tasks.filter(t => !t.parentId);
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ';
const kids = (pid, colId) => state.tasks.filter(t => t.parentId === pid && (pid || t.columnId === colId)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
function subtree(id) { const out = []; (function walk(p) { state.tasks.forEach(t => { if (t.parentId === p) { out.push(t); walk(t.id); } }); })(id); return out; }
function normalizeTree(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t])), fix = [];
  for (const t of tasks) {
    let top = t; const seen = new Set([t.id]);
    while (top.parentId) {
      const p = byId.get(top.parentId);
      if (!p || seen.has(p.id)) { top.parentId = ''; if (!fix.includes(top)) fix.push(top); break; }
      seen.add(p.id); top = p;
    }
    if (top !== t && t.columnId !== top.columnId) { t.columnId = top.columnId; if (!fix.includes(t)) fix.push(t); }
  }
  return fix;
}
async function syncKids(t) {
  const ch = subtree(t.id).filter(d => d.columnId !== t.columnId).map(d => applyColumnChange(d, t.columnId));
  if (!ch.length) return;
  await persistTaskChanges(ch);
}

function applyActiveBoard() {
  const b = getActiveBoard();
  if (!b) return;
  state.boardName = b.name;
  state.columns = b.columns;
  state.tasks = state._tasksByBoard[b.id] || (state._tasksByBoard[b.id] = []);
  updateBoardSelect();
}

function updateBoardSelect() {
  const sel = $('#boardSelect');
  if (!sel) return;
  sel.innerHTML = state.boards.map(b =>
    `<option value="${escapeHtml(b.id)}"${b.id === state.activeBoardId ? ' selected' : ''}>${escapeHtml(b.name)}</option>`
  ).join('');
}

async function persistBoards() {
  await dbPutSettingsBulk([
    ['boards', state.boards],
    ['activeBoardId', state.activeBoardId]
  ]);
}

async function switchBoard(id) {
  if (!getBoard(id) || id === state.activeBoardId) return;
  if ($('#taskModal').classList.contains('open')) closeModal('taskModal');
  state.activeBoardId = id;
  applyActiveBoard();
  try { await persistBoards(); } catch (e) { showToast('Не сохранилось: ' + e.message); }
  renderBoard();
  saveUIState();
  notifyOtherTabs();
}

async function addBoard(name) {
  const board = sanitizeBoard({
    id: 'board_' + generateId(),
    name: (name || '').trim() || 'Новая доска',
    columns: DEFAULT_COLUMNS()
  });
  state.boards.push(board);
  state._tasksByBoard[board.id] = [];
  try { await persistBoards(); }
  catch (e) {
    state.boards = state.boards.filter(b => b.id !== board.id);
    delete state._tasksByBoard[board.id];
    showToast('Не удалось создать доску: ' + e.message); return;
  }
  await switchBoard(board.id);
  showToast(`Доска «${board.name}» создана`);
}

async function deleteBoard(id) {
  if (state.boards.length <= 1) { showToast('Нельзя удалить единственную доску'); return; }
  const board = getBoard(id);
  if (!board) return;
  const tasks = state._tasksByBoard[id] || [];
  const msg = tasks.length
    ? `Удалить «${board.name}» и ${tasks.length} задач? Это нельзя отменить.`
    : `Удалить доску «${board.name}»?`;
  const ok = await confirmDialog('Удалить доску', msg);
  if (!ok) return;

  try {
    if (tasks.length) await dbDeleteTasks(tasks.map(t => t.id));
    const wasActive = state.activeBoardId === id;
    state.boards = state.boards.filter(b => b.id !== id);
    delete state._tasksByBoard[id];
    if (wasActive) state.activeBoardId = state.boards[0].id;
    await persistBoards();
    tasks.forEach(t => { syncNativeReminder({ ...t, reminder: '' }); t.files.forEach(f => scheduleMediaDelete(f.id, 0)); });
  } catch (e) {
    showToast('Ошибка удаления: ' + e.message);
    return;
  }

  applyActiveBoard();
  renderBoard();
  saveUIState();
  notifyOtherTabs();
  showToast('Доска удалена');
}

// ============================================================
// UTILITIES
// ============================================================
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function truncate(s, max) {
  if (!s || s.length <= max) return s || '';
  const slice = s.slice(0, max);
  const sp = slice.lastIndexOf(' ');
  return (sp > max * 0.6 ? slice.slice(0, sp) : slice).trim() + '…';
}
function createTrackedURL(blob) { const url = URL.createObjectURL(blob); objectURLs.add(url); return url; }
function revokeTrackedURL(url) { if (!url) return; URL.revokeObjectURL(url); objectURLs.delete(url); }
function revokeAllTrackedURLs() { for (const url of objectURLs) URL.revokeObjectURL(url); objectURLs.clear(); }
window.addEventListener('pagehide', revokeAllTrackedURLs);

function isValidISODate(str) {
  if (!str) return true;
  if (!DATE_RE.test(str)) return false;
  const d = parseISO(str);
  return !isNaN(d.getTime()) && toISO(d) === str;
}
function isAllowedMediaType(type) {
  if (!type) return false;
  return ALLOWED_IMAGE_MIME.includes(type) || ALLOWED_VIDEO_MIME.includes(type);
}

// ============================================================
// DATES
// ============================================================
const MONTHS = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
const MONTHS_FULL = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const DAYS_SHORT = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function toISO(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function todayISO() { return toISO(new Date()); }
function dayDiff(iso) {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((parseISO(iso) - t) / 86400000);
}
function formatDate(iso) {
  const d = parseISO(iso);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

// ============================================================
// INDEXEDDB
// ============================================================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_TASKS)) {
        const st = d.createObjectStore(STORE_TASKS, { keyPath: 'id' });
        st.createIndex('columnId', 'columnId');
      }
      if (!d.objectStoreNames.contains(STORE_SETTINGS)) d.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      if (!d.objectStoreNames.contains(STORE_MEDIA)) d.createObjectStore(STORE_MEDIA);
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); showToast('База обновлена в другой вкладке. Перезагрузите страницу.'); };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('База заблокирована. Закройте другие вкладки.'));
  });
}
function wrapTxError(e) {
  if (!e) return new Error('Неизвестная ошибка БД');
  if (e.name === 'QuotaExceededError' || (e.inner && e.inner.name === 'QuotaExceededError'))
    return new Error('Хранилище переполнено. Удалите старые вложения или очистите доску.');
  if (e.name === 'AbortError') return new Error('Транзакция отменена');
  return e;
}
async function dbGetAllTasks() {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_TASKS, 'readonly');
    const req = tx.objectStore(STORE_TASKS).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(wrapTxError(req.error));
  });
}
async function dbPutTask(task) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_TASKS, 'readwrite');
    tx.objectStore(STORE_TASKS).put(task);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(wrapTxError(tx.error));
    tx.onabort = () => rej(wrapTxError(tx.error));
  });
}
async function dbPutTasks(tasks) {
  if (!tasks.length) return;
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_TASKS, 'readwrite');
    const st = tx.objectStore(STORE_TASKS);
    tasks.forEach(t => st.put(t));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(wrapTxError(tx.error));
    tx.onabort = () => rej(wrapTxError(tx.error));
  });
}
async function dbDeleteTask(id) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_TASKS, 'readwrite');
    tx.objectStore(STORE_TASKS).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(wrapTxError(tx.error));
  });
}
async function dbDeleteTasks(ids) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_TASKS, 'readwrite');
    ids.forEach(id => tx.objectStore(STORE_TASKS).delete(id));
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(wrapTxError(tx.error));
  });
}
async function dbGetSettings() {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const req = tx.objectStore(STORE_SETTINGS).getAll();
    req.onsuccess = () => { const map = {}; req.result.forEach(r => map[r.key] = r.value); res(map); };
    req.onerror = () => rej(wrapTxError(req.error));
  });
}
async function dbPutSettingsBulk(entries) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    const st = tx.objectStore(STORE_SETTINGS);
    entries.forEach(([k, v]) => st.put({ key: k, value: v }));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(wrapTxError(tx.error));
    tx.onabort = () => rej(wrapTxError(tx.error));
  });
}
async function dbClearActiveBoardTasks(boardId) {
  const tasks = state._tasksByBoard[boardId] || [];
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_TASKS, 'readwrite');
    const st = tx.objectStore(STORE_TASKS);
    tasks.forEach(t => st.delete(t.id));
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(wrapTxError(tx.error));
  });
}
async function dbReplaceAll(plan) {
  return new Promise((res, rej) => {
    const tx = db.transaction([STORE_TASKS, STORE_SETTINGS, STORE_MEDIA], 'readwrite');
    try {
      const ts = tx.objectStore(STORE_TASKS);
      const ss = tx.objectStore(STORE_SETTINGS);
      const ms = tx.objectStore(STORE_MEDIA);
      ts.clear(); ss.clear(); ms.clear();
      plan.tasks.forEach(t => ts.put(t));
      ss.put({ key: 'boards', value: plan.boards });
      ss.put({ key: 'activeBoardId', value: plan.activeBoardId });
      for (const [id, m] of Object.entries(plan.media)) {
        ms.put({ full: m.full, thumb: m.thumb, type: m.type }, id);
      }
    } catch (e) {
      try { tx.abort(); } catch (_) {}
      rej(wrapTxError(e));
      return;
    }
    tx.oncomplete = () => res();
    tx.onerror = () => rej(wrapTxError(tx.error));
    tx.onabort = () => rej(new Error('Импорт отменён'));
  });
}
async function mediaPut(id, blob, thumb, type) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_MEDIA, 'readwrite');
    tx.objectStore(STORE_MEDIA).put({ full: blob, thumb, type }, id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(wrapTxError(tx.error));
    tx.onabort = () => rej(wrapTxError(tx.error));
  });
}
async function mediaGet(id) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_MEDIA, 'readonly');
    const req = tx.objectStore(STORE_MEDIA).get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(wrapTxError(req.error));
  });
}
async function mediaDelete(id) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_MEDIA, 'readwrite');
    tx.objectStore(STORE_MEDIA).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(wrapTxError(tx.error));
  });
}
async function mediaGetAllKeys() {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_MEDIA, 'readonly');
    const req = tx.objectStore(STORE_MEDIA).getAllKeys();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(wrapTxError(req.error));
  });
}
async function mediaCleanupOrphans() {
  try {
    if (document.querySelector('.modal.open') || drag) return;
    const keys = await mediaGetAllKeys();
    const used = new Set();
    Object.values(state._tasksByBoard).forEach(arr => arr.forEach(t => t.files.forEach(f => used.add(f.id))));
    for (const k of keys) if (!used.has(k) && !pendingMediaDeletes.has(k)) await mediaDelete(k);
  } catch (e) { console.warn('mediaCleanupOrphans', e); }
}
function scheduleMediaDelete(mediaId, delay = UNDO_TTL) {
  if (!mediaId) return;
  const existing = pendingMediaDeletes.get(mediaId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(async () => {
    pendingMediaDeletes.delete(mediaId);
    thumbCache.delete(mediaId);
    try { await mediaDelete(mediaId); } catch (_) {}
  }, delay);
  pendingMediaDeletes.set(mediaId, t);
}
function cancelMediaDelete(mediaId) {
  if (!mediaId) return;
  const t = pendingMediaDeletes.get(mediaId);
  if (t) { clearTimeout(t); pendingMediaDeletes.delete(mediaId); }
}

// ============================================================
// UNDO STACK
// ============================================================
function pushUndo(op) {
  const entry = { id: generateId(), ...op, expiresAt: Date.now() + UNDO_TTL };
  undoStack.push(entry);
  const now = Date.now();
  for (let i = undoStack.length - 1; i >= 0; i--) {
    if (undoStack[i].expiresAt <= now) {
      const exp = undoStack.splice(i, 1)[0];
      try { exp.onExpire?.(); } catch (_) {}
    }
  }
  return entry.id;
}
function consumeUndo(id) {
  const idx = undoStack.findIndex(op => op.id === id);
  if (idx === -1) return null;
  return undoStack.splice(idx, 1)[0];
}

// ============================================================
// CROSS-TAB SYNC
// ============================================================
function notifyOtherTabs() { if (broadcast) broadcast.postMessage({ type: 'changed', at: Date.now() }); }
let syncReloadTimer = null;
function setupBroadcast() {
  if (!broadcast) return;
  broadcast.onmessage = () => {
    clearTimeout(syncReloadTimer);
    if (document.querySelector('.modal.open') || drag) {
      syncReloadTimer = setTimeout(() => broadcast.onmessage && broadcast.onmessage({}), 1500);
      return;
    }
    syncReloadTimer = setTimeout(async () => {
      try { await reloadFromDb(); }
      catch (e) { console.warn('[sync] reload failed', e); }
    }, 200);
  };
}

// ============================================================
// UI STATE
// ============================================================
function saveUIState() {
  try {
    localStorage.setItem('kanban_ui', JSON.stringify({
      sortMode, filterTag, filterDeadline, filterPriority, currentView
    }));
  } catch (_) {}
}
function loadUIState() {
  try {
    const s = JSON.parse(localStorage.getItem('kanban_ui') || '{}');
    const sorts = ['manual','created_desc','created_asc','updated_desc','deadline_asc','priority_desc','title'];
    const deadlines = ['', 'overdue', 'today', 'week', 'none', 'attention'];
    const priorities = ['', 'high', 'medium', 'low', 'none'];
    if (sorts.includes(s.sortMode)) sortMode = s.sortMode;
    if (typeof s.filterTag === 'string') filterTag = s.filterTag;
    if (deadlines.includes(s.filterDeadline)) filterDeadline = s.filterDeadline;
    if (priorities.includes(s.filterPriority)) filterPriority = s.filterPriority;
    if (VALID_VIEWS.includes(s.currentView)) currentView = s.currentView;
  } catch (_) {}
}

// ============================================================
// STORAGE INFO
// ============================================================
async function updateStorageInfo() {
  const el = $('#storageInfo');
  if (!el) return;
  try {
    if (!navigator.storage || !navigator.storage.estimate) { el.textContent = 'Хранилище: ?'; return; }
    const est = await navigator.storage.estimate();
    const usageMB = (est.usage / 1048576).toFixed(1);
    const quotaMB = (est.quota / 1048576).toFixed(0);
    const pct = est.quota ? (est.usage / est.quota * 100) : 0;
    el.textContent = `${usageMB} / ${quotaMB} МБ`;
    el.classList.remove('warn', 'danger');
    if (pct >= 80) el.classList.add('danger');
    else if (pct >= 60) el.classList.add('warn');
    el.title = `Использовано ${usageMB} МБ из ~${quotaMB} МБ (${pct.toFixed(1)}%)`;
  } catch (_) { el.textContent = 'Хранилище: ?'; }
}

// ============================================================
// SANITIZE
// ============================================================
function sanitizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  return {
    id: String(t.id || generateId()),
    boardId: typeof t.boardId === 'string' ? t.boardId : '',
    columnId: String(t.columnId || t.colId || ''),
    title: String(t.title || t.name || 'Без названия'),
    desc: String(t.desc || t.description || ''),
    tags: Array.isArray(t.tags) ? t.tags.map(String).filter(Boolean) : [],
    priority: PRIORITY_LABELS[t.priority] ? t.priority : 'none',
    deadline: typeof t.deadline === 'string' ? t.deadline : (typeof t.dueDate === 'string' ? t.dueDate : ''),
    reminder: typeof t.reminder === 'string' ? t.reminder : '',
    reminderRepeat: ['daily', 'weekly', 'monthly'].includes(t.reminderRepeat) ? t.reminderRepeat : 'none',
    taskRepeat: ['daily', 'weekly', 'monthly'].includes(t.taskRepeat) ? t.taskRepeat : 'none',
    repeatFrom: typeof t.repeatFrom === 'string' ? t.repeatFrom : '',
    repeatAnchor: typeof t.repeatAnchor === 'string' && DATE_RE.test(t.repeatAnchor) ? t.repeatAnchor : '',
    parentId: typeof t.parentId === 'string' ? t.parentId : '',
    files: Array.isArray(t.files)
      ? t.files.filter(f => f && typeof f.id === 'string').map(f => ({ id: f.id, name: String(f.name || 'Файл'), type: String(f.type || ''), size: +f.size || 0, ...(+f.dur ? { dur: +f.dur } : {}), ...(Array.isArray(f.peaks) ? { peaks: f.peaks.slice(0, 96).map(n => Math.max(0, Math.min(100, +n || 0))) } : {}) }))
      : (typeof t.mediaId === 'string' ? [{ id: t.mediaId, name: 'Вложение', type: String(t.mediaType || ''), size: 0 }] : []),
    checklist: Array.isArray(t.checklist)
      ? t.checklist.map(c => c && typeof c === 'object' ? {
          id: String(c.id || 'cl_' + generateId()),
          text: String(c.text || ''),
          checked: !!(c.checked || c.done)
        } : null).filter(c => c && c.text)
      : [],
    order: typeof t.order === 'number' ? t.order : 0,
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : Date.now(),
    completedAt: typeof t.completedAt === 'number' ? t.completedAt : null
  };
}
function sanitizeColumn(c) {
  const title = String((c && c.title) || 'Колонка');
  return {
    id: String((c && c.id) || 'col_' + generateId()),
    title,
    color: typeof (c && c.color) === 'string' && COLOR_RE.test(c.color) ? c.color : '#a3a3a3',
    isDone: typeof (c && c.isDone) === 'boolean' ? c.isDone : DONE_TITLE_RE.test(title),
    wipLimit: (typeof (c && c.wipLimit) === 'number' && c.wipLimit > 0) ? Math.floor(c.wipLimit) : 0
  };
}
function sanitizeBoard(b) {
  return {
    id: String((b && b.id) || 'board_' + generateId()),
    name: String((b && b.name) || 'Доска'),
    columns: Array.isArray(b && b.columns) && b.columns.length ? b.columns.map(sanitizeColumn) : DEFAULT_COLUMNS()
  };
}

// ============================================================
// COMPLETED-AT
// ============================================================
function computeCompletedAt(oldColId, newColId, existingValue) {
  const oldCol = state.columns.find(c => c.id === oldColId);
  const newCol = state.columns.find(c => c.id === newColId);
  if (newCol && newCol.isDone && (!oldCol || !oldCol.isDone)) return Date.now();
  if (oldCol && oldCol.isDone && (!newCol || !newCol.isDone)) return null;
  return existingValue || null;
}
function applyColumnChange(task, newColumnId) {
  return {
    ...task,
    columnId: newColumnId,
    updatedAt: Date.now(),
    completedAt: computeCompletedAt(task.columnId, newColumnId, task.completedAt)
  };
}

// ============================================================
// LOAD
// ============================================================
function tryLoadLegacyTasks() {
  for (const key of LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    } catch (_) {}
  }
  return null;
}
function mapLegacyColumn(oldId, columns) {
  if (!oldId) return columns[0].id;
  if (columns.some(c => c.id === oldId)) return oldId;
  const map = { todo: 0, inprogress: 1, done: 2 };
  const idx = map[oldId];
  if (typeof idx === 'number' && columns[idx]) return columns[idx].id;
  return columns[0].id;
}

function rebucket(allTasks, boards, activeBoardId) {
  state.boards = boards;
  state.activeBoardId = activeBoardId;

  const byId = {};
  boards.forEach(b => { byId[b.id] = []; });
  const fallback = boards[0].id;
  const toFix = [];

  const seen = new Set();
  for (const raw of allTasks) {
    const t = sanitizeTask(raw);
    if (!t) continue;
    if (seen.has(t.id)) continue;
    seen.add(t.id);

    let bid = t.boardId;
    if (!bid || !byId[bid]) {
      bid = fallback;
      t.boardId = bid;
      toFix.push(t);
    }
    byId[bid].push(t);
    if (raw.mediaId && !Array.isArray(raw.files) && !toFix.includes(t)) toFix.push(t);
  }

  boards.forEach(b => toFix.push(...normalizeTree(byId[b.id])));
  state._tasksByBoard = byId;
  return toFix;
}

async function loadData() {
  try {
    const rawTasks = await dbGetAllTasks();
    const settings = await dbGetSettings();

    let boards = [];
    if (Array.isArray(settings.boards) && settings.boards.length) {
      boards = settings.boards.map(sanitizeBoard);
    } else if (settings.boardName || settings.columns) {
      boards = [sanitizeBoard({
        id: 'board_main',
        name: settings.boardName || 'Моя доска',
        columns: Array.isArray(settings.columns) && settings.columns.length
          ? settings.columns : DEFAULT_COLUMNS()
      })];
    } else {
      boards = [sanitizeBoard({ id: 'board_main', name: 'Моя доска' })];
    }

    if (rawTasks.length === 0) {
      const legacy = tryLoadLegacyTasks();
      if (legacy && legacy.length) {
        const fallbackBoard = boards[0];
        legacy.forEach((t, i) => {
          if (!t || typeof t !== 'object') return;
          rawTasks.push({
            ...t,
            id: t.id || generateId(),
            boardId: fallbackBoard.id,
            columnId: mapLegacyColumn(t.colId || t.columnId, fallbackBoard.columns),
            order: typeof t.order === 'number' ? t.order : i
          });
        });
      }
    }

    let activeId = settings.activeBoardId;
    if (!activeId || !boards.some(b => b.id === activeId)) activeId = boards[0].id;

    const toFix = rebucket(rawTasks, boards, activeId);
    if (toFix.length) {
      try { await dbPutTasks(toFix); } catch (e) { console.warn('orphans', e); }
    }

    const colFix = [];
    for (const b of state.boards) {
      const validCols = new Set(b.columns.map(c => c.id));
      for (const t of state._tasksByBoard[b.id]) {
        if (!validCols.has(t.columnId)) {
          t.columnId = b.columns[0].id;
          t.updatedAt = Date.now();
          colFix.push(t);
        }
      }
    }
    if (colFix.length) {
      try { await dbPutTasks(colFix); } catch (e) { console.warn(e); }
    }

    if (!Array.isArray(settings.boards) || !settings.boards.length) {
      await dbPutSettingsBulk([
        ['boards', state.boards],
        ['activeBoardId', state.activeBoardId]
      ]);
    }

    applyActiveBoard();
  } catch (e) {
    console.error('loadData', e);
    showToast('Не удалось загрузить данные: ' + (e.message || ''));
  }
}

async function reloadFromDb() {
  const rawTasks = await dbGetAllTasks();
  const settings = await dbGetSettings();
  const boards = Array.isArray(settings.boards) && settings.boards.length
    ? settings.boards.map(sanitizeBoard)
    : [sanitizeBoard({ id: 'board_main', name: settings.boardName || 'Моя доска',
        columns: settings.columns || DEFAULT_COLUMNS() })];
  let activeId = settings.activeBoardId;
  if (!activeId || !boards.some(b => b.id === activeId)) activeId = boards[0].id;

  rebucket(rawTasks, boards, activeId);
  applyActiveBoard();
  thumbCache.clear();
  renderBoard();
}

// ============================================================
// FILTER / SORT
// ============================================================
function getVisibleTasks() {
  const q = searchQuery.trim().toLowerCase();
  const doneColIds = new Set(state.columns.filter(c => c.isDone).map(c => c.id));
  return state.tasks.filter(t => {
    if (t.parentId) return false;
    if (filterTag && !t.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())) return false;
    if (filterPriority) {
      if (filterPriority === 'none') { if (t.priority !== 'none') return false; }
      else if (t.priority !== filterPriority) return false;
    }
    if (filterDeadline) {
      if (filterDeadline === 'none') { if (t.deadline) return false; }
      else {
        if (!t.deadline) return false;
        const diff = dayDiff(t.deadline);
        if (filterDeadline === 'attention') { if (diff > 0 || doneColIds.has(t.columnId)) return false; }
        else if (filterDeadline === 'overdue') { if (diff >= 0 || doneColIds.has(t.columnId)) return false; }
        else if (filterDeadline === 'today') { if (diff !== 0 || doneColIds.has(t.columnId)) return false; }
        else if (filterDeadline === 'week') { if (diff < 0 || diff > 6 || doneColIds.has(t.columnId)) return false; }
      }
    }
    if (q) {
      const checklistText = t.checklist.map(c => c.text).join(' ');
      const hay = (t.title + ' ' + t.desc + ' ' + t.tags.join(' ') + ' ' + checklistText).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
function sortTasks(list) {
  const copy = [...list];
  switch (sortMode) {
    case 'created_desc': return copy.sort((a, b) => b.createdAt - a.createdAt);
    case 'created_asc':  return copy.sort((a, b) => a.createdAt - b.createdAt);
    case 'updated_desc': return copy.sort((a, b) => b.updatedAt - a.updatedAt);
    case 'deadline_asc':
      return copy.sort((a, b) => {
        if (!a.deadline && !b.deadline) return 0;
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return a.deadline.localeCompare(b.deadline);
      });
    case 'priority_desc':
      return copy.sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority] || 0;
        const pb = PRIORITY_ORDER[b.priority] || 0;
        if (pa !== pb) return pb - pa;
        return b.updatedAt - a.updatedAt;
      });
    case 'title': return copy.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    case 'manual':
    default: return copy.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
}
function getAllTags() {
  const set = new Set();
  state.tasks.forEach(t => t.tags.forEach(tag => set.add(tag)));
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}
function isDragAllowed() {
  return sortMode === 'manual' && !searchQuery.trim() && !filterTag && !filterDeadline && !filterPriority;
}

// ============================================================
// THUMB CACHE
// ============================================================
async function getThumb(mediaId) {
  if (!mediaId) return null;
  if (thumbCache.has(mediaId)) return thumbCache.get(mediaId);
  try {
    const m = await mediaGet(mediaId);
    const thumb = m ? (m.thumb || null) : null;
    if (thumb) thumbCache.set(mediaId, thumb);
    return thumb;
  } catch (_) { return null; }
}

// GLOBAL SEARCH
// Search every persisted board, including nested tasks. Local board filters
// remain independent, so finding a task cannot silently discard their state.
function searchAllBoards(query, limit = 100, filters = {}) {
  const words = String(query || '').normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const boardFilter = filters.boardId || '';
  const statusFilter = filters.status || '';
  const deadlineFilter = filters.deadline || '';
  if (!words.length && !boardFilter && !statusFilter && !deadlineFilter) return undefined;
  const items = [];
  for (const board of state.boards) {
    if (boardFilter && board.id !== boardFilter) continue;
    const doneColumns = new Set(board.columns.filter(c => c.isDone).map(c => c.id));
    for (const task of state._tasksByBoard[board.id] || []) {
      if (statusFilter === 'done' && !doneColumns.has(task.columnId)) continue;
      if (statusFilter === 'active' && doneColumns.has(task.columnId)) continue;
      if (deadlineFilter) {
        if (deadlineFilter === 'none') { if (task.deadline) continue; }
        else {
          if (!task.deadline || doneColumns.has(task.columnId)) continue;
          const days = dayDiff(task.deadline);
          if (deadlineFilter === 'overdue' && days >= 0) continue;
          if (deadlineFilter === 'attention' && days > 0) continue;
          if (deadlineFilter === 'today' && days !== 0) continue;
          if (deadlineFilter === 'week' && (days < 0 || days > 6)) continue;
        }
      }
      const title = String(task.title || '').normalize('NFKC').toLocaleLowerCase();
      const boardName = String(board.name || '').normalize('NFKC').toLocaleLowerCase();
      const description = String(task.desc || '').normalize('NFKC').toLocaleLowerCase();
      const tags = (task.tags || []).join(' ').normalize('NFKC').toLocaleLowerCase();
      const checklist = (task.checklist || []).map(item => item.text || '').join(' ')
        .normalize('NFKC').toLocaleLowerCase();
      const all = [title, boardName, description, tags, checklist].join(' ');
      if (!words.every(word => all.includes(word))) continue;
      // Prefer an exact task-title match, followed by title and description.
      const score = words.reduce((sum, word) =>
        sum + (title === word ? 12 : title.includes(word) ? 6 :
          description.includes(word) ? 3 : tags.includes(word) ? 2 : 1), 0);
      items.push({ board, task, score });
    }
  }
  items.sort((a, b) => b.score - a.score ||
    (b.task.updatedAt || 0) - (a.task.updatedAt || 0));
  return { total: items.length, items: items.slice(0, Math.max(1, limit)) };
}

function updateGlobalSearchBoardFilter() {
  const select = $('#globalSearchBoardFilter');
  const selected = select.value;
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Все доски';
  select.replaceChildren(all);
  for (const board of state.boards) {
    const option = document.createElement('option');
    option.value = board.id;
    option.textContent = board.name;
    select.appendChild(option);
  }
  select.value = state.boards.some(board => board.id === selected) ? selected : '';
}

function renderGlobalSearch() {
  updateGlobalSearchBoardFilter();
  const input = $('#globalSearchInput');
  const results = $('#globalSearchResults');
  const summary = $('#globalSearchSummary');
  const empty = $('#globalSearchEmpty');
  const match = searchAllBoards(input.value, 100, {
    boardId: $('#globalSearchBoardFilter').value,
    status: $('#globalSearchStatusFilter').value,
    deadline: $('#globalSearchDeadlineFilter').value
  });
  results.replaceChildren();
  empty.hidden = !!match && match.total !== 0;
  if (!match) {
    summary.textContent = 'Поиск по всем доскам, включая вложенные задачи';
    empty.textContent = 'Введите название, слово из описания, тег или пункт чек-листа';
    return;
  }
  summary.textContent = 'Найдено задач: ' + match.total +
    (match.total > match.items.length ? ' · показаны первые ' + match.items.length : '');
  if (!match.total) {
    empty.textContent = 'Ничего не найдено. Попробуйте другое слово.';
    return;
  }
  for (const { board, task } of match.items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'global-search-result';
    // Completed and fresh recurring occurrences have identical visible titles.
    // Give the new occurrence a unique accessible label for navigation.
    item.setAttribute('aria-label', 'Открыть: ' + task.title +
      (task.repeatFrom ? ' (повтор)' : '') + ', доска ' + board.name);
    const title = document.createElement('span');
    title.className = 'global-search-result-title';
    title.textContent = task.title;
    const metadata = document.createElement('span');
    metadata.className = 'global-search-result-meta';
    const column = board.columns.find(c => c.id === task.columnId);
    metadata.textContent = board.name + ' · ' + (column?.title || 'Задача') +
      (task.parentId ? ' · Вложенная' : '') +
      (task.deadline ? ' · 📅 ' + task.deadline : '');
    item.appendChild(title);
    item.appendChild(metadata);
    item.addEventListener('click', () => { void openGlobalSearchResult(board.id, task.id); });
    results.appendChild(item);
  }
}

async function openGlobalSearchResult(boardId, taskId) {
  const board = state.boards.find(b => b.id === boardId);
  if (!board || !(state._tasksByBoard[boardId] || []).some(t => t.id === taskId)) {
    showToast('Задача не найдена');
    renderGlobalSearch();
    return;
  }
  try {
    if (state.activeBoardId !== boardId) await switchBoard(boardId);
    if (!state.tasks.some(t => t.id === taskId)) throw new Error('Задача не найдена');
    switchView('kanban');
    openTaskModal(taskId);
  } catch (error) {
    showToast('Не удалось открыть задачу: ' + (error.message || error));
  }
}

// ============================================================
// RENDER dispatcher
// ============================================================
function renderBoard() {
  updateTagFilter();
  const board = $('#board');
  const scrolls = {};
  $$('.task-list', board).forEach(el => { scrolls[el.dataset.columnId] = el.scrollTop; });
  const boardScroll = board.scrollLeft;
  board.innerHTML = '';
  const visible = getVisibleTasks();

  state.columns.forEach(col => {
    const colTasks = sortTasks(visible.filter(t => t.columnId === col.id));
    const totalCount = state.tasks.filter(t => t.columnId === col.id && !t.parentId).length;

    const colDiv = document.createElement('div');
    colDiv.className = 'column';
    colDiv.dataset.columnId = col.id;

    let wipCls = '';
    if (col.wipLimit && totalCount > col.wipLimit) wipCls = ' wip-exceeded';
    else if (col.wipLimit && totalCount >= col.wipLimit) wipCls = ' wip-warning';

    const header = document.createElement('div');
    header.className = 'column-header' + wipCls;
    const wipSuffix = col.wipLimit ? `/${col.wipLimit}` : '';
    header.innerHTML = `
      <span class="col-status-dot" style="background:${escapeHtml(col.color)}"></span>
      <span class="column-title">${escapeHtml(col.title)}</span>
      <span class="column-count">${totalCount}${wipSuffix}</span>
    `;
    colDiv.appendChild(header);

    const list = document.createElement('div');
    list.className = 'task-list';
    list.dataset.columnId = col.id;

    if (colTasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-hint';
      empty.textContent = totalCount === 0 ? 'Нет задач' : 'Ничего не найдено';
      list.appendChild(empty);
    } else {
      colTasks.forEach(task => list.appendChild(createTaskCard(task, col)));
    }
    colDiv.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.className = 'add-task-btn';
    addBtn.textContent = '+ Добавить задачу';
    addBtn.onclick = () => openTaskModal(null, col.id);
    colDiv.appendChild(addBtn);

    board.appendChild(colDiv);
    if (scrolls[col.id] !== undefined) list.scrollTop = scrolls[col.id];
  });

  board.scrollLeft = boardScroll;
  updateStorageInfo();

  if (currentView === 'search') renderGlobalSearch();
  if (currentView === 'dashboard') renderDashboard();
  else if (currentView === 'mindmap') renderMindmap();
  else if (currentView === 'calendar') renderCalendar();
}

function createTaskCard(task, column) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.dataset.taskId = task.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  // A recurring copy has the same visible title as its completed predecessor.
  // Distinguish it for screen readers and Android UI regression assertions.
  card.setAttribute('aria-label', task.title + (task.repeatFrom ? ' (повтор)' : ''));
  card.style.setProperty('--status-color', column.color);

  const descHtml = task.desc ? `<div class="task-description">${escapeHtml(truncate(task.desc, 120))}</div>` : '';
  let mediaHtml = '';
  const imgF = task.files.find(f => f.type.startsWith('image/'));
  if (imgF) {
    const cached = thumbCache.get(imgF.id);
    mediaHtml = cached ? `<img class="task-media-thumb" data-media="1" alt="" src="${escapeHtml(cached)}">`
      : `<div class="task-media-thumb" data-media="1" data-thumb-for="${escapeHtml(imgF.id)}"></div>`;
  }
  const kidsN = subtree(task.id).length;
  const tagsHtml = task.tags.length
    ? `<div class="task-tags">${task.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  let checklistHtml = '';
  if (task.checklist.length) {
    const total = task.checklist.length;
    const done = task.checklist.filter(c => c.checked).length;
    const pct = Math.round((done / total) * 100);
    checklistHtml = `<div class="checklist-progress"><span>☑ ${done}/${total}</span><div class="checklist-bar"><div class="checklist-fill" style="width:${pct}%"></div></div></div>`;
  }
  let deadlineHtml = '';
  if (task.deadline) {
    const diff = dayDiff(task.deadline);
    const cls = 'task-footer-item' + ((!column.isDone && diff < 0) ? ' overdue' : (!column.isDone && diff === 0 ? ' today' : ''));
    deadlineHtml = `<span class="${cls}">📅 ${escapeHtml(formatDate(task.deadline))}</span>`;
  }
  const priorityHtml = task.priority && task.priority !== 'none'
    ? `<span class="task-priority p-${escapeHtml(task.priority)}">${escapeHtml(PRIORITY_LABELS[task.priority])}</span>` : '';

  card.innerHTML = `
    <div class="task-title">${escapeHtml(task.title)}</div>
    ${descHtml}${mediaHtml}${task.files.some(isAudio) ? '<div class="task-audio"></div>' : ''}${tagsHtml}${checklistHtml}
    <div class="task-footer">
      ${deadlineHtml}${task.taskRepeat && task.taskRepeat !== 'none'
        ? `<span class="task-footer-item" title="Повторяющаяся задача">🔁 ${escapeHtml({daily:'Ежедневно',weekly:'Еженедельно',monthly:'Ежемесячно'}[task.taskRepeat] || '')}</span>`
        : ''}${priorityHtml}${task.files.length ? `<span class="task-footer-item" title="Файлы">📎 ${task.files.length}</span>` : ''}${kidsN ? `<span class="task-footer-item" title="Вложенные узлы">⑂ ${kidsN}</span>` : ''}
      <span class="task-id">#${escapeHtml(task.id.slice(-4))}</span>
    </div>
    <div class="task-quick-actions">
      <button class="task-quick-btn" data-move-next="1" title="В следующую колонку" aria-label="В следующую колонку">→</button>
      <button class="task-quick-btn" data-move-done="1" title="Отметить выполненной" aria-label="Отметить выполненной: ${escapeHtml(task.title)}">✓</button>
      <button class="task-quick-btn danger" data-delete="1" title="Удалить" aria-label="Удалить задачу">×</button>
    </div>`;

  const thumbPlaceholder = card.querySelector('[data-thumb-for]');
  if (thumbPlaceholder) {
    const mediaId = thumbPlaceholder.dataset.thumbFor;
    getThumb(mediaId).then(thumb => {
      if (!thumbPlaceholder.isConnected) return;
      if (!thumb) { thumbPlaceholder.remove(); return; }
      const img = document.createElement('img');
      img.className = 'task-media-thumb'; img.alt = ''; img.loading = 'lazy'; img.src = thumb;
      img.dataset.media = '1';
      img.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(task); });
      thumbPlaceholder.replaceWith(img);
    });
  }
  const audSlot = card.querySelector('.task-audio');
  if (audSlot) {
    const au = task.files.filter(isAudio);
    audSlot.appendChild(createAudioPlayer(au[0], { compact: true, scope: 'card', getBlob: async () => (await mediaGet(au[0].id))?.full }));
    if (au.length > 1) audSlot.insertAdjacentHTML('beforeend', `<span class="ap-more">+${au.length - 1}</span>`);
  }
  card.querySelector('[data-delete]').onclick = (e) => { e.stopPropagation(); deleteTask(task.id); };
  card.querySelector('[data-move-next]').onclick = (e) => { e.stopPropagation(); moveCardToAdjacentColumn(task.id, +1); };
  card.querySelector('[data-move-done]').onclick = (e) => { e.stopPropagation(); markTaskDone(task.id); };
  card.querySelectorAll('[data-media]').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(task); });
  });
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-delete], [data-media], [data-move-next], [data-move-done], .ap')) return;
    if (Date.now() - lastDragEndTime < 250) return;
    openTaskModal(task.id);
  });
  card.addEventListener('keydown', (e) => {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTaskModal(task.id); }
    else if (e.key === '[') { e.preventDefault(); moveCardToAdjacentColumn(task.id, -1); }
    else if (e.key === ']') { e.preventDefault(); moveCardToAdjacentColumn(task.id, +1); }
  });
  return card;
}

function topOrder(colId) {
  const o = state.tasks.filter(t => t.columnId === colId).map(t => t.order ?? 0);
  return o.length ? Math.min(...o) - 1 : 0;
}
async function moveCardToAdjacentColumn(taskId, delta) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  const idx = state.columns.findIndex(c => c.id === task.columnId);
  if (idx === -1) return;
  const newIdx = Math.max(0, Math.min(state.columns.length - 1, idx + delta));
  if (newIdx === idx) return;
  const targetCol = state.columns[newIdx];
  const candidate = applyColumnChange(task, targetCol.id);
  candidate.order = topOrder(targetCol.id);
  try { await persistTaskChanges([candidate]); }
  catch (e) { showToast('Не удалось переместить: ' + e.message); return; }
  await syncKids(candidate).catch(() => {});
  notifyOtherTabs();
  renderBoard();
}
async function markTaskDone(taskId) {
  const doneCol = state.columns.find(c => c.isDone);
  if (!doneCol) { showToast('Нет колонки «Готово»'); return; }
  const idx = state.tasks.findIndex(t => t.id === taskId);
  if (idx === -1 || state.tasks[idx].columnId === doneCol.id) return;
  const candidate = applyColumnChange(state.tasks[idx], doneCol.id);
  candidate.order = topOrder(doneCol.id);
  try { await persistTaskChanges([candidate]); }
  catch (e) { showToast('Не удалось переместить: ' + e.message); return; }
  await syncKids(candidate).catch(() => {});
  notifyOtherTabs();
  renderBoard();
}

function updateTagFilter() {
  const sel = $('#tagFilter');
  const tags = getAllTags();
  sel.innerHTML = '<option value="">Все теги</option>' + tags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  if (filterTag && tags.includes(filterTag)) sel.value = filterTag;
  else { sel.value = ''; filterTag = ''; }
}

// ============================================================
// MINDMAP
// ============================================================
const mmKids = k => k === 'root' ? state.columns.map(c => ['col:' + c.id, c])
  : (k.startsWith('col:') ? kids('', k.slice(4)) : kids(k.slice(5))).map(t => ['task:' + t.id, t]);
function mmBezier(x1, y1, x2, y2) { const mx = (x1 + x2) / 2; return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`; }

/* --- Сворачивание веток --- */
function getCollapsedKeys() {
  try { return new Set(JSON.parse(localStorage.getItem('kanban_collapsed_' + state.activeBoardId) || '[]')); }
  catch (_) { return new Set(); }
}
function saveCollapsedKeys(set) {
  try { localStorage.setItem('kanban_collapsed_' + state.activeBoardId, JSON.stringify([...set])); } catch (_) {}
}
function toggleCollapse(key) {
  const s = getCollapsedKeys();
  s.has(key) ? s.delete(key) : s.add(key);
  saveCollapsedKeys(s);
  renderMindmap();
}

function mmPositionKey() { return 'kanban_mindmap_positions_' + state.activeBoardId; }
function mmSavedPositions() {
  try {
    const data = JSON.parse(localStorage.getItem(mmPositionKey()) || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (_) { return {}; }
}
function mmSavePosition(key, x, cy) {
  if (!Number.isFinite(x) || !Number.isFinite(cy)) return;
  const positions = mmSavedPositions();
  positions[key] = { x, cy };
  try { localStorage.setItem(mmPositionKey(), JSON.stringify(positions)); }
  catch (e) { showToast('Не удалось сохранить положение узла'); }
}
function mmLayout() {
  const ROW = 50, XG = 70, nodes = {}, edges = [];
  const collapsed = getCollapsedKeys();
  // Size each node to its complete label, including room for attachment badges.
  // Reserve the widest node at each depth so adjacent levels never overlap.
  const measure = document.createElement('canvas').getContext('2d');
  const widths = {};
  const labelOf = (key, item, depth) => depth === 0 ? state.boardName
    : key.startsWith('col:') ? `${item.title} · ${kids('', item.id).length}` : item.title;
  const measureWidth = (key, item, depth) => {
    const files = key.startsWith('task:') ? (item.files?.length || 0) : 0;
    measure.font = `${depth < 2 ? '600 ' : ''}13px sans-serif`;
    return Math.max(120, Math.ceil(measure.measureText(labelOf(key, item, depth)).width) + 24 + (files ? 54 : 0));
  };
  const collectWidths = (key, depth, item) => {
    widths[depth] = Math.max(widths[depth] || 0, measureWidth(key, item, depth));
    if (!collapsed.has(key)) mmKids(key).forEach(([childKey, child]) => collectWidths(childKey, depth + 1, child));
  };
  collectWidths('root', 0, null);
  const xOf = d => { let x = 0; for (let i = 0; i < d; i++) x += widths[i] + XG; return x; };
  let row = 0;
  const place = (key, d, item, color) => {
    const c = key.startsWith('col:') ? item.color : color;
    const allKids = mmKids(key);
    const ch = collapsed.has(key) ? [] : allKids;
    let cy;
    if (!ch.length) cy = row++ * ROW;
    else {
      const ys = ch.map(([k, it]) => { const y = place(k, d + 1, it, c); edges.push([key, k]); return y; });
      cy = (ys[0] + ys[ys.length - 1]) / 2;
    }
    nodes[key] = { key, d, item, x: xOf(d), w: measureWidth(key, item, d), cy, color: c,
      hasKids: allKids.length > 0, isCollapsed: collapsed.has(key) };
    return cy;
  };
  place('root', 0, null, null);
  const positions = mmSavedPositions();
  Object.values(nodes).forEach(n => {
    const saved = positions[n.key];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.cy)) {
      n.x = saved.x; n.cy = saved.cy;
    }
  });
  return { nodes, edges };
}
function mmApply() { $('#mmVp')?.setAttribute('transform', `translate(${mm.x} ${mm.y}) scale(${mm.k})`); }
function mmZoom(f, cx, cy) {
  const k = Math.min(3, Math.max(0.1, mm.k * f)); f = k / mm.k;
  mm.x = cx - (cx - mm.x) * f; mm.y = cy - (cy - mm.y) * f; mm.k = k; mmApply();
}
function mmFit() {
  const r = $('#mindmapSvg').getBoundingClientRect(), ns = Object.values(mm.nodes);
  if (!ns.length || !r.width) return;
  const x0 = Math.min(...ns.map(n => n.x)), x1 = Math.max(...ns.map(n => n.x + n.w + (n.hasKids ? 24 : 0)));
  const y0 = Math.min(...ns.map(n => n.cy)) - 19, y1 = Math.max(...ns.map(n => n.cy)) + 19;
  mm.k = Math.max(0.1, Math.min(1, (r.width - 40) / (x1 - x0), (r.height - 100) / (y1 - y0)));
  mm.x = 20 - x0 * mm.k; mm.y = (r.height - (y1 - y0) * mm.k) / 2 - y0 * mm.k;
  mmApply();
}
function renderMindmap() {
  const svg = $('#mindmapSvg');
  if (!svg) return;
  const { nodes, edges } = mmLayout(), NH = 38;
  mm.nodes = nodes;
  if (mm.sel && !nodes[mm.sel]) mm.sel = null;
  let h = '<defs><pattern id="mmGrid" width="40" height="40" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--border-strong)"/></pattern></defs><rect x="-50000" y="-50000" width="100000" height="100000" fill="url(#mmGrid)" opacity=".7"/>';
  edges.forEach(([a, b]) => {
    const A = nodes[a], B = nodes[b];
    h += `<path data-edge-from="${escapeHtml(a)}" data-edge-to="${escapeHtml(b)}" d="${mmBezier(A.x + A.w, A.cy, B.x, B.cy)}" fill="none" stroke="${escapeHtml(B.color || 'var(--border-strong)')}" stroke-width="1.6" opacity=".55"/>`;
  });
  Object.values(nodes).forEach(n => {
    const t = n.key.startsWith('task:') ? n.item : null;
    const cls = n.d === 0 ? 'mm-root' : t ? 'mm-task' : 'mm-col', nf = t ? t.files.length : 0;
    const label = n.d === 0 ? state.boardName : t ? t.title : `${n.item.title} · ${kids('', n.item.id).length}`;
    const toggle = n.hasKids
      ? `<g class="mm-toggle" data-toggle="${escapeHtml(n.key)}"><circle cx="${n.x + n.w + 12}" cy="${n.cy}" r="10" fill="var(--surface)" stroke="var(--border-strong)" stroke-width="1.5"/><text x="${n.x + n.w + 12}" y="${n.cy}" text-anchor="middle" dominant-baseline="central" font-size="12" fill="var(--text-muted)" font-weight="600">${n.isCollapsed ? '+' : '−'}</text></g>`
      : '';
    h += `<g class="mm-node ${cls}${mm.sel === n.key ? ' sel' : ''}${nf ? ' has-files' : ''}" data-key="${escapeHtml(n.key)}" style="--status-color:${escapeHtml(n.color || 'var(--text)')}"><rect x="${n.x}" y="${n.cy - NH / 2}" width="${n.w}" height="${NH}" rx="8"/><text x="${n.x + 12}" y="${n.cy}" dominant-baseline="middle">${escapeHtml(label)}</text>${nf ? `<g class="mm-badge" data-files="${escapeHtml(t.id)}"><rect x="${n.x + n.w - 48}" y="${n.cy - 11}" width="42" height="22" rx="11"/><text x="${n.x + n.w - 27}" y="${n.cy}" text-anchor="middle" dominant-baseline="middle">📎${nf}</text></g>` : ''}${toggle}</g>`;
  });
  svg.innerHTML = `<g id="mmVp">${h}</g>`;
  if (mm.fitBoard !== state.activeBoardId) { mmFit(); if (svg.getBoundingClientRect().width) mm.fitBoard = state.activeBoardId; }
  mmApply(); mmUpdateBar();
}
function mmUpdateBar() {
  const bar = $('#mmBar'), k = mm.sel, ok = k && mm.nodes[k], isT = ok && k.startsWith('task:');
  bar.hidden = !ok;
  if (!ok) return;
  bar.querySelector('[data-a="add"]').hidden = k === 'root';
  bar.querySelector('[data-a="file"]').hidden = !isT;
  bar.querySelector('[data-a="del"]').hidden = !isT;
}
function mmOpen(key) { if (key.startsWith('task:')) openTaskModal(key.slice(5)); else openSettingsModal(); }
// App-styled replacement for browser prompt(), matching the task dialogs.
function askForText(title, initialValue = '', maxLength = 200) {
  return new Promise(resolve => {
    const modal = document.getElementById('textPromptModal');
    const input = document.getElementById('textPromptInput');
    const heading = document.getElementById('textPromptTitle');
    const form = document.getElementById('textPromptForm');
    const previousFocus = document.activeElement;
    heading.textContent = title;
    input.value = initialValue;
    input.maxLength = maxLength;
    modal.classList.add('open');
    function finish(value) {
      modal.classList.remove('open');
      form.removeEventListener('submit', submit);
      modal.removeEventListener('keydown', keydown);
      modal.removeEventListener('click', backdrop);
      document.getElementById('textPromptCancel').removeEventListener('click', cancel);
      document.getElementById('textPromptClose').removeEventListener('click', cancel);
      previousFocus?.focus?.();
      resolve(value);
    }
    function submit(event) { event.preventDefault(); finish(input.value.trim()); }
    function cancel() { finish(null); }
    function backdrop(event) { if (event.target === modal) cancel(); }
    function keydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
      if (event.key === 'Tab') {
        const controls = [input, document.getElementById('textPromptCancel'), document.getElementById('textPromptSubmit'), document.getElementById('textPromptClose')];
        const i = controls.indexOf(document.activeElement);
        if (event.shiftKey && i === 0) { event.preventDefault(); controls[controls.length - 1].focus(); }
        else if (!event.shiftKey && i === controls.length - 1) { event.preventDefault(); controls[0].focus(); }
      }
    }
    form.addEventListener('submit', submit);
    modal.addEventListener('keydown', keydown);
    modal.addEventListener('click', backdrop);
    document.getElementById('textPromptCancel').addEventListener('click', cancel);
    document.getElementById('textPromptClose').addEventListener('click', cancel);
    input.focus();
    input.select();
  });
}
async function mmAdd(key) {
  const title = await askForText('Название узла', '', 200);
  if (!title) return;
  const par = key.startsWith('task:') ? state.tasks.find(t => t.id === key.slice(5)) : null;
  const columnId = par ? par.columnId : key.slice(4), parentId = par ? par.id : '';
  const sib = kids(parentId, columnId);
  const t = sanitizeTask({ id: generateId(), boardId: state.activeBoardId, columnId, parentId, title, order: sib.length ? sib[sib.length - 1].order + 1 : 0 });
  try { await dbPutTask(t); } catch (e) { showToast('Не удалось добавить: ' + e.message); return; }
  state.tasks.push(t); mm.sel = 'task:' + t.id; notifyOtherTabs(); renderBoard();
}
async function mmAttach(id, fs) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const added = [];
  try {
    for (const f of fs) {
      if (f.size > MAX_VIDEO_SIZE) { showToast(`«${f.name}» больше 50 МБ`); continue; }
      added.push(await storeFile(f));
    }
  } catch (e) { added.forEach(a => mediaDelete(a.id).catch(() => {})); showToast('Не удалось сохранить файл: ' + e.message); return; }
  if (!added.length) return;
  const c = { ...t, files: [...t.files, ...added], updatedAt: Date.now() };
  try { await dbPutTask(c); } catch (e) { added.forEach(a => mediaDelete(a.id).catch(() => {})); showToast('Не удалось сохранить: ' + e.message); return; }
  state.tasks[state.tasks.indexOf(t)] = c; notifyOtherTabs(); renderBoard();
  showToast(`Прикреплено файлов: ${added.length}`);
}
async function mmMove(id, tk) {
  const t = state.tasks.find(x => x.id === id), par = tk.startsWith('task:') ? state.tasks.find(x => x.id === tk.slice(5)) : null;
  if (!t || (tk.startsWith('task:') && !par)) return renderMindmap();

  /* --- Перестановка соседних узлов (сиблинги) --- */
  if (par && t.parentId === par.parentId && t.columnId === par.columnId) {
    const sibs = kids(t.parentId, t.columnId);
    const srcIdx = sibs.findIndex(s => s.id === id);
    const tgtIdx = sibs.findIndex(s => s.id === par.id);
    if (srcIdx === -1 || tgtIdx === -1 || srcIdx === tgtIdx) return renderMindmap();
    const reordered = [...sibs];
    const [picked] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, picked);
    const changed = [];
    reordered.forEach((s, i) => {
      if ((s.order ?? 0) !== i) {
        changed.push({ ...s, order: i, updatedAt: s.id === id ? Date.now() : s.updatedAt });
      }
    });
    if (!changed.length) return renderMindmap();
    const put = list => list.forEach(m => { const i = state.tasks.findIndex(x => x.id === m.id); if (i > -1) state.tasks[i] = m; syncNativeReminder(m); });
    try { await dbPutTasks(changed); }
    catch (e) { showToast('Не удалось переместить: ' + e.message); return renderMindmap(); }
    put(changed);
    mm.sel = 'task:' + id;
    notifyOtherTabs(); renderBoard();
    return;
  }

  /* --- Смена родителя / колонки --- */
  const columnId = par ? par.columnId : tk.slice(4), parentId = par ? par.id : '';
  if (t.parentId === parentId && t.columnId === columnId) return renderMindmap();
  const sib = kids(parentId, columnId);
  const moved = [{ ...applyColumnChange(t, columnId), parentId, order: sib.length ? sib[sib.length - 1].order + 1 : 0 }];
  subtree(id).filter(d => d.columnId !== columnId).forEach(d => moved.push(applyColumnChange(d, columnId)));
  const prev = moved.map(m => state.tasks.find(x => x.id === m.id));
  const put = list => list.forEach(m => { const i = state.tasks.findIndex(x => x.id === m.id); if (i > -1) state.tasks[i] = m; });
  try { await dbPutTasks(moved); } catch (e) { showToast('Не удалось переместить: ' + e.message); return renderMindmap(); }
  put(moved); mm.sel = 'task:' + id; notifyOtherTabs(); renderBoard();
  showToast(`«${truncate(t.title, 30)}» перемещён`, 'Отменить', async () => {
    try { await dbPutTasks(prev); } catch (e) { showToast('Не удалось отменить: ' + e.message); return; }
    put(prev); notifyOtherTabs(); renderBoard();
  }, 5000);
}
function mmStartDrag() {
  const dn = mm.down;
  if (!dn || !dn.key || mm.drag || !mm.nodes[dn.key]) return;
  const node = mm.nodes[dn.key];
  mm.drag = { key: dn.key, x: node.x, cy: node.cy };
  $('#mmVp').querySelector(`[data-key="${CSS.escape(dn.key)}"]`)?.classList.add('mm-dragging');
}
function mmDragMove(e) {
  const dn = mm.down, drag = mm.drag;
  if (!dn || !drag) return;
  const dx = (e.clientX - dn.x) / mm.k, dy = (e.clientY - dn.y) / mm.k;
  const node = mm.nodes[drag.key];
  node.x = drag.x + dx; node.cy = drag.cy + dy;
  const vp = $('#mmVp');
  vp.querySelector(`[data-key="${CSS.escape(drag.key)}"]`)?.setAttribute('transform', `translate(${dx} ${dy})`);
  vp.querySelectorAll('[data-edge-from], [data-edge-to]').forEach(path => {
    if (path.dataset.edgeFrom !== drag.key && path.dataset.edgeTo !== drag.key) return;
    const a = mm.nodes[path.dataset.edgeFrom], b = mm.nodes[path.dataset.edgeTo];
    if (a && b) path.setAttribute('d', mmBezier(a.x + a.w, a.cy, b.x, b.cy));
  });
}
function mmBind() {
  const svg = $('#mindmapSvg');
  const loc = e => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const [x, y] = loc(e);
    if (e.ctrlKey || e.metaKey) mmZoom(Math.exp(-e.deltaY * 0.01), x, y);
    else { mm.x -= e.deltaX; mm.y -= e.deltaY; mmApply(); }
  }, { passive: false });
  svg.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    /* toggle: сворачивание/разворачивание ветки */
    const toggleKey = e.target.closest('[data-toggle]')?.dataset.toggle;
    if (toggleKey) { e.preventDefault(); toggleCollapse(toggleKey); return; }
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    mm.ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (mm.ptrs.size === 2) {
      clearTimeout(mm.down?.timer); mm.down = null;
      if (mm.drag) { mm.drag = null; renderMindmap(); }
      const [a, b] = [...mm.ptrs.values()];
      mm.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 };
      return;
    }
    if (mm.ptrs.size > 2) return;
    const key = e.target.closest('.mm-node')?.dataset.key, fileTask = e.target.closest('.mm-badge')?.dataset.files;
    mm.down = { id: e.pointerId, x: e.clientX, y: e.clientY, px: mm.x, py: mm.y, key, fileTask, moved: false,
      cand: !!key && !fileTask, touch: e.pointerType !== 'mouse', timer: null };
    /* Dragging starts after a small movement; no long press needed. */
  });
  svg.addEventListener('pointermove', e => {
    if (!mm.ptrs.has(e.pointerId)) return;
    mm.ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (mm.pinch && mm.ptrs.size === 2) {
      const [a, b] = [...mm.ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, r = svg.getBoundingClientRect();
      mm.x += cx - mm.pinch.cx; mm.y += cy - mm.pinch.cy;
      mmZoom(d / mm.pinch.d, cx - r.left, cy - r.top);
      mm.pinch = { d, cx, cy };
      return;
    }
    const dn = mm.down;
    if (!dn || dn.id !== e.pointerId) return;
    if (mm.drag) { mmDragMove(e); return; }
    if (Math.hypot(e.clientX - dn.x, e.clientY - dn.y) > 6) {
      dn.moved = true;
      if (dn.cand) { mmStartDrag(); if (mm.drag) mmDragMove(e); return; }
      clearTimeout(dn.timer);
      mm.x = dn.px + e.clientX - dn.x; mm.y = dn.py + e.clientY - dn.y; mmApply();
    }
  });
  const end = async e => {
    mm.ptrs.delete(e.pointerId);
    if (mm.ptrs.size < 2) mm.pinch = null;
    const dn = mm.down;
    if (!dn || dn.id !== e.pointerId) return;
    clearTimeout(dn.timer); mm.down = null;
    if (mm.drag) {
      const d = mm.drag; mm.drag = null;
      if (e.type === 'pointerup') {
        const node = mm.nodes[d.key];
        if (node) mmSavePosition(d.key, node.x, node.cy);
        mm.sel = d.key;
      }
      renderMindmap();
      return;
    }
    if (dn.moved || e.type === 'pointercancel') return;
    if (dn.fileTask) { openTaskModal(dn.fileTask); setTimeout(() => $('#taskFile').scrollIntoView({ block: 'center' }), 80); return; }
    const now = Date.now();
    if (dn.key && mm.lastTap && mm.lastTap.key === dn.key && now - mm.lastTap.t < 400) { mm.lastTap = null; mmOpen(dn.key); return; }
    mm.lastTap = { key: dn.key, t: now };
    mm.sel = dn.key || null; renderMindmap();
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  $$('.mm-zoom [data-z]').forEach(b => b.onclick = () => {
    const r = svg.getBoundingClientRect();
    if (b.dataset.z === 'fit') mmFit(); else mmZoom(+b.dataset.z, r.width / 2, r.height / 2);
  });
  $('#mmBar').onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a, k = mm.sel;
    if (!a || !k) return;
    if (a === 'add') await mmAdd(k);
    else if (a === 'edit') mmOpen(k);
    else if (a === 'file') $('#mmFile').click();
    else if (a === 'del') { mm.sel = null; await deleteTask(k.slice(5)); }
  };
  $('#mmFile').onchange = async e => {
    const fs = [...e.target.files]; e.target.value = '';
    if (mm.sel && mm.sel.startsWith('task:')) await mmAttach(mm.sel.slice(5), fs);
  };
}

// ============================================================
// CALENDAR
// ============================================================
function renderCalendar() {
  const grid = $('#calGrid');
  const title = $('#calTitle');
  const cursor = calendarCursor;
  const year = cursor.getFullYear(), month = cursor.getMonth();
  title.textContent = `${MONTHS_FULL[month]} ${year}`;
  const doneColIds = new Set(state.columns.filter(c => c.isDone).map(c => c.id));
  const visible = state.tasks;
  const byDate = {};
  visible.forEach(t => { if (!t.deadline) return; (byDate[t.deadline] = byDate[t.deadline] || []).push(t); });
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();
  const today = todayISO();
  const cells = [];
  for (let i = startOffset - 1; i >= 0; i--) cells.push({ date: toISO(new Date(year, month - 1, prevMonthDays - i)), other: true, num: prevMonthDays - i });
  for (let day = 1; day <= daysInMonth; day++) cells.push({ date: toISO(new Date(year, month, day)), other: false, num: day });
  while (cells.length % 7 !== 0) {
    const day = cells.length - startOffset - daysInMonth + 1;
    cells.push({ date: toISO(new Date(year, month + 1, day)), other: true, num: day });
  }
  let html = DAYS_SHORT.map(h => `<div class="cal-day-head">${h}</div>`).join('');
  cells.forEach(cell => {
    const sorted = sortTasks(byDate[cell.date] || []);
    const shown = sorted.slice(0, 3);
    const more = sorted.length - shown.length;
    const cls = ['cal-day'];
    if (cell.other) cls.push('other-month');
    if (cell.date === today) cls.push('today');
    html += `<div class="${cls.join(' ')}" data-date="${cell.date}">
      <div class="cal-day-num">${cell.num}</div>
      ${shown.map(t => {
        const col = state.columns.find(c => c.id === t.columnId);
        const isDone = doneColIds.has(t.columnId);
        return `<div class="cal-task${isDone ? ' done' : ''}" data-task="${escapeHtml(t.id)}" style="--status-color:${col ? escapeHtml(col.color) : 'var(--text-subtle)'}" title="${escapeHtml(t.title)}">${escapeHtml(truncate(t.title, 18))}</div>`;
      }).join('')}
      ${more > 0 ? `<div class="cal-more">+${more} ещё</div>` : ''}
    </div>`;
  });
  grid.innerHTML = html;
  grid.querySelectorAll('[data-task]').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); openTaskModal(el.dataset.task); });
  });
  grid.querySelectorAll('[data-date]').forEach(el => {
    el.addEventListener('click', () => {
      const date = el.dataset.date;
      openTaskModal(null, state.columns[0]?.id, { deadline: date });
    });
  });
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  const total = cardsOnly().length;
  const doneCols = new Set(state.columns.filter(c => c.isDone).map(c => c.id));
  const progressCols = new Set(state.columns.filter(c => !c.isDone && c.id !== state.columns[0]?.id).map(c => c.id));
  const done = cardsOnly().filter(t => doneCols.has(t.columnId)).length;
  const inProgress = cardsOnly().filter(t => progressCols.has(t.columnId)).length;
  const overdue = cardsOnly().filter(t => {
    if (!t.deadline) return false;
    if (doneCols.has(t.columnId)) return false;
    return dayDiff(t.deadline) < 0;
  }).length;

  $('#kpiGrid').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Всего задач</div><div class="kpi-value">${total}</div><div class="kpi-sub">на доске</div></div>
    <div class="kpi-card"><div class="kpi-label">В работе</div><div class="kpi-value">${inProgress}</div><div class="kpi-sub">активных</div></div>
    <div class="kpi-card"><div class="kpi-label">Завершено</div><div class="kpi-value">${done}</div><div class="kpi-sub">${total ? Math.round(done / total * 100) : 0}% от всех</div></div>
    <div class="kpi-card"><div class="kpi-label">Просрочено</div><div class="kpi-value${overdue > 0 ? ' danger' : ''}">${overdue}</div><div class="kpi-sub">${overdue > 0 ? 'требует внимания' : 'всё в порядке'}</div></div>`;

  const pct = total ? Math.round(done / total * 100) : 0;
  $('#progressFill').style.width = pct + '%';
  $('#progressText').textContent = `${done} из ${total} задач завершено`;
  $('#progressPercent').textContent = pct + '%';

  const chart = $('#statusChart');
  chart.innerHTML = '';
  if (!total) chart.innerHTML = '<div class="dashboard-empty">Нет задач для отображения</div>';
  else state.columns.forEach(col => {
    const count = cardsOnly().filter(t => t.columnId === col.id).length;
    const p = total ? Math.round(count / total * 100) : 0;
    const row = document.createElement('div');
    row.className = 'status-row';
    row.innerHTML = `<div class="status-row-label"><span class="dot" style="background:${escapeHtml(col.color)}"></span><span>${escapeHtml(col.title)}</span></div><div class="status-row-bar"><div style="width:${p}%;background:${escapeHtml(col.color)}"></div></div><div class="status-row-count">${count}</div>`;
    chart.appendChild(row);
  });

  const upcoming = $('#upcomingList');
  const items = cardsOnly().filter(t => t.deadline && !doneCols.has(t.columnId)).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 8);
  upcoming.innerHTML = '';
  if (!items.length) upcoming.innerHTML = '<div class="dashboard-empty">Нет ближайших дедлайнов</div>';
  else items.forEach(t => {
    const diff = dayDiff(t.deadline);
    const cls = diff < 0 ? 'overdue' : (diff <= 2 ? 'soon' : '');
    const col = state.columns.find(c => c.id === t.columnId);
    const el = document.createElement('div');
    el.className = 'upcoming-item ' + cls;
    el.innerHTML = `<span class="upcoming-item-date">${escapeHtml(formatDate(t.deadline))}</span><span class="upcoming-item-title">${escapeHtml(t.title)}</span><span class="upcoming-item-col">${col ? escapeHtml(col.title) : ''}</span>`;
    el.style.cursor = 'pointer';
    el.onclick = () => openTaskModal(t.id);
    upcoming.appendChild(el);
  });

  renderHeatmap();
}
function renderHeatmap() {
  const el = $('#heatmap'), empty = $('#heatmapEmpty');
  if (!el) return;
  const counts = {};
  let hasAny = false;
  cardsOnly().forEach(t => {
    if (!t.completedAt) return;
    const d = new Date(t.completedAt); d.setHours(0,0,0,0);
    const key = toISO(d);
    counts[key] = (counts[key] || 0) + 1;
    hasAny = true;
  });
  if (!hasAny) { el.innerHTML = ''; if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;
  const today = new Date(); today.setHours(0,0,0,0);
  const dow = (today.getDay() + 6) % 7;
  const end = new Date(today); end.setDate(end.getDate() + (6 - dow));
  const days = 12 * 7;
  const start = new Date(end); start.setDate(start.getDate() - (days - 1));
  const max = Math.max(1, ...Object.values(counts));
  let html = '';
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const key = toISO(d);
    const c = counts[key] || 0;
    let level = 0;
    if (c > 0) {
      if (c >= max * 0.75) level = 4;
      else if (c >= max * 0.5) level = 3;
      else if (c >= max * 0.25) level = 2;
      else level = 1;
    }
    const isFuture = d > end;
    html += `<div class="heatmap-cell" data-level="${level}" title="${escapeHtml(isFuture ? '' : `${formatDate(key)}: ${c}`)}"></div>`;
  }
  el.innerHTML = html;
}

// ============================================================
// VIEW SWITCH
// ============================================================
function switchView(view) {
  if (!VALID_VIEWS.includes(view)) view = 'kanban';
  currentView = view;
  $$('.view-tab').forEach(tab => {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $('#kanbanToolbar').style.display = view === 'kanban' ? '' : 'none';
  $('#board').hidden = view !== 'kanban';
  $('#dashboard').hidden = view !== 'dashboard';
  $('#mindmap').hidden = view !== 'mindmap';
  $('#calendar').hidden = view !== 'calendar';
  $('#globalSearch').hidden = view !== 'search';
  if (view === 'dashboard') renderDashboard();
  else if (view === 'mindmap') renderMindmap();
  else if (view === 'calendar') renderCalendar();
  else if (view === 'search') renderGlobalSearch();
  saveUIState();
}

// Native notifications are optional; the browser version remains fully functional.
function syncNativeReminder(task) {
  if (!window.KanbanReminders || !task?.id) return;
  const at = task.reminder && !task.completedAt ? new Date(task.reminder).getTime() : 0;
  try {
    window.KanbanReminders.postMessage(JSON.stringify({
      id: task.id, title: task.title, at: Number.isFinite(at) ? at : 0,
      boardId: task.boardId || '', boardName: getBoard(task.boardId)?.name || 'Моя доска',
      repeat: task.reminderRepeat || 'none'
    }));
  } catch (_) {}
}

// RECURRING TASKS
// Completion creates the next *task*, independently of recurring notifications.
// Store previous and next occurrences atomically; never reuse attachment IDs.
const TASK_REPEAT_VALUES = ['daily', 'weekly', 'monthly'];
const activeTaskWrites = new Set();
function nextTaskRepeatDate(baseISO, repeat, completedAt, anchorISO = baseISO) {
  if (!TASK_REPEAT_VALUES.includes(repeat)) return '';
  const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    toISO(parseISO(s)) === s;
  const done = new Date(completedAt);
  const today = new Date(done.getFullYear(), done.getMonth(), done.getDate());
  const baseline = validDate(baseISO) ? parseISO(baseISO) : today;
  let next;
  if (repeat === 'monthly') {
    const anchor = validDate(anchorISO) ? parseISO(anchorISO) : baseline;
    const anchorDay = anchor.getDate();
    const makeMonth = month => {
      const first = new Date(anchor.getFullYear(), anchor.getMonth() + month, 1);
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      return new Date(first.getFullYear(), first.getMonth(), Math.min(anchorDay, last));
    };
    const monthOffset = (baseline.getFullYear() - anchor.getFullYear()) * 12 +
      baseline.getMonth() - anchor.getMonth();
    next = makeMonth(Math.max(0, monthOffset + 1));
    // Jump straight to near today's month rather than iterating over years.
    if (next <= today) {
      const offset = (today.getFullYear() - anchor.getFullYear()) * 12 +
        today.getMonth() - anchor.getMonth();
      next = makeMonth(Math.max(monthOffset + 1, offset));
      if (next <= today) next = makeMonth(Math.max(monthOffset + 1, offset + 1));
    }
  } else {
    const interval = repeat === 'weekly' ? 7 : 1;
    next = new Date(baseline.getFullYear(), baseline.getMonth(),
      baseline.getDate() + interval);
    if (next <= today) {
      const days = Math.round(
        (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
         Date.UTC(baseline.getFullYear(), baseline.getMonth(), baseline.getDate())) / 86400000
      );
      const jumps = Math.max(1, Math.floor(days / interval) + 1);
      next = new Date(baseline.getFullYear(), baseline.getMonth(),
        baseline.getDate() + jumps * interval);
    }
  }
  return toISO(next);
}
function shiftTaskRepeatDate(value, fromDate, toDate, withTime, completedAt) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return '';
  const old = withTime ? new Date(value) : parseISO(value);
  if (Number.isNaN(old.getTime())) return '';
  const from = parseISO(fromDate), to = parseISO(toDate);
  const diff = Math.round(
    (Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) -
     Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86400000
  );
  old.setDate(old.getDate() + diff);
  // Don't schedule a notification that is already overdue when a task repeats.
  if (withTime && old.getTime() <= completedAt) return '';
  return withTime ? formatTaskLocalDate(old, true) : toISO(old);
}
function makeRecurringTaskCopies(source, boardTasks, board, completedAt, completingIds = new Set()) {
  if (!TASK_REPEAT_VALUES.includes(source.taskRepeat)) return [];
  const reference = /^\d{4}-\d{2}-\d{2}$/.test(source.deadline || '') ? source.deadline
    : (source.reminder ? source.reminder.slice(0, 10) : toISO(new Date(completedAt)));
  const anchor = source.repeatAnchor || reference;
  const nextDate = nextTaskRepeatDate(reference, source.taskRepeat, completedAt, anchor);
  if (!nextDate) return [];
  const todo = board.columns.find(c => !c.isDone);
  if (!todo) return []; // A board with only Done columns cannot host a fresh task.
  const originals = [source];
  const ids = new Set([source.id]);
  let changed;
  do {
    changed = false;
    for (const task of boardTasks) {
      if (!ids.has(task.id) && ids.has(task.parentId)) {
        originals.push(task); ids.add(task.id); changed = true;
      }
    }
  } while (changed);
  const freshIds = new Map(originals.map(t => [t.id, generateId()]));
  const currentOrder = boardTasks.filter(t => !t.parentId && t.columnId === todo.id)
    .map(t => t.order ?? 0);
  const firstOrder = currentOrder.length ? Math.min(...currentOrder) - 1 : 0;
  return originals.map((original, index) => {
    const isRoot = index === 0;
    const parent = boardTasks.find(t => t.id === source.parentId);
    const parentStillOpen = parent && !completingIds.has(parent.id) &&
      board.columns.some(c => c.id === parent.columnId && !c.isDone);
    return {
      ...original,
      id: freshIds.get(original.id),
      parentId: isRoot ? (parentStillOpen ? source.parentId : '') : freshIds.get(original.parentId),
      boardId: source.boardId,
      columnId: todo.id,
      order: isRoot ? firstOrder : original.order,
      createdAt: completedAt,
      updatedAt: completedAt,
      completedAt: null,
      repeatFrom: original.id,
      repeatAnchor: isRoot ? anchor : (original.repeatAnchor || original.deadline || reference),
      deadline: isRoot ? nextDate : shiftTaskRepeatDate(original.deadline, reference, nextDate, false, completedAt),
      reminder: shiftTaskRepeatDate(original.reminder, reference, nextDate, true, completedAt),
      tags: [...(original.tags || [])],
      checklist: (original.checklist || []).map(c => ({
        ...c, id: 'cl_' + generateId(), checked: false
      })),
      // Retain media on the historical occurrence. Sharing IDs risks deletion of
      // an attachment when either copy gets removed.
      files: []
    };
  });
}
// The same atomic helper is used by card actions, drag/drop, modal save, and
// native Mark Done reconciliation. Never update UI state on failed storage.
async function persistTaskChanges(updates, boardTasks = state.tasks,
  board = state.boards.find(b => b.id === state.activeBoardId)) {
  if (!updates.length) return { created: [] };
  if (!board) throw new Error('Доска не найдена');
  const ids = updates.map(t => t.id);
  if (ids.some(id => activeTaskWrites.has(id))) throw new Error('Задача уже сохраняется');
  ids.forEach(id => activeTaskWrites.add(id));
  try {
    const created = [];
    const originalById = new Map(boardTasks.map(t => [t.id, t]));
    // Mark Done may complete a whole subtree in one IndexedDB transaction.
    // Its repeating parent creates the child once; a repeating child must not
    // also create an independent, duplicate occurrence.
    const newlyCompleted = updates.filter(t =>
      t.completedAt && originalById.has(t.id) && !originalById.get(t.id).completedAt);
    const completingIds = new Set(newlyCompleted.map(t => t.id));
    const repeatingCompletingIds = new Set(newlyCompleted
      .filter(t => TASK_REPEAT_VALUES.includes(t.taskRepeat)).map(t => t.id));
    for (const candidate of updates) {
      const original = originalById.get(candidate.id);
      if (!original || original.completedAt || !candidate.completedAt ||
          !TASK_REPEAT_VALUES.includes(candidate.taskRepeat)) continue;
      if (boardTasks.some(t => t.repeatFrom === candidate.id) ||
          created.some(t => t.repeatFrom === candidate.id)) continue;
      let ancestorId = original.parentId;
      const visited = new Set();
      let repeatsWithAncestor = false;
      while (ancestorId && !visited.has(ancestorId)) {
        if (repeatingCompletingIds.has(ancestorId)) {
          repeatsWithAncestor = true;
          break;
        }
        visited.add(ancestorId);
        ancestorId = originalById.get(ancestorId)?.parentId || '';
      }
      if (repeatsWithAncestor) continue;
      created.push(...makeRecurringTaskCopies({
        ...candidate, columnId: original.columnId
      }, boardTasks, board, candidate.completedAt, completingIds));
    }
    const write = [...updates, ...created];
    await dbPutTasks(write);
    for (const task of write) {
      const index = boardTasks.findIndex(t => t.id === task.id);
      if (index >= 0) boardTasks[index] = task;
      else boardTasks.push(task);
      syncNativeReminder(task);
    }
    return { created };
  } finally {
    ids.forEach(id => activeTaskWrites.delete(id));
  }
}

// ============================================================
// TASK OPS
// ============================================================
async function deleteTask(taskId) {
  const root = state.tasks.find(t => t.id === taskId);
  if (!root) return;
  const gone = [root, ...subtree(taskId)], ids = new Set(gone.map(t => t.id));
  try { await dbDeleteTasks([...ids]); }
  catch (e) { showToast('Не удалось удалить: ' + e.message); return; }
  const kept = state.tasks.filter(t => !ids.has(t.id));
  state.tasks.length = 0; state.tasks.push(...kept);
  gone.forEach(t => syncNativeReminder({ ...t, reminder: '' }));
  const files = gone.flatMap(t => t.files);
  const undoId = pushUndo({
    onExpire: () => files.forEach(f => scheduleMediaDelete(f.id, 0)),
    restore: async () => {
      if (root.boardId && root.boardId !== state.activeBoardId) await switchBoard(root.boardId);
      files.forEach(f => cancelMediaDelete(f.id));
      try { await dbPutTasks(gone); }
      catch (e) { showToast('Не удалось восстановить: ' + e.message); return false; }
      (state._tasksByBoard[root.boardId] || state.tasks).push(...gone);
      gone.forEach(syncNativeReminder);
      notifyOtherTabs(); renderBoard();
      return true;
    }
  });
  notifyOtherTabs(); renderBoard();
  showToast(`Удалено: «${truncate(root.title, 40)}»${gone.length > 1 ? ` и ещё ${gone.length - 1}` : ''}`, 'Вернуть', async () => {
    const op = consumeUndo(undoId);
    if (op) await op.restore();
  }, 5000);
}

// ============================================================
// TASK MODAL
// ============================================================
function captureModalSnapshot() {
  return JSON.stringify({
    title: $('#taskTitle').value, desc: $('#taskDesc').value, tags: $('#taskTags').value,
    deadline: $('#taskDeadline').value, reminder: $('#taskReminder').value, reminderRepeat: $('#taskReminderRepeat').value, taskRepeat: $('#taskRepeat').value, priority: editingPriority, checklist: tempChecklist,
    parent: $('#taskParent').value, files: tempFiles.map(f => f.id + f.name), nf: newFiles.map(f => (f._name || f.name) + f.size)
  });
}
// Quick scheduling keeps local calendar dates (not UTC), including across DST.
function formatTaskLocalDate(date, withTime = false) {
  const pad = n => String(n).padStart(2, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${datePart}T${pad(date.getHours())}:${pad(date.getMinutes())}` : datePart;
}
function applyTaskDeadlinePreset(preset, now = new Date()) {
  if (!['today', 'tomorrow', 'week', 'clear'].includes(preset)) return false;
  const date = new Date(now.getTime());
  if (preset === 'tomorrow') date.setDate(date.getDate() + 1);
  if (preset === 'week') date.setDate(date.getDate() + 7);
  const input = $('#taskDeadline');
  input.value = preset === 'clear' ? '' : formatTaskLocalDate(date);
  $('#taskDeadlineError').hidden = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
function applyTaskReminderPreset(preset, now = new Date()) {
  if (!['hour', 'tomorrow9', 'week', 'clear'].includes(preset)) return false;
  let date = new Date(now.getTime());
  if (preset === 'hour') date = new Date(date.getTime() + 60 * 60 * 1000);
  if (preset === 'tomorrow9') {
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
  }
  if (preset === 'week') date.setDate(date.getDate() + 7);
  const input = $('#taskReminder');
  input.value = preset === 'clear' ? '' : formatTaskLocalDate(date, true);
  if (preset === 'clear') $('#taskReminderRepeat').value = 'none';
  $('#taskReminderError').hidden = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// WebView native selects may target the wrong menu on Android. The visible
// buttons are the source of truth; the hidden select preserves stored values.
function setTaskRepeat(value) {
  if (!['none', 'daily', 'weekly', 'monthly'].includes(value)) return false;
  $('#taskRepeat').value = value;
  $$('#taskRepeatChoices [data-task-repeat]').forEach(button => {
    const active = button.dataset.taskRepeat === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  return true;
}

function openTaskModal(taskId = null, columnId = null, opts = {}) {
  lastFocusBeforeModal = document.activeElement;
  editingTaskId = taskId;
  editingPriority = 'none';
  tempChecklist = [];
  tempFiles = []; newFiles = [];

  const modal = $('#taskModal');
  const titleEl = $('#taskTitle');
  const descEl = $('#taskDesc');
  const deadlineEl = $('#taskDeadline');
  const tagsEl = $('#taskTags');
  const colIdEl = $('#taskColumnId');
  const fileInput = $('#taskFile');
  const deleteBtn = $('#deleteTaskBtn');

  titleEl.value = ''; descEl.value = ''; deadlineEl.value = ''; $('#taskReminder').value = ''; $('#taskReminderRepeat').value = 'none'; setTaskRepeat('none'); tagsEl.value = '';
  fileInput.value = '';
  $('#taskTitleError').hidden = true; $('#taskDeadlineError').hidden = true; $('#taskReminderError').hidden = true;
  setPriorityChips('none'); renderChecklistUI();

  if (taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    $('#taskModalTitle').textContent = 'Редактирование задачи';
    titleEl.value = task.title; descEl.value = task.desc || '';
    deadlineEl.value = task.deadline || ''; $('#taskReminder').value = task.reminder || ''; $('#taskReminderRepeat').value = task.reminderRepeat || 'none'; setTaskRepeat(task.taskRepeat || 'none'); tagsEl.value = task.tags.join(', ');
    colIdEl.value = task.columnId; setPriorityChips(task.priority);
    tempChecklist = task.checklist.map(c => ({ ...c })); renderChecklistUI();
    tempFiles = task.files.map(f => ({ ...f }));
    fillParentSelect(task, task.columnId);
    renderNestedNodes(task.id);
    deleteBtn.style.display = 'inline-flex';
    $('#dupTaskBtn').style.display = 'inline-flex';
  } else {
    $('#taskModalTitle').textContent = 'Новая задача';
    colIdEl.value = columnId || state.columns[0].id;
    deadlineEl.value = opts.deadline || '';
    fillParentSelect(null, colIdEl.value);
    if (opts.parent) $('#taskParent').value = 'task:' + opts.parent;
    renderNestedNodes(null);
    deleteBtn.style.display = 'none';
    $('#dupTaskBtn').style.display = 'none';
  }

  renderFiles();
  modalInitialSnapshot = captureModalSnapshot();
  modal.classList.add('open');
  setTimeout(() => titleEl.focus(), 50);
  trapFocus(modal);
}
function setPriorityChips(priority) {
  editingPriority = priority;
  $$('#priorityChips .chip').forEach(chip => chip.classList.toggle('active', chip.dataset.priority === priority));
}
function renderChecklistUI() {
  const container = $('#checklistItems');
  container.innerHTML = '';
  if (tempChecklist.length === 0) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:var(--text-subtle);padding:4px 2px;font-style:italic;';
    hint.textContent = 'Пунктов нет';
    container.appendChild(hint);
    return;
  }
  tempChecklist.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'checklist-row' + (item.checked ? ' done' : '');
    row.innerHTML = `<input type="checkbox" ${item.checked ? 'checked' : ''}><input type="text" value="${escapeHtml(item.text)}" placeholder="Пункт" maxlength="200"><button type="button" class="checklist-remove" title="Удалить">×</button>`;
    const cb = row.querySelector('input[type=checkbox]');
    const txt = row.querySelector('input[type=text]');
    cb.onchange = () => { tempChecklist[i].checked = cb.checked; row.classList.toggle('done', cb.checked); };
    txt.oninput = () => { tempChecklist[i].text = txt.value; };
    txt.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); } };
    row.querySelector('.checklist-remove').onclick = () => { tempChecklist.splice(i, 1); renderChecklistUI(); };
    container.appendChild(row);
  });
}
function addChecklistItem() {
  tempChecklist.push({ id: 'cl_' + generateId(), text: '', checked: false });
  renderChecklistUI();
  const inputs = $$('#checklistItems input[type=text]');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

/* --- Список вложенных узлов в окне задачи --- */
function renderNestedNodes(taskId) {
  const field = $('#nestedNodesField');
  const list = $('#nestedNodesList');
  list.innerHTML = '';
  if (!taskId) { field.hidden = true; return; }
  const all = subtree(taskId);
  if (!all.length) { field.hidden = true; return; }
  field.hidden = false;
  const walk = (pid, depth) => {
    kids(pid).forEach(t => {
      const el = document.createElement('div');
      el.className = 'nested-node';
      el.style.paddingLeft = (8 + depth * 16) + 'px';
      el.innerHTML = `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">`
        + `${depth > 0 ? '↳ ' : '• '}${escapeHtml(t.title)}</span>`;
      el.onclick = async () => {
        if (isModalDirty()) {
          const ok = await confirmDialog('Открыть другую задачу?', 'Несохранённые изменения будут потеряны.');
          if (!ok) return;
        }
        closeModal('taskModal');
        openTaskModal(t.id);
      };
      list.appendChild(el);
      walk(t.id, depth + 1);
    });
  };
  walk(taskId, 0);
}

function fillParentSelect(task, colId) {
  const ban = new Set(task ? [task.id, ...subtree(task.id).map(t => t.id)] : []);
  let h = '';
  state.columns.forEach(c => {
    h += `<option value="col:${escapeHtml(c.id)}">${escapeHtml(c.title)}</option>`;
    const walk = (pid, d) => kids(pid, c.id).forEach(t => {
      if (ban.has(t.id)) return;
      h += `<option value="task:${escapeHtml(t.id)}">${'\u00a0\u00a0'.repeat(d)}↳ ${escapeHtml(truncate(t.title, 40))}</option>`;
      walk(t.id, d + 1);
    });
    walk('', 1);
  });
  const sel = $('#taskParent');
  sel.innerHTML = h;
  sel.value = task && task.parentId ? 'task:' + task.parentId : 'col:' + colId;
}
function renderFiles() {
  const box = $('#mediaPreview');
  box.innerHTML = '';
  const all = [...tempFiles.map(f => ({ f, old: true })), ...newFiles.map(f => ({ f, old: false }))].filter(it => !isAudio(it.f));
  all.forEach((it, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px';
    row.innerHTML = `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📎 ${escapeHtml(it.f.name)}${it.f.size ? ' · ' + fmtSize(it.f.size) : ''}${it.old ? '' : ' (новый)'}</span>${it.old ? '<button type="button" class="media-remove" data-open="1">Открыть</button><button type="button" class="media-remove" data-edit="1">Изменить</button>' : ''}<button type="button" class="media-remove" data-rm="1" aria-label="Убрать файл">×</button>`;
    row.querySelector('[data-rm]').onclick = () => { if (it.old) tempFiles = tempFiles.filter(x => x !== it.f); else newFiles = newFiles.filter(x => x !== it.f); renderFiles(); };
    const op = row.querySelector('[data-open]');
    if (op) {
      op.setAttribute('aria-label', 'Открыть файл ' + it.f.name);
      op.onclick = () => openFile(it.f, $('#taskTitle').value, tempFiles);
    }
    const edit = row.querySelector('[data-edit]');
    if (edit) edit.onclick = () => editAttachmentExternally(it.f);
    box.appendChild(row);
  });
  renderAudioList();
}
async function storeFile(file) {
  let blob = file, thumb = null, name = file._name || file.name || 'Файл';
  const ext = name.split('.').pop().toLowerCase();
  const imageTypes = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'};
  let type = file.type || imageTypes[ext] || 'application/octet-stream';
  if (/^image\/(jpeg|png|webp|heic|heif)$/.test(type) && file.size > 2 * 1024 * 1024) {
    // A failed conversion must not silently store the original 10-15 MB photo.
    blob = await compressImage(file, IMG_MAX_DIM, IMG_QUALITY);
    type = blob.type;
    name = name.replace(/\.[^.]+$/, '') + '.jpg';
  }
  if (type.startsWith('image/')) { try { thumb = await generateThumb(blob, IMG_THUMB_DIM, 0.78); } catch (_) {} }
  const id = 'm_' + generateId();
  await mediaPut(id, blob, thumb, type);
  const meta = type.startsWith('audio/') ? await prepAudio(file) : null;
  return { id, name, type, size: blob.size, ...(meta && meta.dur ? { dur: meta.dur } : {}), ...(meta && meta.peaks ? { peaks: meta.peaks } : {}) };
}
async function editAttachmentExternally(f) {
  if (!window.KanbanFileEdit?.postMessage) {
    showToast('Редактирование доступно только в Android-приложении'); return;
  }
  const record = await mediaGet(f.id).catch(() => null);
  if (!record?.full) { showToast('Файл не найден'); return; }
  if (record.full.size > 5 * 1024 * 1024) {
    showToast('Для внешнего редактирования поддерживаются файлы до 5 МБ'); return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = String(reader.result).split(',')[1];
    window.KanbanFileEdit.postMessage(JSON.stringify({
      id: f.id, name: f.name, type: f.type || 'application/octet-stream', base64
    }));
  };
  reader.onerror = () => showToast('Не удалось прочитать файл');
  reader.readAsDataURL(record.full);
}
window.kanbanExternalEditResult = async function(payload) {
  try {
    const data = JSON.parse(payload);
    const binary = atob(data.base64);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const previous = await mediaGet(data.id);
    if (!previous) throw new Error('Исходный файл не найден');
    const file = tempFiles.find(f => f.id === data.id) ||
      state.tasks.flatMap(t => t.files || []).find(f => f.id === data.id);
    if (!file) throw new Error('Вложение больше не существует');
    const blob = new Blob([bytes], { type: file.type || previous.type });
    await mediaPut(data.id, blob, previous.thumb || null, file.type || previous.type);
    const touched = state.tasks.filter(t => (t.files || []).some(f => f.id === data.id));
    for (const task of touched) {
      const updated = { ...task, files: task.files.map(f =>
        f.id === data.id ? { ...f, size: blob.size } : f) };
      await dbPutTask(updated);
      const idx = state.tasks.findIndex(t => t.id === task.id);
      if (idx !== -1) state.tasks[idx] = updated;
    }
    tempFiles.filter(f => f.id === data.id).forEach(f => { f.size = blob.size; });
    renderFiles();
    notifyOtherTabs();
    showToast('Изменения файла сохранены в Канбан');
  } catch (error) {
    showToast('Не удалось обновить вложение: ' + error.message);
  }
};
// Android WebView does not execute downloads from blob: anchor links. Send
// saved non-media attachments to Android in acknowledged 32 KiB chunks instead.
let activeAndroidFileOpen = null;
const ANDROID_FILE_OPEN_CHUNK_SIZE = 32 * 1024;

function postAndroidFileOpen(message) {
  window.KanbanFileOpen.postMessage(JSON.stringify(message));
}

function failAndroidFileOpen(transfer, message, abort = false) {
  if (activeAndroidFileOpen !== transfer) return;
  activeAndroidFileOpen = null;
  if (abort) {
    try { postAndroidFileOpen({ type: 'abort', id: transfer.id }); } catch (_) {}
  }
  showToast('Не удалось открыть файл: ' + message);
}

async function sendAndroidFileOpenChunk(transfer) {
  if (activeAndroidFileOpen !== transfer) return;
  try {
    if (transfer.offset >= transfer.blob.size) {
      postAndroidFileOpen({ type: 'finish', id: transfer.id });
      return;
    }
    const bytes = new Uint8Array(await transfer.blob.slice(
      transfer.offset, transfer.offset + ANDROID_FILE_OPEN_CHUNK_SIZE
    ).arrayBuffer());
    if (activeAndroidFileOpen !== transfer) return;
    transfer.pendingBytes = bytes.length;
    postAndroidFileOpen({
      type: 'chunk', id: transfer.id, index: transfer.index,
      data: btoa(String.fromCharCode(...bytes))
    });
  } catch (error) {
    failAndroidFileOpen(transfer, error.message || 'Ошибка чтения файла', true);
  }
}

window.kanbanFileOpenNativeResult = (raw) => {
  let event;
  try { event = JSON.parse(raw); } catch (_) { return; }
  const transfer = activeAndroidFileOpen;
  if (!transfer || transfer.id !== event.id) return;
  if (event.type === 'ready') {
    void sendAndroidFileOpenChunk(transfer);
  } else if (event.type === 'ack') {
    if (event.index !== transfer.index + 1 || transfer.pendingBytes <= 0) {
      failAndroidFileOpen(transfer, 'Неверное подтверждение передачи', true);
      return;
    }
    transfer.offset += transfer.pendingBytes;
    transfer.pendingBytes = 0;
    transfer.index++;
    void sendAndroidFileOpenChunk(transfer);
  } else if (event.type === 'opened' || event.type === 'cancelled') {
    activeAndroidFileOpen = null;
  } else if (event.type === 'error') {
    failAndroidFileOpen(transfer, event.message || 'Не удалось запустить приложение');
  }
};

async function openFile(f, title, files = [f]) {
  if (/^(image|video)\//.test(f.type)) return openLightbox({ title, files }, f);
  const m = await mediaGet(f.id).catch(() => null);
  if (!m?.full) { showToast('Файл не найден'); return; }

  if (window.KanbanFileOpen?.postMessage) {
    if (activeAndroidFileOpen) {
      showToast('Дождитесь открытия предыдущего файла');
      return;
    }
    if (!m.full.size || m.full.size > MAX_VIDEO_SIZE) {
      showToast('Открытие файлов поддерживается до 50 МБ');
      return;
    }
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    const transfer = { id, blob: m.full, offset: 0, index: 0, pendingBytes: 0 };
    activeAndroidFileOpen = transfer;
    try {
      postAndroidFileOpen({
        type: 'start', id, name: f.name || 'attachment.bin',
        mime: f.type || m.type || 'application/octet-stream', size: m.full.size
      });
    } catch (error) {
      failAndroidFileOpen(transfer, error.message || 'Ошибка передачи');
    }
    return;
  }

  if (location.origin === 'https://appassets.androidplatform.net') {
    showToast('Открытие недоступно: обновите Android System WebView');
    return;
  }
  const url = createTrackedURL(m.full), a = document.createElement('a');
  a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => revokeTrackedURL(url), 4000);
}

// ============================================================
// ATOMIC SAVE
// ============================================================
let savingTask = false;
async function saveTaskFromModal() {
  if (savingTask) return;
  savingTask = true;
  try { await _saveTask(); } finally { savingTask = false; }
}
async function _saveTask() {
  const title = $('#taskTitle').value.trim(), deadline = $('#taskDeadline').value || '';
  const existing = editingTaskId ? state.tasks.find(t => t.id === editingTaskId) : null;
  $('#taskTitleError').hidden = !!title;
  if (!title) {
    $('#taskTitle').focus();
    showToast('Введите название задачи перед сохранением');
    return;
  }
  const deadlineValid = isValidISODate(deadline);
  $('#taskDeadlineError').hidden = deadlineValid;
  if (!deadlineValid) {
    $('#taskDeadline').focus();
    showToast('Проверьте дату завершения задачи');
    return;
  }
  const reminder = $('#taskReminder').value;
  const reminderAt = reminder ? new Date(reminder).getTime() : 0;
  // Opening an old task must not make unrelated edits impossible merely because
  // its existing reminder has already passed. New/changed reminders must be future.
  const reminderValid = !reminder || (Number.isFinite(reminderAt) &&
    (reminderAt > Date.now() || (existing && reminder === existing.reminder)));
  $('#taskReminderError').hidden = !!reminderValid;
  if (!reminderValid) {
    $('#taskReminder').focus();
    showToast('Укажите дату и время напоминания в будущем');
    return;
  }
  const reminderRepeat = $('#taskReminderRepeat').value;
  const taskRepeat = $('#taskRepeat').value;
  const repeatAnchor = existing && existing.deadline === deadline && existing.taskRepeat === taskRepeat
    ? (existing.repeatAnchor || deadline || (reminder ? reminder.slice(0, 10) : ''))
    : (deadline || (reminder ? reminder.slice(0, 10) : ''));

  const pv = $('#taskParent').value, parentId = pv.startsWith('task:') ? pv.slice(5) : '';
  const par = parentId ? state.tasks.find(t => t.id === parentId) : null;
  if (parentId && !par) { showToast('Родитель не найден'); return; }
  const columnId = par ? par.columnId : pv.slice(4);
  if (rec.mr) await recStop();
  const stored = [];
  try { for (const f of newFiles) stored.push(await storeFile(f)); }
  catch (e) { stored.forEach(x => mediaDelete(x.id).catch(() => {})); showToast('Не удалось сохранить файл: ' + (e.message || e)); return; }
  const files = [...tempFiles, ...stored];

  const moved = !existing || existing.parentId !== parentId || existing.columnId !== columnId;
  const sib = state.tasks.filter(t => t !== existing && t.parentId === parentId && (parentId || t.columnId === columnId));
  const candidate = {
    id: existing ? existing.id : generateId(), boardId: existing ? existing.boardId : state.activeBoardId,
    columnId, parentId, title, desc: $('#taskDesc').value.trim(),
    tags: $('#taskTags').value.split(',').map(t => t.trim()).filter(Boolean),
    priority: editingPriority, deadline, reminder, reminderRepeat, taskRepeat,
    repeatFrom: existing?.repeatFrom || '', repeatAnchor, files,
    checklist: tempChecklist.map(c => ({ id: c.id, text: c.text.trim(), checked: !!c.checked })).filter(c => c.text),
    order: !moved ? existing.order : (sib.length ? Math.min(...sib.map(t => t.order ?? 0)) - 1 : 0),
    createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now(),
    completedAt: computeCompletedAt(existing ? existing.columnId : null, columnId, existing ? existing.completedAt : null)
  };
  try { await persistTaskChanges([candidate]); }
  catch (e) { stored.forEach(x => mediaDelete(x.id).catch(() => {})); showToast('Не удалось сохранить: ' + e.message, null, null, 5000); return; }

  if (existing) existing.files.filter(f => !files.some(x => x.id === f.id)).forEach(f => scheduleMediaDelete(f.id));
  await syncKids(candidate).catch(() => {});
  closeModal('taskModal'); notifyOtherTabs(); renderBoard();
}

function isModalDirty() { return modalInitialSnapshot !== null && (!!rec.mr || modalInitialSnapshot !== captureModalSnapshot()); }
async function tryCloseTaskModal() {
  if (isModalDirty()) {
    const ok = await confirmDialog('Закрыть без сохранения?', 'Введённые изменения будут потеряны.');
    if (!ok) return;
  }
  closeModal('taskModal');
}
function closeModal(id) {
  $('#' + id).classList.remove('open');
  releaseFocusTrap($('#' + id));
  if (lastFocusBeforeModal && typeof lastFocusBeforeModal.focus === 'function') {
    try { lastFocusBeforeModal.focus(); } catch (_) {}
    lastFocusBeforeModal = null;
  }
  if (id === 'taskModal') {
    recAbort(); apStop('modal');
    $('#mediaPreview').querySelectorAll('[data-preview-url]').forEach(el => revokeTrackedURL(el.dataset.previewUrl));
    modalInitialSnapshot = null;
    // A notification may have queued Mark Done while this editor was open.
    // It is safe to apply pending changes only after the draft is closed.
    window.kanbanRequestPendingActions?.();
  }
}
async function duplicateTask(taskId) {
  const src = state.tasks.find(t => t.id === taskId);
  if (!src) return;
  const sameCol = state.tasks.filter(t => t.columnId === src.columnId);
  const maxOrder = sameCol.reduce((m, t) => Math.max(m, t.order ?? 0), 0);
  const files = [];
  try { for (const f of src.files) { const m = await mediaGet(f.id); if (!m) continue; const id = 'm_' + generateId(); await mediaPut(id, m.full, m.thumb, m.type); files.push({ ...f, id }); } }
  catch (e) { files.forEach(x => mediaDelete(x.id).catch(() => {})); showToast('Не удалось скопировать файлы: ' + e.message); return; }
  const copy = {
    ...src, id: generateId(), title: src.title + ' (копия)',
    tags: [...src.tags], checklist: src.checklist.map(c => ({ id: 'cl_' + generateId(), text: c.text, checked: c.checked })),
    files, completedAt: null, repeatFrom: '', repeatAnchor: src.deadline || '',
    order: maxOrder + 1, createdAt: Date.now(), updatedAt: Date.now(),
    boardId: src.boardId || state.activeBoardId
  };
  try { await dbPutTask(copy); }
  catch (e) { showToast('Не удалось дублировать: ' + e.message); return; }
  state.tasks.push(copy);
  syncNativeReminder(copy);
  closeModal('taskModal'); notifyOtherTabs(); renderBoard();
  showToast('Задача продублирована');
}

// ============================================================
// FOCUS TRAP
// ============================================================
const focusTraps = new WeakMap();
function trapFocus(modalEl) {
  releaseFocusTrap(modalEl);
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const focusable = modalEl.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  modalEl.addEventListener('keydown', handler);
  focusTraps.set(modalEl, handler);
}
function releaseFocusTrap(modalEl) {
  const h = focusTraps.get(modalEl);
  if (h) { modalEl.removeEventListener('keydown', h); focusTraps.delete(modalEl); }
}

// ============================================================
// IMAGE PROCESSING
// ============================================================
// Full-size photos are stored as JPEGs capped at 2 MiB. Never silently keep
// a 10-15 MB source photo if decoding or conversion fails.
async function compressImage(file, maxDim, quality) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
      img.src = url;
    });
    if (!img.width || !img.height) throw new Error('Изображение повреждено');
    const scale = Math.min(1, maxDim / img.width, maxDim / img.height);
    for (const shrink of [1, 0.8, 0.65]) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale * shrink));
      canvas.height = Math.max(1, Math.round(img.height * scale * shrink));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Не удалось обработать изображение');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const q of [quality, 0.68, 0.52]) {
        const blob = await new Promise((resolve, reject) =>
          canvas.toBlob(result => result ? resolve(result) : reject(new Error('Не удалось сжать изображение')), 'image/jpeg', q)
        );
        if (blob.type !== 'image/jpeg') throw new Error('Преобразование в JPEG не поддерживается');
        if (blob.size <= 2 * 1024 * 1024) return blob;
      }
    }
    throw new Error('Не удалось уменьшить фото до 2 МБ');
  } finally {
    URL.revokeObjectURL(url);
  }
}
function generateThumb(blob, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const ratio = Math.min(maxDim / width, maxDim / height, 1);
      width = Math.round(width * ratio); height = Math.round(height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('thumb failed')); };
    img.src = url;
  });
}

// ============================================================
// LIGHTBOX
// ============================================================
let lightboxGallery = [];
let lightboxIndex = 0;
let lightboxTitle = '';
let lastLightboxFocus = null;

const LIGHTBOX_MAX_ZOOM = 5;
let lightboxZoom = 1;
let lightboxPanX = 0;
let lightboxPanY = 0;

function lightboxImage() { return $('#lightboxContent').querySelector('img'); }
function panLightboxTo(x, y) {
  const img = lightboxImage();
  if (!img) return;
  const viewport = $('#lightboxContent');
  const limitX = Math.max(0, (img.clientWidth * lightboxZoom - viewport.clientWidth) / 2);
  const limitY = Math.max(0, (img.clientHeight * lightboxZoom - viewport.clientHeight) / 2);
  lightboxPanX = Math.max(-limitX, Math.min(limitX, x));
  lightboxPanY = Math.max(-limitY, Math.min(limitY, y));
  img.style.transform = `translate(${lightboxPanX}px, ${lightboxPanY}px) scale(${lightboxZoom})`;
  img.style.cursor = lightboxZoom > 1 ? 'grab' : 'zoom-in';
}
function setLightboxZoom(scale, clientX, clientY) {
  if (!lightboxImage()) return;
  const next = Math.max(1, Math.min(LIGHTBOX_MAX_ZOOM, scale));
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
    const rect = $('#lightboxContent').getBoundingClientRect();
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;
    const ratio = next / lightboxZoom;
    lightboxPanX = x - (x - lightboxPanX) * ratio;
    lightboxPanY = y - (y - lightboxPanY) * ratio;
  }
  lightboxZoom = next;
  if (next === 1) lightboxPanX = lightboxPanY = 0;
  panLightboxTo(lightboxPanX, lightboxPanY);
  $('#lightboxZoomReset').textContent = Math.round(next * 100) + '%';
  $('#lightboxZoomOut').disabled = next <= 1;
  $('#lightboxZoomIn').disabled = next >= LIGHTBOX_MAX_ZOOM;
}
function resetLightboxZoom() {
  lightboxZoom = 1;
  lightboxPanX = lightboxPanY = 0;
  const img = lightboxImage();
  if (img) { img.style.transform = ''; img.style.cursor = 'zoom-in'; }
  $('#lightboxZoomReset').textContent = '100%';
  $('#lightboxZoomOut').disabled = true;
  $('#lightboxZoomIn').disabled = false;
}

async function openLightbox(task, file) {
  const items = (task.files || []).filter(f => /^(image|video)\//.test(f.type));
  if (!items.length) return;
  const lightbox = $('#lightbox');
  if (!lightbox.classList.contains('open')) lastLightboxFocus = document.activeElement;
  lightboxGallery = items;
  lightboxTitle = task.title || 'Вложение';
  const selected = file ? items.findIndex(item => item.id === file.id) : 0;
  lightboxIndex = selected < 0 ? 0 : selected;
  lightbox.classList.add('open');
  $('#lightboxClose').focus();
  await showLightboxItem();
}
async function showLightboxItem() {
  const token = ++lightboxToken;
  const lightbox = $('#lightbox'), content = $('#lightboxContent');
  resetLightboxZoom();
  $('#lightboxZoomControls').hidden = true;
  if (lightbox.dataset.url) { revokeTrackedURL(lightbox.dataset.url); delete lightbox.dataset.url; }
  content.innerHTML = '<div style="color:#fff;font-size:13px">Загрузка…</div>';
  const multiple = lightboxGallery.length > 1;
  $('#lightboxPrev').hidden = !multiple;
  $('#lightboxNext').hidden = !multiple;
  $('#lightboxCounter').textContent = multiple ? (lightboxIndex + 1) + ' / ' + lightboxGallery.length : '';
  const file = lightboxGallery[lightboxIndex];
  if (!file) return;
  try {
    const media = await mediaGet(file.id);
    if (token !== lightboxToken) return;
    if (!media) { content.textContent = 'Файл не найден'; return; }
    const url = createTrackedURL(media.full);
    content.innerHTML = '';
    if (media.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = url; img.alt = lightboxTitle;
      content.appendChild(img);
      $('#lightboxZoomControls').hidden = false;
    } else if (media.type.startsWith('video/')) {
      const vid = document.createElement('video');
      vid.src = url; vid.controls = true;
      content.appendChild(vid);
    } else { revokeTrackedURL(url); content.textContent = 'Формат не поддерживается'; return; }
    lightbox.dataset.url = url;
  } catch (_) {
    if (token === lightboxToken) content.textContent = 'Не удалось открыть файл';
  }
}
function stepLightbox(delta) {
  if (!$('#lightbox').classList.contains('open') || lightboxGallery.length < 2) return;
  lightboxIndex = (lightboxIndex + delta + lightboxGallery.length) % lightboxGallery.length;
  void showLightboxItem();
}
function closeLightbox() {
  lightboxToken++;
  resetLightboxZoom();
  $('#lightboxZoomControls').hidden = true;
  const lightbox = $('#lightbox');
  const url = lightbox.dataset.url;
  if (url) { revokeTrackedURL(url); delete lightbox.dataset.url; }
  $('#lightboxContent').innerHTML = '';
  lightbox.classList.remove('open');
  lightboxGallery = [];
  $('#lightboxCounter').textContent = '';
  if (lastLightboxFocus?.isConnected) lastLightboxFocus.focus();
  lastLightboxFocus = null;
}

// ============================================================
// SETTINGS
// ============================================================
function openSettingsModal() {
  lastFocusBeforeModal = document.activeElement;
  editingBoardName = state.boardName;
  editingColumns = state.columns.map(c => ({ ...c }));
  $('#boardNameInput').value = editingBoardName;
  renderColumnsConfig();
  const delBtn = $('#deleteBoardBtn');
  if (delBtn) delBtn.disabled = state.boards.length <= 1;
  $('#settingsModal').classList.add('open');
  setTimeout(() => $('#boardNameInput').focus(), 50);
  trapFocus($('#settingsModal'));
}
function renderColumnsConfig() {
  const container = $('#columnsList');
  container.innerHTML = '';
  editingColumns.forEach((col, i) => {
    const row = document.createElement('div');
    row.className = 'column-row';
    row.innerHTML = `
      <span class="color-dot" style="background:${escapeHtml(col.color)}"></span>
      <input type="text" value="${escapeHtml(col.title)}" maxlength="60" aria-label="Название колонки">
      <input type="color" value="${escapeHtml(col.color)}" title="Цвет" aria-label="Цвет">
      <input type="number" value="${col.wipLimit || ''}" min="1" max="999" placeholder="WIP" title="WIP-лимит" aria-label="WIP">
      <label class="col-done-label" title="Считать выполнением"><input type="checkbox" ${col.isDone ? 'checked' : ''}> Done</label>
      <button type="button" class="col-btn" title="Удалить" aria-label="Удалить колонку">×</button>
    `;
    const [txt] = row.querySelectorAll('input[type=text]');
    const [color] = row.querySelectorAll('input[type=color]');
    const [wip] = row.querySelectorAll('input[type=number]');
    const [doneCb] = row.querySelectorAll('input[type=checkbox]');
    const dot = row.querySelector('.color-dot');
    const rm = row.querySelector('.col-btn');
    txt.oninput = () => { editingColumns[i].title = txt.value; };
    color.oninput = () => { if (COLOR_RE.test(color.value)) { editingColumns[i].color = color.value; dot.style.background = color.value; } };
    wip.oninput = () => { editingColumns[i].wipLimit = Math.max(0, parseInt(wip.value, 10) || 0); };
    doneCb.onchange = () => { editingColumns[i].isDone = doneCb.checked; };
    rm.onclick = () => { if (editingColumns.length <= 1) return; editingColumns.splice(i, 1); renderColumnsConfig(); };
    container.appendChild(row);
  });
}
function addColumnConfig() {
  editingColumns.push({ id: 'col_' + generateId(), title: 'Новая колонка', color: '#a3a3a3', isDone: false, wipLimit: 0 });
  renderColumnsConfig();
}
async function dbSaveBoardAndTasks(boards, activeBoardId, changedTasks) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_TASKS, STORE_SETTINGS], 'readwrite');
    const ts = tx.objectStore(STORE_TASKS), ss = tx.objectStore(STORE_SETTINGS);
    changedTasks.forEach(t => ts.put(t));
    ss.put({ key: 'boards', value: boards });
    ss.put({ key: 'activeBoardId', value: activeBoardId });
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(wrapTxError(tx.error));
  });
}
async function saveSettingsFromModal() {
  const newName = $('#boardNameInput').value.trim() || 'Моя доска';
  const newColumns = editingColumns.map(c => sanitizeColumn(c));

  const board = getActiveBoard();
  if (!board) return;

  const oldColumnIds = new Set(state.columns.map(c => c.id));
  const newColumnIds = new Set(newColumns.map(c => c.id));
  const removedIds = [...oldColumnIds].filter(id => !newColumnIds.has(id));
  const fallbackId = newColumns[0].id;
  const tasksToMove = [];
  for (const t of state.tasks) {
    if (removedIds.includes(t.columnId)) tasksToMove.push(applyColumnChange(t, fallbackId));
  }

  const prevName = board.name, prevCols = board.columns;
  board.name = newName;
  board.columns = newColumns;

  try {
    await dbSaveBoardAndTasks(state.boards, state.activeBoardId, tasksToMove);
  } catch (e) {
    board.name = prevName; board.columns = prevCols;
    showToast('Не удалось сохранить настройки: ' + e.message, null, null, 5000);
    return;
  }

  if (tasksToMove.length) {
    const movedMap = new Map(tasksToMove.map(t => [t.id, t]));
    for (let i = 0; i < state.tasks.length; i++) {
      if (movedMap.has(state.tasks[i].id)) state.tasks[i] = movedMap.get(state.tasks[i].id);
    }
  }

  state.boardName = board.name;
  state.columns = board.columns;

  // Native Android reminders cache their board name. Refresh them only once
  // the board transaction has committed, including tasks completed by a move.
  if (prevName !== board.name || tasksToMove.length) {
    state.tasks.filter(t => t.reminder).forEach(syncNativeReminder);
  }

  closeModal('settingsModal');
  updateBoardSelect();
  notifyOtherTabs();
  renderBoard();
}

// ============================================================
// CONFIRM MODAL
// ============================================================
function confirmDialog(title, text) {
  return new Promise(resolve => {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    const modal = $('#confirmModal');
    modal.classList.add('open');
    const okBtn = $('#confirmOk');
    const cancelBtn = $('#confirmCancel');
    const cleanup = (result) => {
      okBtn.onclick = null; cancelBtn.onclick = null;
      modal.classList.remove('open');
      resolve(result);
    };
    okBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    okBtn.focus();
  });
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, actionLabel, actionFn, duration = 3500) {
  const container = $('#toasts');
  const toast = document.createElement('div');
  toast.className = 'toast';
  const msg = document.createElement('span');
  msg.className = 'toast-message';
  msg.textContent = message;
  toast.appendChild(msg);
  if (actionLabel && actionFn) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = actionLabel;
    btn.onclick = () => { actionFn(); toast.classList.remove('show'); setTimeout(() => toast.remove(), 250); };
    toast.appendChild(btn);
  }
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 250); }, duration);
}

// ============================================================
// THEME
// ============================================================
function applyTheme(t) {
  theme = t;
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('kanban_theme', t); } catch (_) {}
  const btn = $('#themeBtn');
  if (btn) {
    btn.textContent = t === 'dark' ? '☀' : '◐';
    btn.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0a0a0a' : '#fafafa');
}
function toggleTheme() { applyTheme(theme === 'dark' ? 'light' : 'dark'); }
// Keep the Kanban appearance consistent with other open app pages without
// writing back to storage (which could trigger a cross-tab update loop).
window.addEventListener('storage', event => {
  if (event.key !== 'kanban_theme' || !['light', 'dark'].includes(event.newValue)) return;
  theme = event.newValue;
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeBtn');
  if (btn) { btn.textContent = theme === 'dark' ? '☀' : '◐'; btn.setAttribute('aria-pressed', String(theme === 'dark')); }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#fafafa');
});
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('kanban_theme'); } catch (_) {}
  if (saved === 'dark' || saved === 'light') applyTheme(saved);
  else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark');
  else applyTheme('light');
}

// Japanese lessons use localStorage; include their progress in full backups.
const JAPANESE_BACKUP_KEYS = [
  'kanban-japanese-hiragana-v1',
  'kanban-japanese-quiz-progress-v1',
  'kanban-japanese-script-v1',
  'kanban-japanese-review-v1',
  'kanban-japanese-active-tab-v1'
];
function readJapaneseBackup() {
  const values = {};
  for (const key of JAPANESE_BACKUP_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) values[key] = value;
  }
  return values;
}
function selectJapaneseBackup(data) {
  const values = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return values;
  for (const key of JAPANESE_BACKUP_KEYS) {
    if (typeof data[key] === 'string' && data[key].length <= 100000) values[key] = data[key];
  }
  return values;
}
function restoreJapaneseBackup(values) {
  const entries = Object.entries(selectJapaneseBackup(values));
  const previous = entries.map(([key]) => [key, localStorage.getItem(key)]);
  try {
    for (const [key, value] of entries) localStorage.setItem(key, value);
  } catch (error) {
    // Do not leave partially restored progress if storage is full.
    for (const [key, value] of previous) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch (_) {}
    }
    throw error;
  }
  return entries.length;
}

// Android saves through SAF, not WebView blob downloads. Transfer at most 32 KiB
// per message, waiting for native acknowledgment so media-heavy backups can be saved.
let activeAndroidBackup = null;
const ANDROID_BACKUP_CHUNK_SIZE = 32 * 1024;

function postAndroidBackup(message) {
  window.KanbanBackup.postMessage(JSON.stringify(message));
}

function failAndroidBackup(transfer, error, abortNative = false) {
  if (activeAndroidBackup !== transfer) return;
  activeAndroidBackup = null;
  if (abortNative) {
    try { postAndroidBackup({ type: 'abort', id: transfer.id }); } catch (_) {}
  }
  transfer.reject(error instanceof Error ? error : new Error(String(error)));
}

async function sendAndroidBackupChunk(transfer) {
  if (activeAndroidBackup !== transfer) return;
  try {
    if (transfer.offset >= transfer.blob.size) {
      postAndroidBackup({ type: 'finish', id: transfer.id });
      return;
    }
    const bytes = new Uint8Array(
      await transfer.blob.slice(transfer.offset, transfer.offset + ANDROID_BACKUP_CHUNK_SIZE).arrayBuffer()
    );
    if (activeAndroidBackup !== transfer) return;
    transfer.pendingBytes = bytes.length;
    postAndroidBackup({
      type: 'chunk', id: transfer.id, index: transfer.index,
      data: btoa(String.fromCharCode(...bytes))
    });
  } catch (e) {
    failAndroidBackup(transfer, e, true);
  }
}

window.kanbanBackupNativeResult = (raw) => {
  let event;
  try { event = JSON.parse(raw); } catch (_) { return; }
  const transfer = activeAndroidBackup;
  if (!transfer || event.id !== transfer.id) return;
  if (event.type === 'ready') {
    void sendAndroidBackupChunk(transfer);
  } else if (event.type === 'ack') {
    if (event.index !== transfer.index + 1 || transfer.pendingBytes <= 0) {
      failAndroidBackup(transfer, new Error('Ошибка подтверждения сохранения'), true);
      return;
    }
    transfer.offset += transfer.pendingBytes;
    transfer.pendingBytes = 0;
    transfer.index++;
    void sendAndroidBackupChunk(transfer);
  } else if (event.type === 'saved') {
    activeAndroidBackup = null;
    transfer.resolve(true);
  } else if (event.type === 'cancelled') {
    activeAndroidBackup = null;
    transfer.resolve(false);
  } else if (event.type === 'error') {
    failAndroidBackup(transfer, new Error(event.message || 'Не удалось сохранить бэкап'));
  }
};

function saveBackupViaAndroid(blob, name) {
  if (activeAndroidBackup) return Promise.reject(new Error('Дождитесь завершения текущего бэкапа'));
  return new Promise((resolve, reject) => {
    const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    const transfer = { id, blob, offset: 0, index: 0, pendingBytes: 0, resolve, reject };
    activeAndroidBackup = transfer;
    try {
      postAndroidBackup({ type: 'start', id, name, size: blob.size });
    } catch (e) {
      failAndroidBackup(transfer, e);
    }
  });
}

// ============================================================
// EXPORT JSON (v3 — multi-board)
// ============================================================
async function exportData() {
  try {
    const allTasks = Object.values(state._tasksByBoard).flat();
    const parts = ['{"version":4,"app":"kanban-mindmap","exportedAt":' + JSON.stringify(new Date().toISOString())
      + ',"activeBoardId":' + JSON.stringify(state.activeBoardId) + ',"boards":' + JSON.stringify(state.boards)
      + ',"tasks":' + JSON.stringify(allTasks) + ',"media":{'];
    const seen = new Set();
    let n = 0, missing = 0;
    for (const f of allTasks.flatMap(t => t.files)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const m = await mediaGet(f.id).catch(() => null);
      if (!m) { missing++; continue; }
      parts.push((n++ ? ',' : '') + JSON.stringify(f.id) + ':{"type":' + JSON.stringify(m.type || f.type)
        + ',"thumb":' + JSON.stringify(m.thumb || null) + ',"data":"' + await blobToBase64(m.full) + '"}');
    }
    parts.push('},"japanese":' + JSON.stringify(readJapaneseBackup()) + '}');
    const backup = new Blob(parts, { type: 'application/json' });
    const filename = `kanban-backup-${todayISO()}.json`;
    if (window.KanbanBackup?.postMessage) {
      const saved = await saveBackupViaAndroid(backup, filename);
      if (!saved) { showToast('Сохранение бэкапа отменено'); return; }
      showToast(`Бэкап сохранён: ${state.boards.length} досок, ${allTasks.length} узлов, ${n} файлов` + (missing ? `. Файлов не найдено: ${missing}` : ''));
    } else {
      if (location.origin === 'https://appassets.androidplatform.net') {
        throw new Error('Сохранение недоступно в этой версии Android WebView');
      }
      const url = URL.createObjectURL(backup);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast('Бэкап передан браузеру для загрузки');
    }
  } catch (e) {
    console.error(e);
    showToast('Ошибка экспорта: ' + (e.message || ''));
  }
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ============================================================
// EXPORT CSV (текущая доска, без родителя и файлов)
// ============================================================
function csvEscape(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCsv() {
  const header = ['id','board','title','description','column','priority','deadline','tags','checklist_done','checklist_total','created','updated','completed'];
  const rows = [header];
  for (const t of state.tasks) {
    const col = state.columns.find(c => c.id === t.columnId);
    const done = t.checklist.filter(c => c.checked).length;
    rows.push([
      t.id, state.boardName, t.title, t.desc, col ? col.title : '',
      PRIORITY_LABELS[t.priority] || '', t.deadline, t.tags.join('; '),
      done, t.checklist.length,
      new Date(t.createdAt).toISOString(), new Date(t.updatedAt).toISOString(),
      t.completedAt ? new Date(t.completedAt).toISOString() : ''
    ]);
  }
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `kanban-${sanitizeFilename(state.boardName)}-${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast(`CSV: ${state.tasks.length} задач`);
}
function sanitizeFilename(s) {
  return String(s).replace(/[^\wа-яё\-]+/gi, '_').slice(0, 40) || 'board';
}

// ============================================================
// IMPORT (v3 + v2 + legacy)
// ============================================================
function base64ToBlob(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('Некорректные данные файла');
  const idx = dataUrl.indexOf(',');
  if (idx === -1) throw new Error('Некорректный data URL');
  const header = dataUrl.substring(0, idx);
  const base64 = dataUrl.substring(idx + 1);
  const mimeMatch = header.match(/:(.*?);/);
  if (!mimeMatch) throw new Error('Некорректный MIME в data URL');
  const mime = mimeMatch[1];
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function buildImportPlan(data) {
  const warnings = [];
  let rawBoards, rawTasks, mediaSrc, activeBoardId;

  if (Array.isArray(data)) {
    rawBoards = [{ id: 'board_import', name: 'Импорт', columns: DEFAULT_COLUMNS() }];
    rawTasks = data;
    mediaSrc = {};
    activeBoardId = rawBoards[0].id;
    rawTasks.forEach(t => { if (t) t.boardId = rawBoards[0].id; });
  } else if (data && Array.isArray(data.boards)) {
    rawBoards = data.boards;
    rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
    mediaSrc = (data.media && typeof data.media === 'object') ? data.media : {};
    activeBoardId = data.activeBoardId;
  } else if (data && Array.isArray(data.tasks)) {
    rawBoards = [{
      id: 'board_import',
      name: data.boardName || 'Импорт',
      columns: Array.isArray(data.columns) && data.columns.length ? data.columns : DEFAULT_COLUMNS()
    }];
    rawTasks = data.tasks;
    mediaSrc = (data.media && typeof data.media === 'object') ? data.media : {};
    activeBoardId = rawBoards[0].id;
    rawTasks.forEach(t => { if (t && !t.boardId) t.boardId = rawBoards[0].id; });
  } else {
    throw new Error('Неверный формат файла');
  }

  const boards = [];
  const seenBid = new Set();
  for (const raw of rawBoards) {
    if (!raw || typeof raw !== 'object') continue;
    const b = sanitizeBoard(raw);
    if (seenBid.has(b.id)) { b.id = 'board_' + generateId(); warnings.push(`Доска «${b.name}»: ID-дубликат заменён.`); }
    seenBid.add(b.id);
    boards.push(b);
  }
  if (!boards.length) boards.push(sanitizeBoard({ id: 'board_import', name: 'Импорт' }));
  const validBoardIds = new Set(boards.map(b => b.id));
  if (!activeBoardId || !validBoardIds.has(activeBoardId)) activeBoardId = boards[0].id;
  const fallbackBoard = boards[0].id;

  const colsByBoard = {};
  boards.forEach(b => { colsByBoard[b.id] = new Set(b.columns.map(c => c.id)); });
  const oldColMap = { todo: 0, inprogress: 1, done: 2 };

  const tasks = [];
  const seenTid = new Set();
  const media = {};
  let skippedTasks = 0, brokenMedia = 0;

  for (let i = 0; i < rawTasks.length; i++) {
    const raw = rawTasks[i];
    if (!raw || typeof raw !== 'object') { skippedTasks++; continue; }
    const task = sanitizeTask(raw);
    if (!task) { skippedTasks++; continue; }

    if (seenTid.has(task.id)) {
      warnings.push(`Задача «${task.title}»: ID-дубликат заменён.`);
      task.id = generateId();
    }
    seenTid.add(task.id);

    if (!task.boardId || !validBoardIds.has(task.boardId)) {
      task.boardId = fallbackBoard;
    }

    const bCols = boards.find(b => b.id === task.boardId).columns;
    const validCols = colsByBoard[task.boardId];
    if (!validCols.has(task.columnId)) {
      const idx = oldColMap[task.columnId];
      if (typeof idx === 'number' && bCols[idx]) task.columnId = bCols[idx].id;
      else task.columnId = bCols[0].id;
    }

    if (task.deadline && !isValidISODate(task.deadline)) {
      warnings.push(`Задача «${task.title}»: некорректная дата, сброшена.`);
      task.deadline = '';
    }

    if (!task.files.length && raw.exportedMediaKey && mediaSrc[raw.exportedMediaKey]) {
      task.files = [{ id: raw.exportedMediaKey, name: 'Вложение', type: mediaSrc[raw.exportedMediaKey].type || '', size: 0 }];
    } else if (!task.files.length && raw.mediaBase64) {
      mediaSrc['legacy_' + i] = { data: raw.mediaBase64, type: raw.mediaType };
      task.files = [{ id: 'legacy_' + i, name: 'Вложение', type: String(raw.mediaType || ''), size: 0 }];
    }
    const kept = [];
    for (const f of task.files) {
      const src = mediaSrc[f.id];
      if (!src || !src.data) { warnings.push(`«${task.title}»: нет данных файла ${f.name}`); brokenMedia++; continue; }
      try {
        const blob = base64ToBlob(src.data);
        if (blob.size > MAX_VIDEO_SIZE) { warnings.push(`«${task.title}»: ${f.name} >50 МБ`); brokenMedia++; continue; }
        const mime = f.type || src.type || blob.type;
        const id = media[f.id] ? 'm_' + generateId() : f.id;
        let thumb = (typeof src.thumb === 'string' && src.thumb.startsWith('data:image/')) ? src.thumb : null;
        if (!thumb && mime.startsWith('image/')) { try { thumb = await generateThumb(blob, IMG_THUMB_DIM, 0.78); } catch (_) {} }
        media[id] = { full: blob, thumb, type: mime };
        kept.push({ ...f, id, type: mime, size: blob.size });
      } catch (e) { warnings.push(`«${task.title}»: битый файл ${f.name}`); brokenMedia++; }
    }
    task.files = kept;

    task.order = typeof raw.order === 'number' ? raw.order : i;
    tasks.push(task);
  }

  // Duplicate source IDs are ambiguous: keep the first, and prevent accidental
  // attachment of children to a different task after an ID was regenerated.
  const idsBySource = new Map();
  rawTasks.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || !raw.id) return;
    const key = String(raw.id);
    idsBySource.set(key, (idsBySource.get(key) || 0) + 1);
  });
  const importedIds = new Set(tasks.map(t => t.id));
  for (const task of tasks) {
    if (!task.parentId) continue;
    if (idsBySource.get(String(task.parentId)) > 1) {
      warnings.push(`«${task.title}»: неоднозначный родитель (дублирующийся ID), связь удалена.`);
      task.parentId = '';
    } else if (!importedIds.has(task.parentId)) {
      warnings.push(`«${task.title}»: родитель отсутствует, связь удалена.`);
      task.parentId = '';
    }
  }
  boards.forEach(b => normalizeTree(tasks.filter(t => t.boardId === b.id)));
  return { boards, activeBoardId, tasks, media,
    japanese: selectJapaneseBackup(data?.japanese),
    report: { skippedTasks, brokenMedia, warnings } };
}

async function handleImport(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { alert('Неверный JSON: ' + e.message); return; }

  let plan;
  try { plan = await buildImportPlan(data); }
  catch (e) { alert('Ошибка импорта: ' + e.message); return; }

  const totalWarn = plan.report.warnings.length;
  const hasJapanese = Object.keys(plan.japanese).length > 0;
  const message = `Текущие ${state.boards.length} досок и ${Object.values(state._tasksByBoard).reduce((s,a)=>s+a.length,0)} задач будут заменены на ${plan.boards.length} досок и ${plan.tasks.length} задач из файла.`
    + (hasJapanese ? '\n\nПрогресс японского из бэкапа заменит соответствующий текущий прогресс.' : '')
    + (totalWarn ? `\n\nПредупреждений: ${totalWarn}. См. консоль.` : '');
  if (totalWarn) console.warn('[import] warnings:', plan.report.warnings);

  const ok = await confirmDialog('Импорт данных', message);
  if (!ok) return;

  const previousTasks = Object.values(state._tasksByBoard).flat();
  try { await dbReplaceAll(plan); }
  catch (e) { console.error(e); alert('Не удалось записать данные: ' + e.message + '\nСтарые данные сохранены.'); return; }

  // The native alarm store is separate from IndexedDB. Update it only after
  // the replacement commits, and cancel old IDs before scheduling imported ones.
  previousTasks.forEach(t => syncNativeReminder({ ...t, reminder: '' }));
  plan.tasks.forEach(syncNativeReminder);
  undoStack.length = 0; for (const t of pendingMediaDeletes.values()) clearTimeout(t); pendingMediaDeletes.clear(); apStop();
  rebucket(plan.tasks, plan.boards, plan.activeBoardId);
  applyActiveBoard();
  thumbCache.clear();
  renderBoard();
  saveUIState();
  if (hasJapanese) {
    try { restoreJapaneseBackup(plan.japanese); }
    catch (e) {
      alert('Доски и задачи восстановлены, но прогресс японского не удалось записать. Сохраните резервный файл и проверьте свободное место.\n' + (e.message || e));
    }
  }

  const suffix = totalWarn ? ` (${totalWarn} предупр.)` : '';
  showToast(`Импортировано: ${plan.tasks.length} задач в ${plan.boards.length} досках${suffix}`, null, null, 4000);
}

// ============================================================
// CLEAR — только активной доски
// ============================================================
async function clearActiveBoard() {
  if (state.tasks.length === 0) { showToast('Доска уже пуста'); return; }
  const ok = await confirmDialog(
    'Очистить доску',
    `Все ${state.tasks.length} задач текущей доски «${state.boardName}» будут удалены. Сама доска и её настройки сохранятся.`
  );
  if (!ok) return;
  try { await dbClearActiveBoardTasks(state.activeBoardId); }
  catch (e) { showToast('Ошибка очистки: ' + e.message); return; }
  // Clear native alarms only after IndexedDB has removed these tasks.
  state.tasks.forEach(t => syncNativeReminder({ ...t, reminder: '' }));
  state.tasks.flatMap(t => t.files).forEach(f => scheduleMediaDelete(f.id, 0));
  state.tasks.length = 0;
  thumbCache.clear();
  notifyOtherTabs();
  renderBoard();
  showToast('Доска очищена');
}

// ============================================================
// DRAG & DROP
// ============================================================
function setupDragAndDrop() {
  const board = $('#board');
  board.addEventListener('pointerdown', onPointerDown);
}
function onPointerDown(e) {
  if (e.button !== 0) return;
  const card = e.target.closest('.task-card');
  if (!card) return;
  if (e.target.closest('[data-delete], [data-media], [data-move-next], [data-move-done], button, input, .ap')) return;
  if (!isDragAllowed()) return;
  drag = {
    card, taskId: card.dataset.taskId, pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY, startTime: Date.now(),
    isTouch: e.pointerType !== 'mouse', active: false, timer: null
  };
  lastPointer = { x: e.clientX, y: e.clientY };
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  if (drag.isTouch) drag.timer = setTimeout(() => { if (drag && !drag.active) startDrag(); }, 300);
}
function startDrag() {
  if (!drag || drag.active) return;
  drag.active = true;
  clearTimeout(drag.timer);
  drag.card.classList.add('dragging');
  $('#board').classList.add('is-dragging');
  document.body.style.userSelect = 'none';
  document.addEventListener('touchmove', preventTouch, { passive: false });
  if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) {} }
  updateDropTarget(lastPointer.x, lastPointer.y);
}
function preventTouch(e) { if (drag && drag.active) e.preventDefault(); }
function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  lastPointer = { x: e.clientX, y: e.clientY };
  if (!drag.active) {
    const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (drag.isTouch) { if (dist > 10) { cleanupDragWithoutRerender(); return; } }
    else { if (dist < 5) return; startDrag(); }
  }
  if (e.cancelable) e.preventDefault();
  updateDropTarget(e.clientX, e.clientY);
  updateAutoScroll(e.clientX, e.clientY);
}
function cleanupDragWithoutRerender() {
  if (!drag) return;
  clearTimeout(drag.timer);
  cleanupDragListeners();
  stopAutoScroll();
  if (drag.card) drag.card.classList.remove('dragging');
  document.body.style.userSelect = '';
  $('#board').classList.remove('is-dragging');
  drag = null;
}
async function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const wasActive = drag.active;
  const card = drag.card;
  cleanupDragListeners();
  clearTimeout(drag.timer);
  stopAutoScroll();
  if (wasActive) {
    lastDragEndTime = Date.now();
    card.classList.remove('dragging');
    document.body.style.userSelect = '';
    $('#board').classList.remove('is-dragging');
    const list = card.parentElement;
    drag = null;
    if (list && list.classList.contains('task-list')) {
      const newColId = list.dataset.columnId;
      const orderedIds = $$('.task-card', list).map(c => c.dataset.taskId);
      const toUpdate = [];
      for (let i = 0; i < orderedIds.length; i++) {
        const t = state.tasks.find(x => x.id === orderedIds[i]);
        if (!t) continue;
        if (t.columnId === newColId && t.order === i) continue;
        const updated = applyColumnChange(t, newColId);
        updated.order = i;
        toUpdate.push(updated);
      }
      try {
        await persistTaskChanges(toUpdate);
        for (const c of toUpdate) await syncKids(c);
        notifyOtherTabs();
      } catch (err) { showToast('Не удалось сохранить порядок: ' + err.message); }
    }
    renderBoard();
  } else {
    drag = null;
  }
}
function onPointerCancel() { cleanupDragWithoutRerender(); }
function cleanupDragListeners() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  document.removeEventListener('touchmove', preventTouch);
}
function getAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.task-card:not(.dragging)')];
  let closest = { offset: -Infinity, element: null };
  for (const child of cards) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}
function updateDropTarget(x, y) {
  if (!drag || !drag.active) return;
  $$('.task-list.drag-over').forEach(el => el.classList.remove('drag-over'));
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  let list = el.closest('.task-list');
  if (!list) { const col = el.closest('.column'); if (col) list = col.querySelector('.task-list'); }
  if (!list) return;
  list.classList.add('drag-over');
  const after = getAfterElement(list, y);
  const card = drag.card;
  if (after === card) return;
  if (after == null) { if (list.lastElementChild !== card) list.appendChild(card); }
  else { if (after.previousSibling !== card) list.insertBefore(card, after); }
}
function updateAutoScroll(x, y) {
  if (!drag || !drag.active) return;
  const board = $('#board');
  const rect = board.getBoundingClientRect();
  const edge = 60;
  let dirX = 0, dirY = 0;
  if (x < rect.left + edge && board.scrollLeft > 0) dirX = -1;
  else if (x > rect.right - edge && board.scrollLeft < board.scrollWidth - board.clientWidth) dirX = 1;
  const listEl = document.elementFromPoint(x, y)?.closest('.task-list');
  if (listEl) {
    const lr = listEl.getBoundingClientRect();
    if (y < lr.top + edge && listEl.scrollTop > 0) dirY = -1;
    else if (y > lr.bottom - edge && listEl.scrollTop < listEl.scrollHeight - listEl.clientHeight) dirY = 1;
  }
  if (dirX === 0 && dirY === 0) { stopAutoScroll(); return; }
  autoScrollDir = { x: dirX, y: dirY };
  if (!autoScrollInterval) {
    autoScrollInterval = setInterval(() => {
      if (!drag || !drag.active) { stopAutoScroll(); return; }
      const b = $('#board');
      if (autoScrollDir.x !== 0) b.scrollLeft += autoScrollDir.x * 12;
      if (autoScrollDir.y !== 0) {
        const l = document.elementFromPoint(lastPointer.x, lastPointer.y)?.closest('.task-list');
        if (l) l.scrollTop += autoScrollDir.y * 12;
      }
      updateDropTarget(lastPointer.x, lastPointer.y);
    }, 16);
  }
}
function stopAutoScroll() { if (autoScrollInterval) { clearInterval(autoScrollInterval); autoScrollInterval = null; } }

// ============================================================
// EVENT BINDINGS
// ============================================================
// On narrow screens the actions sit inside a collapsible overflow menu.
// Close it when an action is selected, especially before Android's file picker.
// Desktop keeps its always-visible toolbar.
function bindMobileActionsMenu() {
  const menu = document.querySelector('.mobile-actions');
  if (!menu) return;
  menu.addEventListener('click', e => {
    if (window.matchMedia('(max-width: 600px)').matches && e.target.closest('button')) {
      menu.open = false;
    }
  });
}
function bindEvents() {
  bindMobileActionsMenu();
  $('#themeBtn').onclick = toggleTheme;
  $('#exportBtn').onclick = exportData;
  $('#exportCsvBtn').onclick = exportCsv;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) handleImport(f);
  };
  $('#settingsBtn').onclick = openSettingsModal;
  $('#clearBtn').onclick = clearActiveBoard;

  $('#boardSelect').onchange = (e) => switchBoard(e.target.value);
  $('#addBoardBtn').onclick = async () => {
    const name = await askForText('Название новой доски', 'Новая доска', 100);
    if (name === null) return;
    await addBoard(name);
  };
  $('#deleteBoardBtn').onclick = async () => {
    await deleteBoard(state.activeBoardId);
  };

  $$('.view-tab').forEach(tab => tab.onclick = () => switchView(tab.dataset.view));

  $('#globalSearchInput').addEventListener('input', renderGlobalSearch);
  $('#globalSearchBoardFilter').addEventListener('change', renderGlobalSearch);
  $('#globalSearchStatusFilter').addEventListener('change', renderGlobalSearch);
  $('#globalSearchDeadlineFilter').addEventListener('change', renderGlobalSearch);
  let searchTimer = null;
  $('#searchInput').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchQuery = e.target.value.trim(); renderBoard(); }, 150);
  };
  $('#tagFilter').onchange = (e) => { filterTag = e.target.value; saveUIState(); renderBoard(); };
  $('#priorityFilter').onchange = (e) => { filterPriority = e.target.value; saveUIState(); renderBoard(); };
  $('#deadlineFilter').onchange = (e) => { filterDeadline = e.target.value; saveUIState(); renderBoard(); };
  $('#sortSelect').onchange = (e) => { sortMode = e.target.value; saveUIState(); renderBoard(); };

  $('#taskDeadlinePresets').addEventListener('click', event => {
    const button = event.target.closest('button[data-deadline-preset]');
    if (button) applyTaskDeadlinePreset(button.dataset.deadlinePreset);
  });
  $('#taskReminderPresets').addEventListener('click', event => {
    const button = event.target.closest('button[data-reminder-preset]');
    if (button) applyTaskReminderPreset(button.dataset.reminderPreset);
  });
  $('#taskRepeatChoices').addEventListener('click', event => {
    const button = event.target.closest('button[data-task-repeat]');
    if (button) setTaskRepeat(button.dataset.taskRepeat);
  });
  $$('#priorityChips .chip').forEach(chip => chip.onclick = () => setPriorityChips(chip.dataset.priority));
  $('#addChecklistBtn').onclick = addChecklistItem;
  $('#saveTaskBtn').onclick = saveTaskFromModal;

  $('#dupTaskBtn').onclick = async () => { if (editingTaskId) await duplicateTask(editingTaskId); };
  $('#deleteTaskBtn').onclick = async () => {
    if (!editingTaskId) return;
    const id = editingTaskId;
    modalInitialSnapshot = null;
    closeModal('taskModal');
    await deleteTask(id);
  };

  $('#taskFile').onchange = (e) => {
    for (const f of e.target.files) {
      if (f.size > MAX_VIDEO_SIZE) { showToast(`«${f.name}» больше 50 МБ`); continue; }
      newFiles.push(f);
      if (isAudio(f)) prepAudio(f).then(renderFiles);
    }
    e.target.value = ''; renderFiles();
  };

  $('#addColumnBtn').onclick = addColumnConfig;
  bindAudio();
  $('#saveSettingsBtn').onclick = saveSettingsFromModal;

  $('#calPrev').onclick = () => { calendarCursor.setDate(1); calendarCursor.setMonth(calendarCursor.getMonth() - 1); renderCalendar(); };
  $('#calNext').onclick = () => { calendarCursor.setDate(1); calendarCursor.setMonth(calendarCursor.getMonth() + 1); renderCalendar(); };
  $('#calToday').onclick = () => { calendarCursor = new Date(); renderCalendar(); };

  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close]');
    if (!closeBtn) return;
    const target = closeBtn.dataset.close;
    if (target === 'taskModal') tryCloseTaskModal();
    else closeModal(target);
  });
  ['taskModal', 'settingsModal', 'shortcutsModal'].forEach(id => {
    const m = $('#' + id);
    m.addEventListener('click', (e) => {
      if (e.target !== m) return;
      if (id === 'taskModal') tryCloseTaskModal();
      else closeModal(id);
    });
  });
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
  $('#lightboxClose').onclick = closeLightbox;
  $('#lightboxPrev').onclick = () => stepLightbox(-1);
  $('#lightboxNext').onclick = () => stepLightbox(1);
  $('#lightboxZoomIn').onclick = () => setLightboxZoom(lightboxZoom * 1.5);
  $('#lightboxZoomOut').onclick = () => setLightboxZoom(lightboxZoom / 1.5);
  $('#lightboxZoomReset').onclick = () => setLightboxZoom(1);

  let photoGesture = null, lastPhotoTap = null, lastTouchZoomAt = 0;
  const touchDistance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const togglePhotoZoom = (x, y) => setLightboxZoom(lightboxZoom > 1 ? 1 : 2.5, x, y);

  $('#lightbox').addEventListener('touchstart', e => {
    if (!lightboxImage() || e.target.closest('button, video')) {
      photoGesture = null; return;
    }
    if (e.touches.length === 2) {
      photoGesture = { mode: 'pinch', distance: touchDistance(e.touches[0], e.touches[1]), zoom: lightboxZoom };
      lastPhotoTap = null;
      e.preventDefault();
    } else if (e.touches.length === 1) {
      const touch = e.touches[0];
      photoGesture = { mode: 'single', x: touch.clientX, y: touch.clientY,
        panX: lightboxPanX, panY: lightboxPanY };
    }
  }, { passive: false });
  $('#lightbox').addEventListener('touchmove', e => {
    if (!photoGesture) return;
    if (photoGesture.mode === 'pinch' && e.touches.length >= 2) {
      const a = e.touches[0], b = e.touches[1];
      const distance = touchDistance(a, b);
      if (photoGesture.distance > 0) {
        setLightboxZoom(photoGesture.zoom * distance / photoGesture.distance,
          (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      }
      e.preventDefault();
    } else if (photoGesture.mode === 'single' && e.touches.length === 1 && lightboxZoom > 1) {
      const touch = e.touches[0];
      panLightboxTo(photoGesture.panX + touch.clientX - photoGesture.x,
        photoGesture.panY + touch.clientY - photoGesture.y);
      e.preventDefault();
    }
  }, { passive: false });
  $('#lightbox').addEventListener('touchend', e => {
    if (!photoGesture || e.touches.length) return;
    const gesture = photoGesture;
    photoGesture = null;
    if (gesture.mode !== 'single' || !e.changedTouches.length) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.25 && lightboxZoom === 1) {
      lastPhotoTap = null;
      stepLightbox(dx < 0 ? 1 : -1);
      return;
    }
    if (Math.hypot(dx, dy) > 20 || !e.target.closest('img')) {
      lastPhotoTap = null; return;
    }
    const now = Date.now();
    if (lastPhotoTap && now - lastPhotoTap.at <= 320 &&
        Math.hypot(touch.clientX - lastPhotoTap.x, touch.clientY - lastPhotoTap.y) < 32) {
      togglePhotoZoom(touch.clientX, touch.clientY);
      lastTouchZoomAt = now;
      lastPhotoTap = null;
    } else {
      lastPhotoTap = { x: touch.clientX, y: touch.clientY, at: now };
    }
  }, { passive: true });
  $('#lightbox').addEventListener('touchcancel', () => { photoGesture = null; lastPhotoTap = null; });
  $('#lightboxContent').addEventListener('dblclick', e => {
    if (e.target.tagName !== 'IMG' || Date.now() - lastTouchZoomAt < 500) return;
    e.preventDefault();
    togglePhotoZoom(e.clientX, e.clientY);
  });
  $('#lightboxContent').addEventListener('wheel', e => {
    if (e.target.tagName !== 'IMG' || !e.ctrlKey) return;
    e.preventDefault();
    setLightboxZoom(lightboxZoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
  }, { passive: false });
  // Android Back closes the topmost overlay. In the task editor it
  // performs the same validated, atomic save as the Save button.
  // The modal remains open if validation or storage fails.
  window.kanbanHandleBack = () => {
    if ($('#lightbox').classList.contains('open')) {
      closeLightbox();
      return true;
    }
    if ($('#confirmModal').classList.contains('open')) {
      $('#confirmCancel').click();
      return true;
    }
    if ($('#taskModal').classList.contains('open')) {
      void saveTaskFromModal().catch(e =>
        showToast('Не удалось сохранить задачу: ' + (e.message || e))
      );
      return true;
    }
    if ($('#settingsModal').classList.contains('open')) {
      closeModal('settingsModal');
      return true;
    }
    if ($('#shortcutsModal').classList.contains('open')) {
      closeModal('shortcutsModal');
      return true;
    }
    return false;
  };

  document.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      if ($('#lightbox').classList.contains('open')) { closeLightbox(); return; }
      if ($('#confirmModal').classList.contains('open')) { $('#confirmCancel').click(); return; }
      if ($('#taskModal').classList.contains('open')) { await tryCloseTaskModal(); return; }
      if ($('#settingsModal').classList.contains('open')) { closeModal('settingsModal'); return; }
      if ($('#shortcutsModal').classList.contains('open')) { closeModal('shortcutsModal'); return; }
      if (document.activeElement === $('#searchInput')) {
        $('#searchInput').value = ''; searchQuery = '';
        document.activeElement.blur();
        renderBoard();
      }
      return;
    }
    if ($('#lightbox').classList.contains('open')) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); stepLightbox(e.key === 'ArrowRight' ? 1 : -1);
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault(); setLightboxZoom(lightboxZoom * 1.5);
      } else if (e.key === '-') {
        e.preventDefault(); setLightboxZoom(lightboxZoom / 1.5);
      } else if (e.key === '0') {
        e.preventDefault(); setLightboxZoom(1);
      }
      return;
    }
    const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if ($('#taskModal').classList.contains('open')) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) { e.preventDefault(); saveTaskFromModal(); }
      return;
    }
    if ($('#shortcutsModal').classList.contains('open')) { if (e.key === '?') closeModal('shortcutsModal'); return; }
    if ($('#settingsModal').classList.contains('open') || $('#confirmModal').classList.contains('open') || $('#lightbox').classList.contains('open')) return;
    if (isInput || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'n' || e.key === 'N' || e.key === 'т' || e.key === 'Т') { e.preventDefault(); openTaskModal(null, state.columns[0]?.id); }
    else if (e.key === 'q' || e.key === 'Q' || e.key === 'й' || e.key === 'Й') { e.preventDefault(); switchView('kanban'); setTimeout(() => $('#quickAdd').focus(), 30); }
    else if (e.key === '/') { e.preventDefault(); switchView('kanban'); setTimeout(() => $('#searchInput').focus(), 30); }
    else if (e.key === '1') { e.preventDefault(); switchView('kanban'); }
    else if (e.key === '2') { e.preventDefault(); switchView('dashboard'); }
    else if (e.key === '3') { e.preventDefault(); switchView('mindmap'); }
    else if (e.key === '4') { e.preventDefault(); switchView('calendar'); }
    else if (e.key === '?') { e.preventDefault(); lastFocusBeforeModal = document.activeElement; $('#shortcutsModal').classList.add('open'); trapFocus($('#shortcutsModal')); }
  });

  window.addEventListener('online', () => showToast('Соединение восстановлено'));
  window.addEventListener('offline', () => showToast('Нет сети'));
}

// ============================================================
// QUICK ADD
// ============================================================
function parseQuick(input) {
  let s = ' ' + input + ' ', priority = 'none', deadline = '', tags = [];
  s = s.replace(/\s#([^\s#]+)(?=\s)/g, (m, t) => { tags.push(t); return ' '; });
  const pm = { h: 'high', high: 'high', в: 'high', m: 'medium', med: 'medium', medium: 'medium', с: 'medium', l: 'low', low: 'low', н: 'low' };
  s = s.replace(/\s!(\S+)(?=\s)/g, (m, p) => { const v = pm[p.toLowerCase()]; if (v) { priority = v; return ' '; } return m; });
  const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d); };
  s = s.replace(/\s(today|tomorrow|сегодня|завтра|\+(\d{1,3})d|\d{4}-\d{2}-\d{2})(?=\s)/i, (m, w, n) => {
    const l = w.toLowerCase();
    if (l === 'today' || l === 'сегодня') deadline = todayISO();
    else if (l === 'tomorrow' || l === 'завтра') deadline = addDays(1);
    else if (n) deadline = addDays(+n);
    else if (isValidISODate(w)) deadline = w; else return m;
    return ' ';
  });
  return { title: s.replace(/\s+/g, ' ').trim(), priority, deadline, tags };
}
async function quickAddTask(text) {
  const p = parseQuick(text);
  if (!p.title) return false;
  const col = state.columns[0];
  const task = sanitizeTask({
    id: generateId(), boardId: state.activeBoardId, columnId: col.id,
    title: p.title.slice(0, 200), tags: p.tags, priority: p.priority, deadline: p.deadline,
    order: topOrder(col.id)
  });
  try { await dbPutTask(task); }
  catch (e) { showToast('Не удалось добавить: ' + e.message); return false; }
  state.tasks.push(task);
  notifyOtherTabs(); renderBoard();
  showToast(`Добавлено в «${state.boardName}»`);
  return true;
}

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

// Native Mark Done notifications are queued safely while Android WebView is closed.
// Acknowledge them only AFTER an IndexedDB transaction has committed. The native
// receiver cancels reminders immediately; the actual task is saved on next resume.
let taskActionUiReady = false;
let taskActionApplying = false;
window.kanbanRequestPendingActions = () => {
  if (!taskActionUiReady || !window.KanbanTaskActions) return;
  try { window.KanbanTaskActions.postMessage(JSON.stringify({ op: 'list' })); }
  catch (e) { console.warn('Pending notification actions unavailable:', e); }
};
window.kanbanReceiveTaskActions = async (raw) => {
  if (!taskActionUiReady || taskActionApplying || !state.boards.length) return;
  let actions;
  try { actions = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (_) { return; }
  if (!Array.isArray(actions) || !actions.length) return;
  // Editing a task takes priority; do not overwrite a draft with a queued action.
  if ($('#taskModal').classList.contains('open')) return;
  taskActionApplying = true;
  let changed = false;
  try {
    for (const action of actions) {
      if (!action || action.action !== 'complete' ||
          typeof action.taskId !== 'string' || !action.taskId ||
          typeof action.token !== 'string' || !action.token) continue;
      if ($('#taskModal').classList.contains('open')) break;
      const board = state.boards.find(b =>
        (state._tasksByBoard[b.id] || []).some(t => t.id === action.taskId));
      let applied = false;
      if (!board) {
        // Task was deleted or replaced by an imported backup.
        applied = true;
      } else {
        const tasks = state._tasksByBoard[board.id];
        const doneColumn = board.columns.find(c => c.isDone);
        if (!doneColumn) {
          showToast('Нет колонки «Готово» на доске «' + board.name + '»');
          continue; // Keep action queued for when a Done column becomes available.
        }
        const affected = new Set([action.taskId]);
        let size;
        do {
          size = affected.size;
          for (const task of tasks) if (affected.has(task.parentId)) affected.add(task.id);
        } while (affected.size !== size);
        const now = Date.now();
        const candidates = tasks.filter(t => affected.has(t.id) &&
          (t.columnId !== doneColumn.id || !t.completedAt)).map(t => ({
            ...t, columnId: doneColumn.id, completedAt: t.completedAt || now,
            updatedAt: now
          }));
        if (candidates.length) {
          const orders = tasks.filter(t => t.columnId === doneColumn.id)
            .map(t => t.order ?? 0);
          const root = candidates.find(t => t.id === action.taskId);
          if (root) root.order = orders.length ? Math.min(...orders) - 1 : 0;
          try {
            await persistTaskChanges(candidates, tasks, board);
            changed = true;
          } catch (error) {
            showToast('Не удалось завершить задачу: ' + (error.message || error));
            continue; // Never acknowledge a failed IndexedDB write.
          }
        }
        applied = true;
      }
      if (applied && window.KanbanTaskActions) {
        try {
          window.KanbanTaskActions.postMessage(JSON.stringify({
            op: 'ack', taskId: action.taskId, token: action.token
          }));
        } catch (error) { console.warn('Mark Done acknowledgement failed:', error); }
      }
    }
  } finally {
    taskActionApplying = false;
    if (changed) { notifyOtherTabs(); renderBoard(); }
  }
};

// Notification taps may arrive before IndexedDB has finished loading.
let notificationUiReady = false;
let notificationOpening = false;
window.kanbanApplyPendingNotification = async () => {
  if (!notificationUiReady || notificationOpening || !window.__kanbanNotificationPending) return;
  const target = window.__kanbanNotificationPending;
  delete window.__kanbanNotificationPending;
  notificationOpening = true;
  try {
    const taskId = typeof target.taskId === 'string' ? target.taskId : '';
    const boardId = typeof target.boardId === 'string' ? target.boardId : '';
    const board = state.boards.find(b => b.id === boardId &&
      (state._tasksByBoard[b.id] || []).some(t => t.id === taskId)) ||
      // A task may have been moved after the reminder was scheduled.
      state.boards.find(b => (state._tasksByBoard[b.id] || []).some(t => t.id === taskId));
    if (!board) { showToast('Задача из уведомления не найдена'); return; }
    if ($('#taskModal').classList.contains('open')) {
      if (isModalDirty() &&
          !await confirmDialog('Открыть задачу из уведомления?', 'Несохранённые изменения будут потеряны.')) return;
      closeModal('taskModal');
    }
    if (state.activeBoardId !== board.id) await switchBoard(board.id);
    switchView('kanban');
    openTaskModal(taskId);
  } catch (error) {
    showToast('Не удалось открыть задачу: ' + (error.message || error));
  } finally {
    notificationOpening = false;
    if (window.__kanbanNotificationPending) void window.kanbanApplyPendingNotification();
  }
};

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
  notificationUiReady = true;
  void window.kanbanApplyPendingNotification();
  taskActionUiReady = true;
  window.kanbanRequestPendingActions();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) window.kanbanRequestPendingActions();
  });
  registerServiceWorker();
}

init();
})();

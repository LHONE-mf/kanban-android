
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
const VALID_VIEWS = ['kanban', 'dashboard', 'mindmap', 'calendar'];

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
  await dbPutTasks(ch);
  ch.forEach(c => { const i = state.tasks.findIndex(x => x.id === c.id); if (i > -1) state.tasks[i] = c; });
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
    tasks.forEach(t => t.files.forEach(f => scheduleMediaDelete(f.id, 0)));
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


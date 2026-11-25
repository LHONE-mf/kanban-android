
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
let tempResults = [];
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
// Construct a local parent index from the current task array, without caching.
// Each invocation sees deletes, restores, board switches and committed edits.
function subtree(id) {
  const children = new Map();
  for (const task of state.tasks) {
    const parentId = task.parentId;
    if (!parentId) continue;
    let siblings = children.get(parentId);
    if (!siblings) {
      siblings = [];
      children.set(parentId, siblings);
    }
    siblings.push(task);
  }
  // Reverse pushes preserve the old depth-first order of the original array.
  const stack = [];
  const roots = children.get(id) || [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
  const seen = new Set([id]);
  const result = [];
  while (stack.length) {
    const task = stack.pop();
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    result.push(task);
    const descendants = children.get(task.id);
    if (descendants) {
      for (let i = descendants.length - 1; i >= 0; i--) stack.push(descendants[i]);
    }
  }
  return result;
}
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

async function persistBoards(activeBoardId = state.activeBoardId) {
  await dbPutSettingsBulk([
    ['boards', state.boards],
    ['activeBoardId', activeBoardId]
  ]);
}

let switchingBoard = false;
async function switchBoard(id) {
  const select = $('#boardSelect');
  if (switchingBoard || !getBoard(id) || id === state.activeBoardId) {
    if (select) select.value = state.activeBoardId;
    return false;
  }
  switchingBoard = true;
  try {
    if (savingTask) {
      showToast('Дождитесь сохранения задачи');
      return false;
    }
    const modal = $('#taskModal');
    if (modal.classList.contains('open') && isModalDirty()) {
      const discard = await confirmDialog('Сменить доску без сохранения?', 'Несохранённые изменения задачи будут потеряны.');
      if (!discard) return false;
    }
    // A save may have started while the confirmation dialog was open.
    if (savingTask) {
      showToast('Дождитесь сохранения задачи');
      return false;
    }
    try { await persistBoards(id); }
    catch (e) { showToast('Не сохранилось: ' + e.message); return false; }
    if (modal.classList.contains('open')) closeModal('taskModal');
    state.activeBoardId = id;
    applyActiveBoard();
    renderBoard();
    saveUIState();
    notifyOtherTabs();
    return true;
  } finally {
    switchingBoard = false;
    if (select) select.value = state.activeBoardId;
  }
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

let deletingBoard = false;
async function deleteBoard(id) {
  if (deletingBoard) return false;
  if (state.boards.length <= 1) { showToast('Нельзя удалить единственную доску'); return false; }
  const board = getBoard(id);
  if (!board) return false;
  if (savingTask || switchingBoard || importInProgress || $('#taskModal').classList.contains('open')) {
    showToast('Сначала завершите редактирование или импорт'); return false;
  }
  deletingBoard = true;
  try {
    const tasks = state._tasksByBoard[id] || [];
    const msg = tasks.length
      ? 'Удалить доску «' + board.name + '» вместе с ' + tasks.length + ' задачами и их вложениями? Это нельзя отменить.'
      : 'Удалить пустую доску «' + board.name + '»? Это нельзя отменить.';
    if (!await confirmDialog('Удалить доску', msg)) return false;
    // A board change or task editor may have started while the dialog was open.
    if (state.boards.length <= 1 || !getBoard(id) || state.activeBoardId !== id ||
        savingTask || switchingBoard || importInProgress || $('#taskModal').classList.contains('open')) {
      showToast('Состояние доски изменилось. Повторите удаление.'); return false;
    }
    const nextBoards = state.boards.filter(b => b.id !== id);
    const nextActiveId = nextBoards[0].id;
    await dbDeleteBoard(id, nextBoards, nextActiveId);
    state.boards = nextBoards;
    delete state._tasksByBoard[id];
    state.activeBoardId = nextActiveId;
    if ($('#settingsModal').classList.contains('open')) closeModal('settingsModal');
    applyActiveBoard();
    renderBoard();
    saveUIState();
    notifyOtherTabs();
    showToast('Доска удалена');
    return true;
  } catch (e) {
    showToast('Ошибка удаления: ' + e.message);
    return false;
  } finally {
    deletingBoard = false;
  }
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
async function dbDeleteBoard(boardId, nextBoards, nextActiveBoardId) {
  return new Promise((res, rej) => {
    const tx = db.transaction([STORE_TASKS, STORE_SETTINGS, STORE_MEDIA], 'readwrite');
    const taskStore = tx.objectStore(STORE_TASKS);
    const settingsStore = tx.objectStore(STORE_SETTINGS);
    const mediaStore = tx.objectStore(STORE_MEDIA);
    let failure = null;
    // Only resolve or reject once IndexedDB confirms commit or rollback.
    tx.oncomplete = () => res();
    tx.onerror = event => { if (!failure) failure = event.target?.error || tx.error; };
    tx.onabort = () => rej(wrapTxError(failure || tx.error || new Error('Транзакция отменена')));
    try {
      const req = taskStore.getAll();
      req.onerror = () => { if (!failure) failure = req.error || tx.error; };
      req.onsuccess = () => {
        try {
          const removedMedia = new Set();
          const remainingMedia = new Set();
          const mediaIds = task => {
            const ids = Array.isArray(task.files) ? task.files.map(f => f && f.id) : [];
            if (typeof task.mediaId === 'string') ids.push(task.mediaId);
            return ids.filter(id => typeof id === 'string' && id);
          };
          for (const task of req.result) {
            const isDeleted = task.boardId === boardId;
            for (const mediaId of mediaIds(task)) {
              (isDeleted ? removedMedia : remainingMedia).add(mediaId);
            }
            if (isDeleted) taskStore.delete(task.id);
          }
          for (const mediaId of removedMedia) {
            if (!remainingMedia.has(mediaId)) mediaStore.delete(mediaId);
          }
          settingsStore.put({ key: 'boards', value: nextBoards });
          settingsStore.put({ key: 'activeBoardId', value: nextActiveBoardId });
        } catch (e) {
          failure = e;
          try { tx.abort(); } catch (_) { rej(wrapTxError(e)); }
        }
      };
    } catch (e) {
      failure = e;
      try { tx.abort(); } catch (_) { rej(wrapTxError(e)); }
    }
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
    let failure = null;
    // A request error fires before the transaction has finished rolling back.
    // Preserve its cause, but only reject after onabort confirms rollback.
    tx.oncomplete = () => res();
    tx.onerror = event => {
      if (!failure) failure = event.target?.error || tx.error;
    };
    tx.onabort = () => rej(wrapTxError(failure || tx.error));
    try {
      const ts = tx.objectStore(STORE_TASKS);
      const ss = tx.objectStore(STORE_SETTINGS);
      const ms = tx.objectStore(STORE_MEDIA);
      ts.clear(); ss.clear(); ms.clear();
      plan.tasks.forEach(t => ts.put(t));
      ss.put({ key: 'boards', value: plan.boards });
      ss.put({ key: 'activeBoardId', value: plan.activeBoardId });
      if (plan.dayPlan) ss.put({ key: 'comrade_day_plan_v1', value: plan.dayPlan });
      if (plan.settings) {
        for (const [key, value] of Object.entries(plan.settings)) {
          if (key !== 'boards' && key !== 'activeBoardId') ss.put({ key, value });
        }
      }
      if (plan.projection) ss.put({ key: ZIP_PROJECTION, value: plan.projection });
      for (const [id, m] of Object.entries(plan.media)) {
        ms.put({ full: m.full, thumb: m.thumb, type: m.type }, id);
      }
    } catch (e) {
      failure = e;
      try { tx.abort(); } catch (_) { rej(wrapTxError(e)); }
    }
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
function notifyOtherTabs() {
  if (broadcast) broadcast.postMessage({ type: 'changed', at: Date.now() });
  if (globalThis.KanbanTaskReminders) queueTaskReminders();
}
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
  const attachedResults = new Set((Array.isArray(t.files) ? t.files : []).map(f => f?.resultId).filter(Boolean));
  const results = Array.isArray(t.results) ? t.results.filter(r => r && typeof r.text === 'string' && (r.text.trim() || attachedResults.has(r.id))).map(r => ({
    id: String(r.id || 'result_' + generateId()), text: r.text,
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : (Number.isFinite(r.createdAt) ? r.createdAt : Date.now())
  })) : [];
  const resultIds = new Set(results.map(r => r.id));
  return {
    id: String(t.id || generateId()),
    boardId: typeof t.boardId === 'string' ? t.boardId : '',
    columnId: String(t.columnId || t.colId || ''),
    title: String(t.title || t.name || 'Без названия'),
    desc: String(t.desc || t.description || ''),
    tags: Array.isArray(t.tags) ? t.tags.map(String).filter(Boolean) : [],
    priority: PRIORITY_LABELS[t.priority] ? t.priority : 'none',
    deadline: typeof t.deadline === 'string' ? t.deadline : (typeof t.dueDate === 'string' ? t.dueDate : ''),
    ...(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t.reminderTime) ? { reminderTime: t.reminderTime } : {}),
    parentId: typeof t.parentId === 'string' ? t.parentId : '',
    files: Array.isArray(t.files)
      ? t.files.filter(f => f && typeof f.id === 'string').map(f => ({ id: f.id, name: String(f.name || 'Файл'), type: String(f.type || ''), size: +f.size || 0, ...(resultIds.has(f.resultId) ? { resultId: f.resultId } : {}), ...(+f.dur ? { dur: +f.dur } : {}), ...(Array.isArray(f.peaks) ? { peaks: f.peaks.slice(0, 96).map(n => Math.max(0, Math.min(100, +n || 0))) } : {}) }))
      : (typeof t.mediaId === 'string' ? [{ id: t.mediaId, name: 'Вложение', type: String(t.mediaType || ''), size: 0 }] : []),
    checklist: Array.isArray(t.checklist)
      ? t.checklist.map(c => c && typeof c === 'object' ? {
          id: String(c.id || 'cl_' + generateId()),
          text: String(c.text || ''),
          checked: !!(c.checked || c.done)
        } : null).filter(c => c && c.text)
      : [],
    results,
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

    if (rawTasks.length === 0 && !settings.p19_zip_imported) {
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
    if (globalThis.KanbanTaskReminders) queueTaskReminders();
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
  if (globalThis.KanbanTaskReminders) queueTaskReminders();
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
      if (!hay.includes(q) && !(t.results || []).some(r => r.text.toLowerCase().includes(q)) &&
          !(t.files || []).some(f => f.resultId && f.name.toLowerCase().includes(q))) return false;
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

// ============================================================
// RENDER dispatcher
// ============================================================
// One parent index per render avoids a full subtree() scan for every card.
function countVisibleDescendants(tasks, visibleRoots) {
  const childrenByParent = new Map();
  for (const task of tasks) {
    const parentId = task.parentId;
    if (!parentId) continue;
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(task.id);
    else childrenByParent.set(parentId, [task.id]);
  }

  const counts = new Map();
  for (const root of visibleRoots) {
    const stack = [...(childrenByParent.get(root.id) || [])];
    const seen = new Set([root.id]);
    let count = 0;
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      count++;
      const children = childrenByParent.get(id);
      if (children) stack.push(...children);
    }
    counts.set(root.id, count);
  }
  return counts;
}

function renderBoard() {
  updateTagFilter();
  const board = $('#board');
  // Default column IDs repeat across different boards, but scroll offsets must not.
  const sameBoard = board.dataset.boardId === state.activeBoardId;
  const scrolls = {};
  if (sameBoard) {
    $$('.task-list', board).forEach(el => { scrolls[el.dataset.columnId] = el.scrollTop; });
  }
  const boardScroll = sameBoard ? board.scrollLeft : 0;
  board.innerHTML = '';
  board.dataset.boardId = state.activeBoardId;
  const visible = getVisibleTasks();
  const descendantCounts = visible.length ? countVisibleDescendants(state.tasks, visible) : null;
  // Group visible roots and count all roots once, rather than scanning tasks
  // separately for each column. Count remains independent of active filters.
  const byColumn = new Map(state.columns.map(col => [col.id, []]));
  const rootCounts = new Map(state.columns.map(col => [col.id, 0]));
  for (const task of state.tasks) {
    if (task.parentId || !rootCounts.has(task.columnId)) continue;
    rootCounts.set(task.columnId, rootCounts.get(task.columnId) + 1);
  }
  for (const task of visible) {
    const bucket = byColumn.get(task.columnId);
    if (bucket) bucket.push(task);
  }

  state.columns.forEach(col => {
    const colTasks = sortTasks(byColumn.get(col.id));
    const totalCount = rootCounts.get(col.id);

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
      colTasks.forEach(task => list.appendChild(createTaskCard(task, col, descendantCounts)));
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

  if (currentView === 'dashboard') renderDashboard();
  else if (currentView === 'mindmap') renderMindmap();
  else if (currentView === 'calendar') renderCalendar();
}

function renderFilteredBoard() {
  const board = $('#board');
  if (!board || board.dataset.boardId !== state.activeBoardId ||
      currentView !== 'kanban' || (drag && drag.active) ||
      board.children.length !== state.columns.length) {
    renderBoard();
    return;
  }
  updateTagFilter();
  const byColumn = new Map(state.columns.map(col => [col.id, []]));
  for (const task of getVisibleTasks()) {
    if (byColumn.has(task.columnId)) byColumn.get(task.columnId).push(task);
  }
  const columns = [];
  const newTasks = [];
  const knownIds = new Set(state.tasks.map(t => t.id));
  for (const column of state.columns) {
    const node = [...board.children].find(el => el.dataset.columnId === column.id);
    const list = node && node.querySelector('.task-list');
    const header = node && node.querySelector('.column-header');
    const count = header && header.querySelector('.column-count');
    if (!list || !header || !count) { renderBoard(); return; }
    const cards = new Map();
    for (const child of [...list.children]) {
      if (child.classList.contains('empty-hint')) continue;
      if (!child.classList.contains('task-card') ||
          !knownIds.has(child.dataset.taskId) || cards.has(child.dataset.taskId)) {
        renderBoard();
        return;
      }
      cards.set(child.dataset.taskId, child);
    }
    const ordered = sortTasks(byColumn.get(column.id));
    for (const task of ordered) if (!cards.has(task.id)) newTasks.push(task);
    columns.push({column,list,header,count,cards,ordered,scroll:list.scrollTop});
  }
  const descendantCounts = newTasks.length
    ? countVisibleDescendants(state.tasks, newTasks) : null;
  const boardScroll = board.scrollLeft;
  for (const entry of columns) {
    const {column,list,header,count,cards,ordered} = entry;
    const wanted = new Set(ordered.map(t => t.id));
    for (const child of [...list.children]) {
      if (child.classList.contains('empty-hint') || !wanted.has(child.dataset.taskId))
        child.remove();
    }
    let anchor = null;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const task = ordered[i];
      const card = cards.get(task.id) || createTaskCard(task,column,descendantCounts);
      if (card.parentElement !== list || card.nextElementSibling !== anchor)
        list.insertBefore(card,anchor);
      anchor = card;
    }
    const total = state.tasks.filter(t => t.columnId === column.id && !t.parentId).length;
    if (!ordered.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = total ? 'Ничего не найдено' : 'Нет задач';
      list.appendChild(hint);
    }
    const limit = column.wipLimit || 0;
    header.classList.toggle('wip-exceeded', !!limit && total > limit);
    header.classList.toggle('wip-warning', !!limit && total === limit);
    count.textContent = String(total) + (limit ? '/' + limit : '');
  }
  for (const entry of columns) entry.list.scrollTop = entry.scroll;
  board.scrollLeft = boardScroll;
  updateStorageInfo();
}

// P16.1: replace only the edited card when its place and visibility are stable.
// Other cases deliberately use the established full-render path.
function renderSavedTaskCard(previous, task) {
  const stableSort = sortMode === 'manual' || sortMode === 'created_asc' || sortMode === 'created_desc';
  if (!previous || previous.parentId || task.parentId ||
      previous.boardId !== task.boardId ||
      previous.columnId !== task.columnId ||
      previous.order !== task.order ||
      currentView !== 'kanban' || !stableSort ||
      searchQuery.trim() || filterTag || filterPriority || filterDeadline) {
    renderBoard();
    return;
  }

  const board = $('#board');
  if (!board || board.dataset.boardId !== state.activeBoardId) {
    renderBoard();
    return;
  }
  const column = state.columns.find(c => c.id === task.columnId);
  const list = [...board.querySelectorAll('.task-list')].find(el => el.dataset.columnId === task.columnId);
  const oldCard = list && [...list.children].find(el =>
    el.classList.contains('task-card') && el.dataset.taskId === task.id);
  if (!column || !oldCard) {
    renderBoard();
    return;
  }

  const restoreFocus = oldCard === document.activeElement || oldCard.contains(document.activeElement);
  const replacement = createTaskCard(task, column);
  oldCard.replaceWith(replacement);
  if (restoreFocus) replacement.focus({ preventScroll: true });
  updateTagFilter();
  updateStorageInfo();
}

function taskRootForCollection(task) {
  const seen = new Set();
  let current = task;
  while (current && current.parentId) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    current = state.tasks.find(t => t.id === current.parentId);
  }
  return current || null;
}

function renderTaskCollectionChange(task, removed, rootBeforeRemoval = null) {
  if (!task || task.boardId !== state.activeBoardId || currentView !== 'kanban' ||
      searchQuery.trim() || filterTag || filterPriority || filterDeadline) {
    renderBoard();
    return;
  }
  const root = task.parentId ? (rootBeforeRemoval || taskRootForCollection(task)) : task;
  const board = $('#board');
  const column = root && state.columns.find(col => col.id === root.columnId);
  const columnNode = board && [...board.children].find(el =>
    el.dataset.columnId === root?.columnId);
  const list = columnNode && columnNode.querySelector('.task-list');
  const header = columnNode && columnNode.querySelector('.column-header');
  const countNode = header && header.querySelector('.column-count');
  if (!root || !column || !board || board.dataset.boardId !== state.activeBoardId ||
      !list || !header || !countNode) {
    renderBoard();
    return;
  }

  const cards = [...list.children].filter(el => el.classList.contains('task-card'));
  if (task.parentId) {
    // Children are displayed inside the top-level task's editor, not as cards.
    // Only its footer (number of descendants) needs to change.
    const oldCard = cards.find(el => el.dataset.taskId === root.id);
    if (!oldCard || cards.length !== list.children.length) {
      renderBoard();
      return;
    }
    const focusWasInside = oldCard.contains(document.activeElement);
    const newCard = createTaskCard(root, column);
    oldCard.replaceWith(newCard);
    if (focusWasInside) newCard.focus({ preventScroll: true });
  } else {
    const visibleIds = sortTasks(getVisibleTasks().filter(t => t.columnId === column.id))
      .map(t => t.id);
    const oldIds = cards.map(el => el.dataset.taskId);
    if (removed) {
      const oldCard = cards.find(el => el.dataset.taskId === task.id);
      const remainingIds = oldIds.filter(id => id !== task.id);
      if (!oldCard || oldIds.length !== visibleIds.length + 1 ||
          remainingIds.some((id, i) => id !== visibleIds[i]) ||
          cards.length !== list.children.length) {
        renderBoard();
        return;
      }
      const focusWasInside = oldCard.contains(document.activeElement);
      oldCard.remove();
      if (!visibleIds.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-hint';
        empty.textContent = 'Нет задач';
        list.appendChild(empty);
      } else if (focusWasInside) {
        const nextCard = [...list.children].find(el => el.classList.contains('task-card'));
        if (nextCard) nextCard.focus({ preventScroll: true });
      }
    } else {
      const at = visibleIds.indexOf(task.id);
      const expectedOld = visibleIds.filter(id => id !== task.id);
      if (at < 0 || oldIds.length !== expectedOld.length ||
          oldIds.some((id, i) => id !== expectedOld[i]) ||
          (cards.length ? cards.length !== list.children.length :
            list.children.length !== 1 || !list.children[0].classList.contains('empty-hint'))) {
        renderBoard();
        return;
      }
      const newCard = createTaskCard(task, column);
      if (!cards.length) list.replaceChildren(newCard);
      else list.insertBefore(newCard, cards[at] || null);
    }
  }

  const total = state.tasks.filter(t => t.columnId === column.id && !t.parentId).length;
  const limit = column.wipLimit || 0;
  header.classList.toggle('wip-exceeded', !!limit && total > limit);
  header.classList.toggle('wip-warning', !!limit && total === limit);
  countNode.textContent = String(total) + (limit ? '/' + limit : '');
  updateTagFilter();
  updateStorageInfo();
}

// P16.3: reconcile only columns touched by a move or cancelled drag.
// Existing unrelated cards retain their DOM nodes, media players and scroll state.
function renderMovedTaskColumns(columnIds, refreshTaskIds = []) {
  const ids = [...new Set(columnIds.filter(Boolean))];
  const board = $('#board');
  if (!ids.length || !board || board.dataset.boardId !== state.activeBoardId ||
      currentView !== 'kanban' || searchQuery.trim() ||
      filterTag || filterPriority || filterDeadline) {
    renderBoard();
    return;
  }
  const visible = getVisibleTasks();
  const columns = [];
  const currentCards = new Map();
  for (const id of ids) {
    const column = state.columns.find(col => col.id === id);
    const node = [...board.children].find(el => el.dataset.columnId === id);
    const list = node && node.querySelector('.task-list');
    const header = node && node.querySelector('.column-header');
    const count = header && header.querySelector('.column-count');
    if (!column || !list || !header || !count) { renderBoard(); return; }
    const ordered = sortTasks(visible.filter(t => t.columnId === id));
    for (const element of [...list.children]) {
      if (element.classList.contains('empty-hint')) continue;
      if (!element.classList.contains('task-card') ||
          currentCards.has(element.dataset.taskId)) { renderBoard(); return; }
      currentCards.set(element.dataset.taskId, element);
    }
    columns.push({ column, list, header, count, ordered, scroll: list.scrollTop });
  }
  // A drag can put a card in another list before it reaches IndexedDB.
  // Require a complete, unique set across the touched columns.
  const expected = columns.flatMap(entry => entry.ordered.map(task => task.id));
  if (expected.length !== currentCards.size ||
      expected.some(id => !currentCards.has(id))) { renderBoard(); return; }

  const focusedId = [...currentCards.entries()].find(([, el]) =>
    el === document.activeElement || el.contains(document.activeElement))?.[0];
  const refresh = new Set(refreshTaskIds);
  const replacements = new Map();
  for (const entry of columns) {
    for (const task of entry.ordered) {
      if (refresh.has(task.id)) {
        const old = currentCards.get(task.id);
        const replacement = createTaskCard(task, entry.column);
        old.replaceWith(replacement);
        replacements.set(task.id, replacement);
      }
    }
  }
  for (const entry of columns) {
    const { list, ordered, column, header, count } = entry;
    list.classList.remove('drag-over');
    for (const hint of [...list.children]) {
      if (hint.classList.contains('empty-hint')) hint.remove();
    }
    let anchor = null;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const task = ordered[i];
      const card = replacements.get(task.id) || currentCards.get(task.id);
      if (card.parentElement !== list || card.nextElementSibling !== anchor)
        list.insertBefore(card, anchor);
      anchor = card;
    }
    const total = state.tasks.filter(t => t.columnId === column.id && !t.parentId).length;
    if (!ordered.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = total ? 'Ничего не найдено' : 'Нет задач';
      list.appendChild(hint);
    }
    const limit = column.wipLimit || 0;
    header.classList.toggle('wip-exceeded', !!limit && total > limit);
    header.classList.toggle('wip-warning', !!limit && total === limit);
    count.textContent = String(total) + (limit ? '/' + limit : '');
  }
  for (const entry of columns) entry.list.scrollTop = entry.scroll;
  if (focusedId && replacements.has(focusedId))
    replacements.get(focusedId).focus({ preventScroll: true });
  updateTagFilter();
  updateStorageInfo();
}

function createTaskCard(task, column, descendantCounts) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.dataset.taskId = task.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', task.title);
  card.style.setProperty('--status-color', column.color);

  const descHtml = task.desc ? `<div class="task-description">${escapeHtml(truncate(task.desc, 120))}</div>` : '';
  let mediaHtml = '';
  const imgF = task.files.find(f => f.type.startsWith('image/'));
  if (imgF) {
    const cached = thumbCache.get(imgF.id);
    mediaHtml = cached ? `<img class="task-media-thumb" data-media="1" alt="" src="${escapeHtml(cached)}">`
      : `<div class="task-media-thumb" data-media="1" data-thumb-for="${escapeHtml(imgF.id)}"></div>`;
  }
  const kidsN = descendantCounts ? (descendantCounts.get(task.id) || 0) : subtree(task.id).length;
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
  // Title first: show what the task is before its priority and deadline.
  // Full-height cards scroll within the column instead of clipping content.
  const priority = Object.prototype.hasOwnProperty.call(PRIORITY_LABELS, task.priority)
    ? task.priority : 'none';
  const priorityLabel = priority === 'none' ? 'Без приоритета' : PRIORITY_LABELS[priority];
  const prioritySymbol = {high:'●', medium:'●', low:'●', none:'○'}[priority];
  const priorityHtml = `<span class="task-priority p-${escapeHtml(priority)}" title="Приоритет: ${escapeHtml(priorityLabel)}" aria-label="Приоритет: ${escapeHtml(priorityLabel)}">${prioritySymbol} ${escapeHtml(priorityLabel)}</span>`;
  card.setAttribute('aria-label', `${task.title}. Приоритет: ${priorityLabel}`);

  card.innerHTML = `
    <div class="task-title">${escapeHtml(task.title)}</div>
    <div class="task-card-meta">${priorityHtml}${deadlineHtml}</div>
    ${descHtml}${mediaHtml}${task.files.some(isAudio) ? '<div class="task-audio"></div>' : ''}${tagsHtml}${checklistHtml}
    <div class="task-footer">
      ${task.files.length ? `<span class="task-footer-item" title="Файлы">📎 ${task.files.length}</span>` : ''}${kidsN ? `<span class="task-footer-item" title="Вложенные узлы">⑂ ${kidsN}</span>` : ''}
      <button type="button" class="task-drag-handle" data-drag-handle="1" title="Переместить задачу: тяните за значок (только в режиме «Мой порядок»)" aria-label="Перетащить задачу; стрелки влево и вправо для перемещения">⠿</button>
      <button type="button" class="task-result-button" data-task-results="1" aria-label="Открыть результаты задачи">${task.results?.length ? 'Результаты: ' + task.results.length : '+ Результат'}</button>
      <span class="task-id">#${escapeHtml(task.id.slice(-4))}</span>
    </div>
    <div class="task-quick-actions">
      <button class="task-quick-btn" data-move-next="1" title="В следующую колонку" aria-label="В следующую колонку">→</button>
      <button class="task-quick-btn" data-move-done="1" title="Отметить выполненной" aria-label="Отметить выполненной">✓</button>
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
  const resultButton = card.querySelector('[data-task-results]');
  if (resultButton) resultButton.onclick = e => {
    e.stopPropagation();
    openTaskModal(task.id, null, { results: true });
  };
  const dragHandle = card.querySelector('[data-drag-handle]');
  if (dragHandle) {
    dragHandle.onclick = e => e.stopPropagation();
    dragHandle.onkeydown = e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); e.stopPropagation();
      moveCardToAdjacentColumn(task.id, e.key === 'ArrowLeft' ? -1 : 1);
    };
  }
  card.querySelector('[data-delete]').onclick = (e) => { e.stopPropagation(); deleteTask(task.id); };
  card.querySelector('[data-move-next]').onclick = (e) => { e.stopPropagation(); moveCardToAdjacentColumn(task.id, +1); };
  card.querySelector('[data-move-done]').onclick = (e) => { e.stopPropagation(); markTaskDone(task.id); };
  card.querySelectorAll('[data-media]').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(task); });
  });
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-delete], [data-media], [data-move-next], [data-move-done], [data-drag-handle], [data-task-results], .ap')) return;
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
  try { await dbPutTask(candidate); }
  catch (e) { showToast('Не удалось переместить: ' + e.message); return; }
  const stateIdx = state.tasks.findIndex(t => t.id === taskId);
  if (stateIdx !== -1) state.tasks[stateIdx] = candidate;
  await syncKids(candidate).catch(() => {});
  notifyOtherTabs();
  renderMovedTaskColumns([task.columnId, targetCol.id], [task.id]);
  offerTaskResult(task.id, task.columnId);
}
async function markTaskDone(taskId) {
  const doneCol = state.columns.find(c => c.isDone);
  if (!doneCol) { showToast('Нет колонки «Готово»'); return; }
  const idx = state.tasks.findIndex(t => t.id === taskId);
  if (idx === -1 || state.tasks[idx].columnId === doneCol.id) return;
  const taskColumnId = state.tasks[idx].columnId;
  const candidate = applyColumnChange(state.tasks[idx], doneCol.id);
  candidate.order = topOrder(doneCol.id);
  try { await dbPutTask(candidate); }
  catch (e) { showToast('Не удалось переместить: ' + e.message); return; }
  state.tasks[idx] = candidate;
  await syncKids(candidate).catch(() => {});
  notifyOtherTabs();
  renderMovedTaskColumns([taskColumnId, doneCol.id], [taskId]);
  offerTaskResult(taskId, taskColumnId);
}
function offerTaskResult(taskId, oldColumnId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || task.columnId === oldColumnId) return false;
  const completed = !state.columns.find(c => c.id === oldColumnId)?.isDone &&
    state.columns.find(c => c.id === task.columnId)?.isDone;
  try { globalThis.KanbanHaptics?.postMessage(completed ? 'done' : 'move'); } catch (_) {}
  if (!completed) return true;
  const boardId = state.activeBoardId;
  showToast('Задача выполнена. Записать результат?', 'Результат', () => {
    if (state.activeBoardId !== boardId || $('#taskModal').classList.contains('open') || drag || savingTask || importInProgress) return;
    if (state.tasks.some(t => t.id === taskId)) openTaskModal(taskId, null, { results: true });
  }, 6500);
  return true;
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
  const wOf = d => d === 0 ? 200 : d === 1 ? 220 : 250;
  const xOf = d => { let x = 0; for (let i = 0; i < d; i++) x += wOf(i) + XG; return x; };
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
    nodes[key] = { key, d, item, x: xOf(d), w: wOf(d), cy, color: c,
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
    h += `<g class="mm-node ${cls}${mm.sel === n.key ? ' sel' : ''}${nf ? ' has-files' : ''}" data-key="${escapeHtml(n.key)}" style="--status-color:${escapeHtml(n.color || 'var(--text)')}"><rect x="${n.x}" y="${n.cy - NH / 2}" width="${n.w}" height="${NH}" rx="8"/><text x="${n.x + 12}" y="${n.cy}" dominant-baseline="middle">${escapeHtml(truncate(label, nf ? 22 : 28))}</text>${nf ? `<g class="mm-badge" data-files="${escapeHtml(t.id)}"><rect x="${n.x + n.w - 48}" y="${n.cy - 11}" width="42" height="22" rx="11"/><text x="${n.x + n.w - 27}" y="${n.cy}" text-anchor="middle" dominant-baseline="middle">📎${nf}</text></g>` : ''}${toggle}</g>`;
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
    const put = list => list.forEach(m => { const i = state.tasks.findIndex(x => x.id === m.id); if (i > -1) state.tasks[i] = m; });
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
    tab.tabIndex = active ? 0 : -1;
  });
  $('#kanbanToolbar').style.display = view === 'kanban' ? '' : 'none';
  $('#board').hidden = view !== 'kanban';
  $('#dashboard').hidden = view !== 'dashboard';
  $('#mindmap').hidden = view !== 'mindmap';
  $('#calendar').hidden = view !== 'calendar';
  if (view === 'dashboard') renderDashboard();
  else if (view === 'mindmap') renderMindmap();
  else if (view === 'calendar') renderCalendar();
  saveUIState();
}

// ============================================================
// TASK OPS
// ============================================================
async function deleteTask(taskId) {
  const root = state.tasks.find(t => t.id === taskId);
  if (!root) return;
  const rootBeforeRemoval = root.parentId ? taskRootForCollection(root) : null;
  const gone = [root, ...subtree(taskId)], ids = new Set(gone.map(t => t.id));
  try { await dbDeleteTasks([...ids]); }
  catch (e) { showToast('Не удалось удалить: ' + e.message); return; }
  const kept = state.tasks.filter(t => !ids.has(t.id));
  state.tasks.length = 0; state.tasks.push(...kept);
  const files = gone.flatMap(t => t.files);
  const undoId = pushUndo({
    onExpire: () => files.forEach(f => scheduleMediaDelete(f.id, 0)),
    restore: async () => {
      if (root.boardId && root.boardId !== state.activeBoardId) await switchBoard(root.boardId);
      files.forEach(f => cancelMediaDelete(f.id));
      try { await dbPutTasks(gone); }
      catch (e) { showToast('Не удалось восстановить: ' + e.message); return false; }
      (state._tasksByBoard[root.boardId] || state.tasks).push(...gone);
      notifyOtherTabs(); renderTaskCollectionChange(root, false);
      return true;
    }
  });
  notifyOtherTabs(); renderTaskCollectionChange(root, true, rootBeforeRemoval);
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
    deadline: $('#taskDeadline').value, priority: editingPriority, checklist: tempChecklist,
    results: tempResults,
    parent: $('#taskParent').value, files: tempFiles.map(f => [f.id, f.name, f.resultId || '']), nf: newFiles.map(f => [f._name || f.name, f.size, f._resultId || '']),
    reminder: globalThis.KanbanTaskReminders && $('#taskReminderEnabled').checked ? $('#taskReminderTime').value : ''
  });
}
function openTaskModal(taskId = null, columnId = null, opts = {}) {
  if (importInProgress) { showToast('Дождитесь завершения импорта'); return; }
  lastFocusBeforeModal = document.activeElement;
  editingTaskId = taskId;
  editingPriority = 'none';
  tempChecklist = [];
  tempResults = [];
  tempFiles = []; newFiles = [];

  const modal = $('#taskModal');
  const titleEl = $('#taskTitle');
  const descEl = $('#taskDesc');
  const deadlineEl = $('#taskDeadline');
  const tagsEl = $('#taskTags');
  const colIdEl = $('#taskColumnId');
  const fileInput = $('#taskFile');
  const deleteBtn = $('#deleteTaskBtn');
  let reminder = '';

  titleEl.value = ''; descEl.value = ''; deadlineEl.value = ''; tagsEl.value = '';
  fileInput.value = '';
  $('#taskTitleError').hidden = true; $('#taskDeadlineError').hidden = true;
  setPriorityChips('none'); renderChecklistUI();

  if (taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    $('#taskModalTitle').textContent = 'Редактирование задачи';
    titleEl.value = task.title; descEl.value = task.desc || '';
    deadlineEl.value = task.deadline || ''; tagsEl.value = task.tags.join(', ');
    colIdEl.value = task.columnId; setPriorityChips(task.priority);
    tempChecklist = task.checklist.map(c => ({ ...c })); renderChecklistUI();
    tempFiles = task.files.map(f => ({ ...f }));
    tempResults = (task.results || []).map(r => ({ ...r }));
    reminder = task.reminderTime || '';
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

  if (globalThis.KanbanTaskReminders) {
    const enabled = $('#taskReminderEnabled'), time = $('#taskReminderTime');
    $('#taskReminderField').hidden = false;
    enabled.checked = !!reminder;
    time.value = reminder || '09:00';
    enabled.onchange = () => { time.hidden = !enabled.checked; };
    enabled.onchange();
  }

  renderTaskResults();
  renderFiles();
  $('#addTaskResultBtn').onclick = addTaskResult;
  modalInitialSnapshot = captureModalSnapshot();
  modal.classList.add('open');
  setTimeout(() => {
    if (opts.results) {
      $('#taskResultsField').scrollIntoView({ block: 'start' });
      $('#addTaskResultBtn').focus({ preventScroll: true });
    } else titleEl.focus();
  }, 50);
  trapFocus(modal);
}
function renderTaskResults() {
  const container = $('#taskResultsList');
  container.replaceChildren();
  if (!tempResults.length) {
    const hint = document.createElement('div');
    hint.className = 'result-hint';
    hint.textContent = 'Пока нет результатов. Добавляйте их на любом этапе задачи.';
    container.appendChild(hint);
    return;
  }
  for (const [index, entry] of tempResults.entries()) {
    const row = document.createElement('div');
    row.className = 'task-result-row';
    row.dataset.resultId = entry.id;
    const header = document.createElement('div');
    header.className = 'task-result-header';
    const date = document.createElement('span');
    date.textContent = new Date(entry.createdAt).toLocaleString('ru-RU');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-secondary btn-small';
    remove.textContent = 'Удалить';
    remove.setAttribute('aria-label', 'Удалить результат ' + (index + 1));
    remove.onclick = () => {
      if (savingTask || rec.id) return;
      tempResults.splice(index, 1);
      tempFiles = tempFiles.filter(f => f.resultId !== entry.id);
      newFiles = newFiles.filter(f => f._resultId !== entry.id);
      renderTaskResults();
      renderFiles();
      $('#addTaskResultBtn').focus();
    };
    header.append(date, remove);
    const text = document.createElement('textarea');
    text.setAttribute('aria-label', 'Результат ' + (index + 1));
    text.placeholder = 'Что сделано? Какие получены результаты?';
    text.maxLength = Math.max(10000, entry.text.length);
    text.value = entry.text;
    text.oninput = () => {
      entry.text = text.value;
      entry.updatedAt = Date.now();
    };
    const media = document.createElement('div');
    media.className = 'result-file-list';
    const audio = document.createElement('div');
    audio.className = 'audio-list result-audio-list';
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.hidden = true;
    picker.onchange = () => {
      const selected = Array.from(picker.files || []);
      picker.value = '';
      if (!tempResults.includes(entry) || savingTask) return;
      for (const file of selected) file._resultId = entry.id;
      stageSelectedFiles(selected);
    };
    const attach = document.createElement('button');
    attach.type = 'button'; attach.className = 'btn btn-secondary btn-small';
    attach.textContent = '+ Файл / фото';
    attach.onclick = () => { if (!savingTask) picker.click(); };
    const voice = document.createElement('button');
    voice.type = 'button'; voice.className = 'btn btn-secondary btn-small';
    voice.textContent = 'Записать голосом';
    voice.onclick = () => { if (!savingTask) void recStart(entry.id); };
    const controls = document.createElement('div');
    controls.className = 'result-controls';
    controls.append(attach, voice);
    row.append(header, text, media, audio, picker, controls);
    container.appendChild(row);
  }
}
function addTaskResult() {
  if (savingTask || rec.id) return;
  const now = Date.now();
  tempResults.push({ id: 'result_' + generateId(), text: '', createdAt: now, updatedAt: now });
  renderTaskResults();
  renderFiles();
  $('#taskResultsList').lastElementChild.querySelector('textarea').focus();
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
  const resultBoxes = new Map();
  for (const row of $('#taskResultsList').children) {
    const target = row.querySelector('.result-file-list');
    if (target) { target.replaceChildren(); resultBoxes.set(row.dataset.resultId, target); }
  }
  const all = [...tempFiles.map(f => ({ f, old: true })), ...newFiles.map(f => ({ f, old: false }))].filter(it => !isAudio(it.f));
  all.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'media-file-row';
    const filename = escapeHtml(it.f.name);
    row.innerHTML = `<span class="media-file-name">📎 ${filename}${it.f.size ? ' · ' + fmtSize(it.f.size) : ''}${it.old ? '' : ' (новый)'}</span><div class="media-file-actions">${it.old ? '<button type="button" class="media-remove" data-open="1">Открыть</button><button type="button" class="media-remove" data-edit="1">Изменить</button>' : ''}<button type="button" class="media-remove" data-rm="1" aria-label="Убрать файл ${filename}">×</button></div>`;
    row.querySelector('[data-rm]').onclick = () => { if (it.old) tempFiles = tempFiles.filter(x => x !== it.f); else newFiles = newFiles.filter(x => x !== it.f); renderFiles(); };
    const op = row.querySelector('[data-open]');
    if (op) op.onclick = () => openFile(it.f, $('#taskTitle').value);
    const edit = row.querySelector('[data-edit]');
    if (edit) edit.onclick = () => editAttachmentExternally(it.f);
    (resultBoxes.get(it.old ? it.f.resultId : it.f._resultId) || box).appendChild(row);
  });
  renderAudioList();
}
async function storeFile(file) {
  let blob = file, thumb = null, type = file.type || 'application/octet-stream';
  const processablePhoto = /^image\/(jpeg|png|webp|heic|heif)$/.test(type);
  const nativePhoto = processablePhoto && globalThis.KanbanMedia?.postMessage && globalThis.crypto?.randomUUID;
  if (nativePhoto) {
    try { ({ blob, thumb } = await processNativePhoto(file)); type = blob.type; } catch (_) {}
  } else {
    if (processablePhoto) {
      try { blob = await compressImage(file, IMG_MAX_DIM, IMG_QUALITY); type = blob.type; } catch (_) {}
    }
    if (type.startsWith('image/')) { try { thumb = await generateThumb(blob, IMG_THUMB_DIM, 0.78); } catch (_) {} }
  }
  // Decode audio before storing: a decoder error must not create orphaned media.
  const meta = type.startsWith('audio/') ? await prepAudio(file) : null;
  const id = 'm_' + generateId();
  await mediaPut(id, blob, thumb, type);
  const originalName = file._name || file.name || 'Файл';
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' }[type];
  const name = type !== file.type && extension && !(type === 'image/jpeg' && /\.jpe?g$/i.test(originalName)) &&
    !originalName.toLowerCase().endsWith('.' + extension)
    ? originalName.replace(/\.[^./]+$/, '') + '.' + extension : originalName;
  return { id, name, type, size: blob.size, ...(file._resultId ? { resultId: file._resultId } : {}), ...(meta && meta.dur ? { dur: meta.dur } : {}), ...(meta && meta.peaks ? { peaks: meta.peaks } : {}) };
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
    showToast('Изменения файла сохранены в Comrade');
  } catch (error) {
    showToast('Не удалось обновить вложение: ' + error.message);
  }
};
// Only 32 KiB of a saved attachment crosses the Android WebView bridge at a
// time. Android grants read-only access to the chosen external viewer.
let activeFileOpen = null;
function fileOpenPost(event) {
  window.KanbanFileOpen.postMessage(JSON.stringify(event));
}
function fileOpenFail(transfer, reason, abort = false) {
  if (activeFileOpen !== transfer) return;
  activeFileOpen = null;
  clearTimeout(transfer.timer);
  if (abort) { try { fileOpenPost({type:'abort',id:transfer.id}); } catch (_) {} }
  transfer.reject(reason instanceof Error ? reason : new Error(String(reason)));
}
function fileOpenTimeout(transfer) {
  clearTimeout(transfer.timer);
  transfer.timer = setTimeout(() =>
    fileOpenFail(transfer, new Error('Android не ответил при открытии файла'), true), 15000);
}
async function fileOpenNextChunk(transfer) {
  if (activeFileOpen !== transfer) return;
  try {
    if (transfer.offset >= transfer.blob.size) {
      fileOpenPost({type:'finish',id:transfer.id});
      fileOpenTimeout(transfer);
      return;
    }
    const bytes = new Uint8Array(await transfer.blob.slice(
      transfer.offset, transfer.offset + 32 * 1024).arrayBuffer());
    if (activeFileOpen !== transfer) return;
    transfer.pending = bytes.length;
    fileOpenPost({type:'chunk',id:transfer.id,index:transfer.index,
      data:btoa(String.fromCharCode(...bytes))});
    fileOpenTimeout(transfer);
  } catch (error) { fileOpenFail(transfer, error, true); }
}
window.kanbanFileOpenNativeResult = raw => {
  let event;
  try { event = JSON.parse(raw); } catch (_) { return; }
  const transfer = activeFileOpen;
  if (!transfer || event.id !== transfer.id) return;
  if (event.type === 'ready') void fileOpenNextChunk(transfer);
  else if (event.type === 'ack') {
    if (event.index !== transfer.index + 1 || transfer.pending <= 0) {
      fileOpenFail(transfer, new Error('Сбой передачи вложения'), true);
      return;
    }
    transfer.offset += transfer.pending;
    transfer.pending = 0; transfer.index++;
    void fileOpenNextChunk(transfer);
  } else if (event.type === 'opened') {
    clearTimeout(transfer.timer);
    activeFileOpen = null;
    transfer.resolve();
  } else if (event.type === 'error' || event.type === 'cancelled') {
    fileOpenFail(transfer, new Error(event.message || 'Не удалось открыть файл'));
  }
};
function openFileViaAndroid(blob, file) {
  if (activeFileOpen) return Promise.reject(new Error('Другой файл ещё открывается'));
  if (blob.size > MAX_VIDEO_SIZE) return Promise.reject(new Error('Файл превышает 50 МБ'));
  return new Promise((resolve, reject) => {
    const id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    const transfer = {id,blob,offset:0,index:0,pending:0,timer:null,resolve,reject};
    activeFileOpen = transfer;
    fileOpenTimeout(transfer);
    try {
      fileOpenPost({type:'start',id,name:file.name || 'file',
        mime:file.type || 'application/octet-stream',size:blob.size});
    } catch (error) { fileOpenFail(transfer,error); }
  });
}
async function openFile(f, title) {
  if (/^(image|video)\//.test(f.type)) {
    const galleryFiles = tempFiles.some(file => file.id === f.id)
      ? tempFiles.filter(file => (file.resultId || '') === (f.resultId || '')) : [f];
    return openLightbox({ title, files: galleryFiles }, f);
  }
  const m = await mediaGet(f.id).catch(() => null);
  if (!m?.full) { showToast('Файл не найден'); return; }
  if (window.KanbanFileOpen?.postMessage) {
    try { await openFileViaAndroid(m.full, f); }
    catch (error) { showToast('Не удалось открыть файл: ' + error.message); }
    return;
  }
  if (location.origin === 'https://appassets.androidplatform.net') {
    showToast('Открытие вложений недоступно в этой версии Android WebView');
    return;
  }
  const url = createTrackedURL(m.full), link = document.createElement('a');
  link.href = url; link.download = f.name; document.body.appendChild(link);
  link.click(); link.remove();
  setTimeout(() => revokeTrackedURL(url), 4000);
}

// ============================================================
// ATOMIC SAVE
// ============================================================
let savingTask = false;
async function saveTaskFromModal() {
  if (savingTask) return;
  if (importInProgress) { showToast('Дождитесь завершения импорта'); return; }
  if (switchingBoard) { showToast('Дождитесь переключения доски'); return; }
  savingTask = true;
  try { await _saveTask(); } finally { savingTask = false; }
}
async function _saveTask() {
  const title = $('#taskTitle').value.trim(), deadline = $('#taskDeadline').value || '';
  $('#taskTitleError').hidden = !!title;
  if (!title) { $('#taskTitle').focus(); return; }
  $('#taskDeadlineError').hidden = isValidISODate(deadline);
  if (!isValidISODate(deadline)) return;

  const pv = $('#taskParent').value, parentId = pv.startsWith('task:') ? pv.slice(5) : '';
  const par = parentId ? state.tasks.find(t => t.id === parentId) : null;
  if (parentId && !par) { showToast('Родитель не найден'); return; }
  const columnId = par ? par.columnId : pv.slice(4);
  const existing = editingTaskId ? state.tasks.find(t => t.id === editingTaskId) : null;
  let reminderTime = existing?.reminderTime || '';
  if (globalThis.KanbanTaskReminders) {
    reminderTime = $('#taskReminderEnabled').checked ? $('#taskReminderTime').value : '';
    if ($('#taskReminderEnabled').checked && (!deadline || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reminderTime))) {
      showToast('Укажите срок и время напоминания');
      return;
    }
  }

  if (rec.starting) { showToast('Дождитесь доступа к микрофону'); return; }
  if (rec.id && !(await recStop())) return;
  const stored = [];
  try { for (const f of newFiles) stored.push(await storeFile(f)); }
  catch (e) {
    await Promise.all(stored.map(x => mediaDelete(x.id).catch(() => {})));
    showToast('Не удалось сохранить файл: ' + (e.message || e)); return;
  }
  const files = [...tempFiles, ...stored];
  const attachedResults = new Set(files.map(f => f.resultId).filter(Boolean));

  const moved = !existing || existing.parentId !== parentId || existing.columnId !== columnId;
  const sib = state.tasks.filter(t => t !== existing && t.parentId === parentId && (parentId || t.columnId === columnId));
  const candidate = {
    id: existing ? existing.id : generateId(), boardId: existing ? existing.boardId : state.activeBoardId,
    columnId, parentId, title, desc: $('#taskDesc').value.trim(),
    tags: $('#taskTags').value.split(',').map(t => t.trim()).filter(Boolean),
    priority: editingPriority, deadline, files,
    ...(reminderTime ? { reminderTime } : {}),
    results: tempResults.filter(r => r.text.trim() || attachedResults.has(r.id)).map(r => ({ ...r, text: r.text.trim() })),
    checklist: tempChecklist.map(c => ({ id: c.id, text: c.text.trim(), checked: !!c.checked })).filter(c => c.text),
    order: !moved ? existing.order : (sib.length ? Math.min(...sib.map(t => t.order ?? 0)) - 1 : 0),
    createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now(),
    completedAt: computeCompletedAt(existing ? existing.columnId : null, columnId, existing ? existing.completedAt : null)
  };
  // Save the task and descendants atomically; never swallow child update failures.
  const descendants = existing
    ? subtree(existing.id).filter(t => t.columnId !== columnId).map(t => applyColumnChange(t, columnId))
    : [];
  try { await dbPutTasks([candidate, ...descendants]); }
  catch (e) {
    await Promise.all(stored.map(x => mediaDelete(x.id).catch(() => {})));
    showToast('Не удалось сохранить: ' + e.message, null, null, 5000); return;
  }

  const idx = existing ? state.tasks.findIndex(t => t.id === candidate.id) : -1;
  if (idx > -1) state.tasks[idx] = candidate; else state.tasks.push(candidate);
  for (const child of descendants) {
    const childIdx = state.tasks.findIndex(t => t.id === child.id);
    if (childIdx !== -1) state.tasks[childIdx] = child;
  }
  if (existing) existing.files.filter(f => !files.some(x => x.id === f.id)).forEach(f => scheduleMediaDelete(f.id));
  closeModal('taskModal'); notifyOtherTabs();
  if (globalThis.KanbanTaskReminders && reminderTime && reminderTime !== existing?.reminderTime) queueTaskReminders(true);
  if (existing && !existing.parentId && !candidate.parentId &&
      existing.columnId !== candidate.columnId)
    renderMovedTaskColumns([existing.columnId, candidate.columnId], [candidate.id]);
  else if (existing) renderSavedTaskCard(existing, candidate);
  else renderTaskCollectionChange(candidate, false);
  if (existing && typeof offerTaskResult === 'function') offerTaskResult(candidate.id, existing.columnId);
}

function isModalDirty() { return modalInitialSnapshot !== null && (!!rec.id || modalInitialSnapshot !== captureModalSnapshot()); }
async function tryCloseTaskModal() {
  if (savingTask) { showToast('Дождитесь сохранения задачи'); return; }
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
  }
}
async function duplicateTask(taskId) {
  const src = state.tasks.find(t => t.id === taskId);
  if (!src) return;
  const sameCol = state.tasks.filter(t => t.columnId === src.columnId);
  const maxOrder = sameCol.reduce((m, t) => Math.max(m, t.order ?? 0), 0);
  const files = [];
  // Only newly generated copies are eligible for rollback, never source media.
  const discardCopies = () => Promise.all(files.map(f => mediaDelete(f.id).catch(() => {})));
  try { for (const f of src.files.filter(f => !f.resultId)) { const m = await mediaGet(f.id); if (!m) continue; const id = 'm_' + generateId(); await mediaPut(id, m.full, m.thumb, m.type); files.push({ ...f, id }); } }
  catch (e) { await discardCopies(); showToast('Не удалось скопировать файлы: ' + e.message); return; }
  const copy = {
    ...src, id: generateId(), title: src.title + ' (копия)',
    tags: [...src.tags], checklist: src.checklist.map(c => ({ id: 'cl_' + generateId(), text: c.text, checked: c.checked })),
    files, results: [], completedAt: null,
    order: maxOrder + 1, createdAt: Date.now(), updatedAt: Date.now(),
    boardId: src.boardId || state.activeBoardId
  };
  delete copy.reminderTime;
  try { await dbPutTask(copy); }
  catch (e) { await discardCopies(); showToast('Не удалось дублировать: ' + e.message); return; }
  state.tasks.push(copy);
  closeModal('taskModal'); notifyOtherTabs(); renderTaskCollectionChange(copy, false);
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
async function processNativePhoto(file) {
  const id = crypto.randomUUID();
  try {
    const info = await stageNativeMedia(id, file, () => true, { operation: 'photo' });
    const formats = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (!formats.includes(info.originalMime) || !['image/jpeg', 'image/webp'].includes(info.mime) ||
        !Number.isSafeInteger(info.thumbSize) || info.thumbSize <= 0 || info.thumbSize > 1024 * 1024 ||
        !Number.isSafeInteger(info.fullSize) || info.fullSize < 0 || info.fullSize >= file.size) {
      throw new Error('Некорректный результат обработки фото');
    }
    const read = async (kind, size) => {
      const response = await fetch('/native-media/' + id + '/' + kind, { cache: 'no-store' });
      if (!response.ok) throw new Error('Файл фото недоступен');
      const blob = await response.blob();
      if (blob.size !== size || blob.type !== info.mime) throw new Error('Фото передано не полностью');
      return blob;
    };
    const preview = await read('thumb', info.thumbSize);
    const thumb = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Не удалось прочитать миниатюру'));
      reader.readAsDataURL(preview);
    });
    const blob = info.fullSize > 0 ? await read('full', info.fullSize) :
      file.type === info.originalMime ? file : file.slice(0, file.size, info.originalMime);
    return { blob, thumb };
  } finally { mediaDiscard(id); }
}

async function compressImage(file, maxDim, quality) {
  const targetSize = 2 * 1024 * 1024;
  // Retain original small files, including PNG alpha and EXIF metadata.
  if (file.size <= targetSize) return file;
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const picture = new Image();
      picture.onload = () => resolve(picture);
      picture.onerror = () => reject(new Error('Не удалось декодировать изображение'));
      picture.src = url;
    });
  } finally { URL.revokeObjectURL(url); }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas недоступен');
  const outputType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
  const resize = bound => {
    const scale = Math.min(1, bound / img.width, bound / img.height);
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (outputType === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  const encode = q => new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось сжать изображение')), outputType, q);
  });
  resize(maxDim);
  let best = await encode(quality);
  // If WebView cannot encode WebP, never replace a transparent PNG by JPEG.
  if (best.type !== outputType) return file;
  if (best.size > targetSize) {
    const lower = await encode(Math.min(quality, 0.68));
    if (lower.type === outputType && lower.size < best.size) best = lower;
  }
  if (best.size > targetSize && Math.max(canvas.width, canvas.height) > 1200) {
    resize(Math.min(maxDim, 1200));
    const smaller = await encode(0.72);
    if (smaller.type === outputType && smaller.size < best.size) best = smaller;
  }
  // Compression is optional, never grow the stored blob.
  return best.size < file.size ? best : file;
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
const lightboxGallery = {
  files: [], title: '', index: 0, zoom: 1, panX: 0, panY: 0,
  pointers: new Map(), gesture: null
};
let nativeGallery = null;

async function fallbackGallery(gallery, index) {
  if (nativeGallery !== gallery) return;
  clearTimeout(gallery.timer);
  if (gallery.request) mediaDiscard(gallery.request);
  nativeGallery = null;
  try { globalThis.KanbanGallery.postMessage(JSON.stringify({ id: gallery.id, type: 'close' })); } catch (_) {}
  lightboxGallery.index = index;
  await showLightboxItem();
}

globalThis.kanbanGalleryResult = async raw => {
  let event;
  try { event = JSON.parse(raw); } catch (_) { return; }
  const gallery = nativeGallery;
  if (!gallery || gallery.id !== event.id) return;
  clearTimeout(gallery.timer);
  if (event.type === 'closed') {
    if (gallery.request) mediaDiscard(gallery.request);
    nativeGallery = null;
    return;
  }
  const file = gallery.files[event.index];
  if (!Number.isInteger(event.index) || !file) return;
  if (event.type === 'fallback') { await fallbackGallery(gallery, event.index); return; }
  if (event.type === 'external') {
    try {
      const blob = (await mediaGet(file.id))?.full;
      if (!blob) throw new Error('Файл не найден');
      if (nativeGallery === gallery) await openFileViaAndroid(blob, file);
    } catch (error) { showToast('Не удалось открыть файл: ' + error.message); }
    return;
  }
  if (event.type !== 'request' || typeof event.request !== 'string') return;
  if (gallery.request) mediaDiscard(gallery.request);
  const request = gallery.request = event.request;
  const current = () => nativeGallery === gallery && gallery.request === request;
  try {
    const blob = (await mediaGet(file.id))?.full;
    if (!current()) return;
    if (!blob) throw new Error('Файл не найден');
    await stageNativeMedia(request, blob, current, {
      operation: file.type.startsWith('video/') ? 'gallery-video' : 'gallery-image'
    });
  } catch (_) { if (current()) await fallbackGallery(gallery, event.index); }
};

async function openLightbox(task, selected) {
  const files = (task.files || []).filter(f => /^(image|video)\//.test(f.type));
  const file = selected || files[0];
  if (!file) return;
  lightboxGallery.files = files.some(f => f.id === file.id) ? files : [file];
  lightboxGallery.index = Math.max(0, lightboxGallery.files.findIndex(f => f.id === file.id));
  lightboxGallery.title = task.title || '';
  const bridge = globalThis.KanbanGallery;
  if (bridge?.postMessage && lightboxGallery.files.length <= 5000) {
    apStop();
    const id = generateId(), index = lightboxGallery.index;
    const gallery = { id, files: lightboxGallery.files, request: null };
    nativeGallery = gallery;
    gallery.timer = setTimeout(() => void fallbackGallery(gallery, index), 3000);
    try {
      bridge.postMessage(JSON.stringify({ id, type: 'open', index, size: gallery.files.length,
        title: lightboxGallery.title.slice(0, 200) }));
      return;
    } catch (_) { await fallbackGallery(gallery, index); return; }
  }
  await showLightboxItem();
}

async function showLightboxItem() {
  const token = ++lightboxToken;
  const lightbox = $('#lightbox'), content = $('#lightboxContent');
  const oldUrl = lightbox.dataset.url;
  if (oldUrl) { revokeTrackedURL(oldUrl); delete lightbox.dataset.url; }
  lightboxGallery.zoom = 1; lightboxGallery.panX = 0; lightboxGallery.panY = 0;
  lightboxGallery.pointers.clear(); lightboxGallery.gesture = null;
  const file = lightboxGallery.files[lightboxGallery.index];
  const image = /^image\//.test(file.type);
  $('#lightboxPosition').textContent = `${lightboxGallery.index + 1} / ${lightboxGallery.files.length}`;
  $('#lightboxPrev').disabled = lightboxGallery.index === 0;
  $('#lightboxNext').disabled = lightboxGallery.index === lightboxGallery.files.length - 1;
  $('#lightboxZoomIn').hidden = !image;
  $('#lightboxZoomOut').hidden = !image;
  $('#lightboxZoomIn').disabled = !image;
  $('#lightboxZoomOut').disabled = true;
  content.textContent = 'Загрузка…';
  lightbox.classList.add('open');
  try {
    const media = await mediaGet(file.id);
    if (token !== lightboxToken) return;
    if (!media?.full) throw new Error('Файл недоступен');
    const url = createTrackedURL(media.full);
    const el = document.createElement(image ? 'img' : 'video');
    if (image) { el.alt = lightboxGallery.title; el.draggable = false; }
    else { el.controls = true; el.autoplay = true; }
    el.src = url;
    content.textContent = '';
    content.appendChild(el);
    lightbox.dataset.url = url;
  } catch (_) {
    if (token === lightboxToken) content.textContent = 'Не удалось открыть файл';
  }
}

function changeLightboxItem(direction) {
  const next = lightboxGallery.index + direction;
  if (next < 0 || next >= lightboxGallery.files.length) return;
  lightboxGallery.index = next;
  void showLightboxItem();
}

function updateLightboxZoom(next) {
  const img = $('#lightboxContent').querySelector('img');
  if (!img) return;
  lightboxGallery.zoom = Math.max(1, Math.min(5, next));
  if (lightboxGallery.zoom === 1) lightboxGallery.panX = lightboxGallery.panY = 0;
  const limitX = img.clientWidth * (lightboxGallery.zoom - 1) / 2;
  const limitY = img.clientHeight * (lightboxGallery.zoom - 1) / 2;
  lightboxGallery.panX = Math.max(-limitX, Math.min(limitX, lightboxGallery.panX));
  lightboxGallery.panY = Math.max(-limitY, Math.min(limitY, lightboxGallery.panY));
  img.style.transform = `translate(${lightboxGallery.panX}px, ${lightboxGallery.panY}px) scale(${lightboxGallery.zoom})`;
  $('#lightboxZoomOut').disabled = lightboxGallery.zoom <= 1;
  $('#lightboxZoomIn').disabled = lightboxGallery.zoom >= 5;
}

function lightboxPointerDown(e) {
  if (!$('#lightbox').classList.contains('open') ||
      e.target.closest('button, video') || (e.pointerType === 'mouse' && e.button !== 0)) return;
  lightboxGallery.pointers.set(e.pointerId, {x:e.clientX,y:e.clientY});
  $('#lightbox').setPointerCapture?.(e.pointerId);
  const points = [...lightboxGallery.pointers.values()];
  if (points.length === 1) {
    lightboxGallery.gesture = {type:'single', x:e.clientX,y:e.clientY,
      panX:lightboxGallery.panX,panY:lightboxGallery.panY};
  } else if (points.length === 2) {
    lightboxGallery.gesture = {type:'pinch',distance:Math.hypot(
      points[0].x-points[1].x,points[0].y-points[1].y),zoom:lightboxGallery.zoom};
  }
}

function lightboxPointerMove(e) {
  if (!lightboxGallery.pointers.has(e.pointerId)) return;
  lightboxGallery.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  const g = lightboxGallery.gesture, points = [...lightboxGallery.pointers.values()];
  if (g?.type === 'pinch' && points.length === 2) {
    const distance = Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y);
    if (g.distance > 0) updateLightboxZoom(g.zoom * distance / g.distance);
  } else if (g?.type === 'single' && points.length === 1 && lightboxGallery.zoom > 1) {
    lightboxGallery.panX = g.panX + e.clientX - g.x;
    lightboxGallery.panY = g.panY + e.clientY - g.y;
    updateLightboxZoom(lightboxGallery.zoom);
  }
}

function lightboxPointerUp(e) {
  if (!lightboxGallery.pointers.has(e.pointerId)) return;
  const g = lightboxGallery.gesture;
  const swipe = lightboxGallery.pointers.size === 1 && g?.type === 'single' &&
    lightboxGallery.zoom === 1 && Math.abs(e.clientX-g.x) >= 65 &&
    Math.abs(e.clientX-g.x) > Math.abs(e.clientY-g.y) * 1.3;
  lightboxGallery.pointers.delete(e.pointerId);
  if (!lightboxGallery.pointers.size) lightboxGallery.gesture = null;
  else if (lightboxGallery.pointers.size === 1) {
    const point = [...lightboxGallery.pointers.values()][0];
    lightboxGallery.gesture = {type:'single',x:point.x,y:point.y,
      panX:lightboxGallery.panX,panY:lightboxGallery.panY};
  }
  if (swipe) changeLightboxItem(e.clientX < g.x ? 1 : -1);
}

function closeLightbox() {
  ++lightboxToken;
  const lightbox = $('#lightbox');
  const url = lightbox.dataset.url;
  if (url) { revokeTrackedURL(url); delete lightbox.dataset.url; }
  $('#lightboxContent').textContent = '';
  lightbox.classList.remove('open');
  lightboxGallery.files = []; lightboxGallery.pointers.clear();
  lightboxGallery.gesture = null;
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

// ============================================================
// EXPORT JSON (v5 — preserve saved day plan and Japanese web progress)
// ============================================================
const JAPANESE_BACKUP_KEYS = [
  'kanban-japanese-hiragana-v1', 'kanban-japanese-quiz-progress-v1',
  'kanban-japanese-script-v1', 'kanban-japanese-review-v1',
  'kanban-japanese-active-tab-v1'
];
function readJapaneseBackup() {
  const result = {};
  for (const key of JAPANESE_BACKUP_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) result[key] = value;
  }
  return result;
}
function validateJapaneseBackup(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Неверный формат прогресса японского языка');
  const clean = {};
  for (const key of JAPANESE_BACKUP_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    if (typeof raw[key] !== 'string' || raw[key].length > 100000)
      throw new Error('Некорректные данные японского языка: ' + key);
    clean[key] = raw[key];
  }
  return clean;
}
function restoreJapaneseBackup(snapshot) {
  if (!snapshot) return;
  const previous = new Map();
  for (const key of Object.keys(snapshot)) previous.set(key, localStorage.getItem(key));
  try {
    for (const [key, value] of Object.entries(snapshot)) localStorage.setItem(key, value);
  } catch (e) {
    for (const [key, value] of previous) {
      try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
      catch (_) {}
    }
    throw e;
  }
}
// Native Android mini-quiz progress is separate from WebView localStorage.
let pendingNativeJapanese = null;
window.comradeJapaneseNativeResult = raw => {
  let event;
  try { event = JSON.parse(raw); } catch (_) { return; }
  const pending = pendingNativeJapanese;
  if (!pending || event.id !== pending.id) return;
  pendingNativeJapanese = null;
  clearTimeout(pending.timer);
  if (event.type === 'error') pending.reject(new Error(event.message || 'Ошибка прогресса японского'));
  else if (event.type === 'read') pending.resolve(validateNativeJapaneseBackup(event.data));
  else if (event.type === 'restored') pending.resolve(true);
  else pending.reject(new Error('Неизвестный ответ Android'));
};
function validateNativeJapaneseBackup(value) {
  if (value == null) return null; // older and browser-only archives
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Неверный нативный прогресс японского');
  const keys = ['question_count','correct_count','current_question','next_question'];
  if (keys.some(k => !Number.isInteger(value[k]) || value[k] < 0 || value[k] > 1000000)
      || value.correct_count > value.question_count
      || value.current_question >= 92 || value.next_question >= 92
      || typeof value.katakana_unlocked !== 'boolean'
      || typeof value.review_queue !== 'string' || value.review_queue.length > 1024)
    throw new Error('Повреждён нативный прогресс японского');
  const queue = value.review_queue === '' ? [] : value.review_queue.split(',');
  if (queue.length > 150 || queue.some(n => !/^(0|[1-9][0-9]*)$/.test(n) || +n >= 92))
    throw new Error('Повреждена очередь повторения японского');
  return Object.fromEntries([...keys,'katakana_unlocked','review_queue'].map(k => [k,value[k]]));
}
function nativeJapaneseCommand(type, data = null) {
  if (!window.KanbanJapaneseProgress?.postMessage) {
    if (location.origin === 'https://appassets.androidplatform.net')
      return Promise.reject(new Error('Резервирование японской мини-викторины недоступно в Android'));
    return Promise.resolve(null); // browser: no native mini-quiz exists
  }
  if (pendingNativeJapanese) return Promise.reject(new Error('Дождитесь завершения операции с японским'));
  return new Promise((resolve, reject) => {
    const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      if (pendingNativeJapanese?.id !== id) return;
      pendingNativeJapanese = null;
      reject(new Error('Android не ответил на запрос прогресса японского'));
    }, 8000);
    pendingNativeJapanese = {id, timer, resolve, reject};
    try { window.KanbanJapaneseProgress.postMessage(JSON.stringify({id,type,data})); }
    catch (error) { clearTimeout(timer); pendingNativeJapanese = null; reject(error); }
  });
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

const ZIP_PROJECTION = 'p19_zip_projection';
const ZIP_IMPORTED = 'p19_zip_imported';
const zipMime = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const zipThumbMime = /^image\/(?:jpeg|png|webp)$/;
const zipId = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const zipObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const zipWebKey = key => JAPANESE_BACKUP_KEYS.includes(key) || key === 'kanban_theme' || key === 'kanban_ui' ||
  key.startsWith('kanban_collapsed_') || key.startsWith('kanban_mindmap_positions_');
const canUseZip = () => !!(globalThis.KanbanMedia?.postMessage && globalThis.crypto?.randomUUID);
let zipActive = false;

let pomoArchivePending = null;
globalThis.kanbanPomoBackupResult = raw => {
  let result;
  try { result = JSON.parse(raw); } catch (_) { return; }
  if (result.id === pomoArchivePending?.id) pomoArchivePending.finish(result);
};
function pomodoroArchive(type, state) {
  return new Promise((resolve, reject) => {
    if (pomoArchivePending || !globalThis.KanbanPomo?.postMessage) { reject(new Error('Android Pomodoro недоступен')); return; }
    const id = generateId();
    const finish = result => {
      clearTimeout(timer);
      pomoArchivePending = null;
      if (result.error) reject(new Error(result.error)); else resolve(result.backup);
    };
    const timer = setTimeout(() => finish({ error: 'Pomodoro не ответил' }), 7000);
    pomoArchivePending = { id, finish };
    try { globalThis.KanbanPomo.postMessage(JSON.stringify({ id, type, state })); }
    catch (error) { finish({ error: error.message }); }
  });
}
function zipStep(id, command, expected, fields = {}, timeout) {
  return mediaStep(id, expected, () => mediaCommand(id, command, fields), timeout);
}
function cancelZip(id) {
  try { mediaCommand(id, 'zip-cancel'); } catch (_) {}
}
async function zipWrite(id, path, blob) {
  await zipStep(id, 'zip-entry', 'entry', { path, size: blob.size });
  await sendMediaChunks(id, blob);
  await zipStep(id, 'zip-entry-end', 'entry-end');
}
async function exportZipData() {
  if (zipActive || importInProgress || savingTask) { showToast('Дождитесь завершения текущей операции'); return; }
  zipActive = true;
  const id = crypto.randomUUID();
  try {
    const settings = await dbGetSettings();
    if (settings[ZIP_PROJECTION]) throw new Error('Дождитесь завершения восстановления');
    const settingsSnapshot = JSON.stringify(settings);
    delete settings[ZIP_PROJECTION];
    const taskSnapshot = JSON.stringify(await dbGetAllTasks());
    const tasks = JSON.parse(taskSnapshot).map(sanitizeTask);
    const boards = settings.boards;
    const activeBoardId = settings.activeBoardId;
    const media = [];
    const web = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (zipWebKey(key)) web[key] = localStorage.getItem(key);
    }
    const nativeJapanese = await nativeJapaneseCommand('read');
    const pomo = await pomodoroArchive('backup-read');
    const name = 'comrade-backup-' + todayISO() + '.zip';
    await zipStep(id, 'zip-export', 'begin', { name });
    const seen = new Set();
    for (const task of tasks) for (const attachment of task.files || []) {
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      const record = await mediaGet(attachment.id);
      if (!record?.full) throw new Error('Вложение отсутствует: ' + attachment.name);
      const base = 'media/' + String(media.length).padStart(6, '0');
      const mime = record.type || record.full.type || 'application/octet-stream';
      const entry = { id: attachment.id, mime, path: base + '.bin', size: record.full.size };
      await zipWrite(id, entry.path, record.full);
      if (typeof record.thumb === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/.test(record.thumb)) {
        const blob = await (await fetch(record.thumb)).blob();
        entry.thumb = { mime: blob.type, path: base + '.thumb', size: blob.size };
        await zipWrite(id, entry.thumb.path, blob);
      }
      media.push(entry);
    }
    if (taskSnapshot !== JSON.stringify(await dbGetAllTasks()) ||
        settingsSnapshot !== JSON.stringify(await dbGetSettings())) {
      throw new Error('Данные изменились во время экспорта. Запустите его ещё раз');
    }
    const snapshot = { version: 1, boards, activeBoardId, tasks, settings, media, web, nativeJapanese, pomo };
    await zipWrite(id, 'state.json', new Blob([JSON.stringify(snapshot)], { type: 'application/json' }));
    const result = await mediaStep(id, ['saved', 'cancelled'], () => mediaCommand(id, 'zip-seal'), 600000);
    if (result.type === 'saved') showToast('ZIP-бэкап сохранён');
  } catch (error) { showToast('Не удалось сохранить ZIP: ' + error.message, null, null, 6000); }
  finally { cancelZip(id); zipActive = false; }
}

function validateZipState(data, entryNames) {
  const requireValid = value => { if (!value) throw new Error('Повреждены метаданные ZIP'); };
  requireValid(zipObject(data) && data.version === 1 && Array.isArray(data.boards) &&
    data.boards.length > 0 && Array.isArray(data.tasks) && Array.isArray(data.media) &&
    zipObject(data.settings) && zipObject(data.web));
  const entries = new Set(entryNames);
  requireValid(entries.size === entryNames.length && entries.delete('state.json'));
  const media = new Map();
  for (const file of data.media) {
    requireValid(zipObject(file) && zipId(file.id) && !media.has(file.id) && zipMime.test(file.mime) &&
      typeof file.path === 'string' && /^media\/[0-9]{6}\.bin$/.test(file.path) && entries.delete(file.path) &&
      Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_VIDEO_SIZE);
    if (file.thumb != null) requireValid(zipObject(file.thumb) &&
      file.thumb.path === file.path.replace(/\.bin$/, '.thumb') && entries.delete(file.thumb.path) &&
      zipThumbMime.test(file.thumb.mime) && Number.isSafeInteger(file.thumb.size) && file.thumb.size > 0 && file.thumb.size <= 1048576);
    media.set(file.id, file);
  }
  requireValid(entries.size === 0);
  const columns = new Map();
  for (const board of data.boards) {
    requireValid(zipObject(board) && zipId(board.id) && !columns.has(board.id) &&
      Array.isArray(board.columns) && board.columns.length > 0);
    const ids = new Set();
    for (const column of board.columns) {
      requireValid(zipObject(column) && zipId(column.id) && !ids.has(column.id));
      ids.add(column.id);
    }
    columns.set(board.id, ids);
  }
  requireValid(columns.has(data.activeBoardId));
  const byId = new Map(), used = new Set();
  const tasks = [];
  for (const raw of data.tasks) {
    requireValid(zipObject(raw) && zipId(raw.id) && !byId.has(raw.id) && columns.get(raw.boardId)?.has(raw.columnId) &&
      typeof raw.parentId === 'string' && Array.isArray(raw.files) && typeof raw.deadline === 'string' &&
      isValidISODate(raw.deadline));
    const results = new Set(), checklist = new Set();
    for (const result of raw.results || []) {
      requireValid(zipObject(result) && zipId(result.id) && !results.has(result.id) && typeof result.text === 'string');
      results.add(result.id);
    }
    for (const item of raw.checklist || []) {
      requireValid(zipObject(item) && zipId(item.id) && !checklist.has(item.id) && typeof item.text === 'string');
      checklist.add(item.id);
    }
    for (const file of raw.files) {
      requireValid(zipObject(file) && media.has(file.id) && (!file.resultId || results.has(file.resultId)));
      used.add(file.id);
    }
    const task = sanitizeTask(raw);
    requireValid(task.files.length === raw.files.length && task.results.length === results.size &&
      task.checklist.length === checklist.size);
    byId.set(task.id, task);
    tasks.push(task);
  }
  requireValid(used.size === media.size);
  const checked = new Set();
  for (const task of tasks) {
    const path = new Set();
    let node = task;
    while (node && !checked.has(node.id)) {
      requireValid(!path.has(node.id));
      path.add(node.id);
      if (!node.parentId) break;
      const parent = byId.get(node.parentId);
      requireValid(parent && parent.boardId === node.boardId && parent.columnId === node.columnId);
      node = parent;
    }
    for (const id of path) checked.add(id);
  }
  for (const [key, value] of Object.entries(data.web)) {
    requireValid(zipWebKey(key) && key.length <= 4096 && typeof value === 'string' && value.length <= 2_000_000);
  }
  validateJapaneseBackup(Object.fromEntries(Object.entries(data.web).filter(([key]) => JAPANESE_BACKUP_KEYS.includes(key))));
  const nativeJapanese = validateNativeJapaneseBackup(data.nativeJapanese);
  const pomo = data.pomo;
  requireValid(zipObject(pomo) && ['focus', 'break'].includes(pomo.mode) && typeof pomo.running === 'boolean' &&
    Number.isSafeInteger(pomo.remaining) && pomo.remaining >= 0 && pomo.remaining <= (pomo.mode === 'focus' ? 1500000 : 300000) &&
    typeof pomo.day === 'string' && !!pomo.day && isValidISODate(pomo.day) && Number.isSafeInteger(pomo.sessions) &&
    pomo.sessions >= 0 && Number.isSafeInteger(pomo.end) && pomo.end >= 0);
  for (const key of Object.keys(data.settings)) requireValid(zipId(key) && ![ZIP_PROJECTION, '__proto__', 'prototype', 'constructor'].includes(key));
  const settings = { ...data.settings, [ZIP_IMPORTED]: true };
  if (settings.comrade_day_plan_v1 != null) {
    const plan = settings.comrade_day_plan_v1;
    requireValid(zipObject(plan) && typeof plan.date === 'string' && isValidISODate(plan.date) && Array.isArray(plan.ids));
  }
  return { boards: data.boards.map(sanitizeBoard), activeBoardId: data.activeBoardId, tasks, media, settings,
    projection: { web: data.web, nativeJapanese, pomo } };
}
async function projectZipState(projection) {
  if (!projection) return;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (zipWebKey(key) && !Object.hasOwn(projection.web, key)) localStorage.removeItem(key);
  }
  for (const [key, value] of Object.entries(projection.web)) localStorage.setItem(key, value);
  if (projection.nativeJapanese && await nativeJapaneseCommand('restore', projection.nativeJapanese) !== true)
    throw new Error('Android не подтвердил восстановление японского');
  await pomodoroArchive('backup-restore', projection.pomo);
  await dbPutSettingsBulk([[ZIP_PROJECTION, null]]);
}
async function importZipData(file) {
  if (!canUseZip() || zipActive) { showToast('Импорт ZIP доступен в Android и требует свободного приложения'); return; }
  zipActive = true;
  const id = crypto.randomUUID();
  const read = async path => {
    const response = await fetch('/native-backup/' + id + '/' + path, { cache: 'no-store' });
    if (!response.ok) throw new Error('Не удалось прочитать проверенный архив');
    return response;
  };
  let committed = false;
  try {
    await zipStep(id, 'zip-import', 'begin', { size: file.size });
    await sendMediaChunks(id, file);
    const verified = await zipStep(id, 'zip-validate', 'verified', {}, 300000);
    const plan = validateZipState(await (await read('state.json')).json(), verified.entries);
    if (!await confirmDialog('Восстановить ZIP-бэкап',
      `Текущие данные будут заменены на ${plan.boards.length} досок и ${plan.tasks.length} задач из файла.`)) return;
    if (taskEditorBlocksImport()) throw new Error('Сначала завершите редактирование задачи');
    const staged = Object.create(null);
    for (const item of plan.media.values()) {
      const full = await (await read(item.path)).blob();
      if (full.size !== item.size) throw new Error('Вложение передано не полностью');
      let thumb = null;
      if (item.thumb) {
        const preview = await (await read(item.thumb.path)).blob();
        if (preview.size !== item.thumb.size) throw new Error('Миниатюра передана не полностью');
        thumb = await blobToBase64(preview.slice(0, preview.size, item.thumb.mime));
      }
      staged[item.id] = { full: full.slice(0, full.size, item.mime), type: item.mime, thumb };
    }
    await dbReplaceAll({ ...plan, media: staged });
    committed = true;
    await projectZipState(plan.projection);
    location.reload();
  } catch (error) {
    if (!committed) alert('Импорт ZIP отменён. Данные сохранены. ' + error.message);
    else { alert('Данные ZIP сохранены. Приложение завершит восстановление настроек при запуске.'); location.reload(); }
  } finally { cancelZip(id); zipActive = false; }
}

async function exportData() {
  if (canUseZip()) return exportZipData();
  try {
    const allTasks = Object.values(state._tasksByBoard).flat();
    const settings = await dbGetSettings();
    const nativeJapanese = await nativeJapaneseCommand('read');
    const version = allTasks.some(t => t.files.some(f => f.resultId)) ? 8 : allTasks.some(t => t.results?.length) ? 7 : 6;
    const parts = ['{"version":' + version + ',"app":"comrade","exportedAt":' + JSON.stringify(new Date().toISOString())
      + ',"activeBoardId":' + JSON.stringify(state.activeBoardId) + ',"boards":' + JSON.stringify(state.boards)
      + ',"tasks":' + JSON.stringify(allTasks)
      + ',"dayPlan":' + JSON.stringify(settings.comrade_day_plan_v1 || null)
      + ',"japanese":' + JSON.stringify(readJapaneseBackup())
      + ',"nativeJapanese":' + JSON.stringify(nativeJapanese) + ',"media":{'];
    const seen = new Set();
    let n = 0;
    for (const f of allTasks.flatMap(t => t.files)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const m = await mediaGet(f.id);
      if (!m?.full) throw new Error('Не найдено вложение «' + f.name + '». Экспорт отменён');
      parts.push((n++ ? ',' : '') + JSON.stringify(f.id) + ':{"type":' + JSON.stringify(m.type || f.type)
        + ',"thumb":' + JSON.stringify(m.thumb || null) + ',"data":"' + await blobToBase64(m.full) + '"}');
    }
    parts.push('}}');
    const backup = new Blob(parts, { type: 'application/json' });
    const filename = `kanban-backup-${todayISO()}.json`;
    if (window.KanbanBackup?.postMessage) {
      const saved = await saveBackupViaAndroid(backup, filename);
      if (!saved) { showToast('Сохранение бэкапа отменено'); return; }
      showToast(`Бэкап сохранён: ${state.boards.length} досок, ${allTasks.length} задач, ${n} вложений`);
    } else {
      if (location.origin === 'https://appassets.androidplatform.net')
        throw new Error('Сохранение файла недоступно в этой версии Android WebView');
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
  // Full v5+ backups must have both collections; otherwise an incomplete
  // archive could silently replace a real board with an empty one.
  if (!Array.isArray(data) && data && Object.prototype.hasOwnProperty.call(data, 'version')) {
    const version = Number(data.version);
    if (!Number.isInteger(version) || version < 1 || version > 8)
      throw new Error('Неподдерживаемая версия архива');
    if (version >= 5 && (!Array.isArray(data.boards) || !Array.isArray(data.tasks)))
      throw new Error('Архив неполный: отсутствуют доски или задачи');
  }
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
  // A modern full backup must never silently discard referenced files or tasks.
  if (!Array.isArray(data) && Number(data.version) >= 5 && (brokenMedia || skippedTasks))
    throw new Error('Архив неполный: повреждены задачи или вложения. Импорт отменён без изменений');
  const japanese = validateJapaneseBackup(!Array.isArray(data) ? data.japanese : null);
  const nativeJapanese = validateNativeJapaneseBackup(!Array.isArray(data) ? data.nativeJapanese : null);
  let dayPlan = null;
  if (!Array.isArray(data) && data.dayPlan != null) {
    const saved = data.dayPlan;
    if (saved && typeof saved === 'object' && typeof saved.date === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(saved.date)
        && isValidISODate(saved.date) && Array.isArray(saved.ids)) {
      const validIds = new Set(tasks.map(t => t.id));
      const ids = [...new Set(saved.ids.filter(id => typeof id === 'string' && validIds.has(id)))];
      if (ids.length !== saved.ids.length) warnings.push('«Мой день»: недоступные задачи исключены.');
      if (ids.length) dayPlan = { date: saved.date, ids, updatedAt: Number(saved.updatedAt) || Date.now() };
    } else warnings.push('«Мой день»: неверный формат, план пропущен.');
  }
  return { boards, activeBoardId, tasks, media, japanese, nativeJapanese, dayPlan,
    report: { skippedTasks, brokenMedia, warnings } };
}

// The WebView, IndexedDB and Android preferences are different stores.
// Restore secondary progress before the atomic IndexedDB replacement and
// compensate best-effort on failure, without discarding the existing boards.
function restoreJapaneseImportSnapshot(previous) {
  if (!previous) return;
  let firstError = null;
  for (const [key, value] of Object.entries(previous)) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { if (!firstError) firstError = e; }
  }
  if (firstError) throw firstError;
}

// Only one import may read, confirm, restore progress or replace data at a time.
let importInProgress = false;
function taskEditorBlocksImport() {
  return savingTask || switchingBoard || $('#taskModal').classList.contains('open');
}
async function handleImport(file) {
  if (!file) return;
  if (importInProgress) { showToast('Импорт уже выполняется'); return; }
  if (taskEditorBlocksImport()) {
    showToast('Закройте редактор задачи и завершите сохранение перед импортом');
    return;
  }
  importInProgress = true;
  try { await importSingleFile(file); }
  finally { importInProgress = false; }
}
async function importSingleFile(file) {
  if (/\.zip$/i.test(file.name || '') || file.type === 'application/zip') return importZipData(file);
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { alert('Неверный JSON: ' + e.message); return; }

  let plan;
  try { plan = await buildImportPlan(data); }
  catch (e) { alert('Ошибка импорта: ' + e.message); return; }

  const totalWarn = plan.report.warnings.length;
  const message = `Текущие ${state.boards.length} досок и ${Object.values(state._tasksByBoard).reduce((s,a)=>s+a.length,0)} задач будут заменены на ${plan.boards.length} досок и ${plan.tasks.length} задач из файла.`
    + (plan.japanese ? '\nСохранённый прогресс японского языка из архива заменит совпадающие настройки.' : '')
    + (plan.nativeJapanese ? '\nНативная мини-викторина японского также будет восстановлена.' : '')
    + (totalWarn ? `\n\nПредупреждений: ${totalWarn}. См. консоль.` : '');
  if (totalWarn) console.warn('[import] warnings:', plan.report.warnings);

  const ok = await confirmDialog('Импорт данных', message);
  if (!ok) return;
  // The editor may have opened while the archive was being read or validated.
  if (taskEditorBlocksImport()) {
    showToast('Импорт отменён: завершите редактирование задачи');
    return;
  }

  // Read both snapshots before changing anything. Missing Android bridge or
  // unreadable storage must abort before the destructive IndexedDB transaction.
  let previousWeb = null;
  let previousNative = null;
  try {
    if (plan.japanese) {
      previousWeb = Object.fromEntries(Object.keys(plan.japanese)
        .map(key => [key, localStorage.getItem(key)]));
    }
    if (plan.nativeJapanese) {
      previousNative = await nativeJapaneseCommand('read');
      if (!previousNative) throw new Error('Невозможно сохранить текущий нативный прогресс японского');
    }
  } catch (e) {
    console.error('Import preflight failed:', e);
    alert('Импорт отменён без изменений: ' + e.message);
    return;
  }

  let webAttempted = false;
  let nativeAttempted = false;
  try {
    if (plan.japanese) {
      webAttempted = true;
      restoreJapaneseBackup(plan.japanese);
    }
    if (plan.nativeJapanese) {
      nativeAttempted = true;
      const restored = await nativeJapaneseCommand('restore', plan.nativeJapanese);
      if (restored !== true) throw new Error('Android не подтвердил восстановление японского');
    }
    // Existing tasks/media/settings are replaced only after progress succeeds.
    // IndexedDB provides one atomic transaction for all these records.
    await dbReplaceAll(plan);
  } catch (e) {
    const rollbackErrors = [];
    // Even a rejected Android restore might have applied before the reply failed.
    if (nativeAttempted) {
      try {
        const reverted = await nativeJapaneseCommand('restore', previousNative);
        if (reverted !== true) throw new Error('Android не подтвердил откат японского');
      } catch (error) { rollbackErrors.push('нативный прогресс: ' + error.message); }
    }
    if (webAttempted) {
      try { restoreJapaneseImportSnapshot(previousWeb); }
      catch (error) { rollbackErrors.push('веб-прогресс: ' + error.message); }
    }
    console.error('Import failed before IndexedDB commit:', e);
    if (rollbackErrors.length) {
      console.error('Import rollback incomplete:', rollbackErrors);
      alert('Импорт не завершён: ' + e.message
        + '\nДоски и задачи не заменены, но откат японского прогресса завершился с ошибкой: '
        + rollbackErrors.join('; ') + '. Проверьте прогресс перед повторным импортом.');
    } else {
      alert('Импорт отменён: ' + e.message + '\nСтарые доски и задачи сохранены.');
    }
    return;
  }

  undoStack.length = 0; for (const t of pendingMediaDeletes.values()) clearTimeout(t); pendingMediaDeletes.clear(); apStop();
  rebucket(plan.tasks, plan.boards, plan.activeBoardId);
  applyActiveBoard();
  thumbCache.clear();
  renderBoard();
  saveUIState();

  if (globalThis.KanbanTaskReminders) queueTaskReminders();
  const suffix = totalWarn ? ` (${totalWarn} предупр.)` : '';
  showToast(`Импортировано: ${plan.tasks.length} задач в ${plan.boards.length} досках${suffix}`,
    null, null, 5500);
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
  if (drag || e.button !== 0) return;
  const card = e.target.closest('.task-card');
  if (!card) return;
  const grip = e.target.closest('[data-drag-handle]');
  if (!grip && e.target.closest('[data-delete], [data-media], [data-move-next], [data-move-done], button, input, .ap')) return;
  if (!isDragAllowed()) return;
  drag = {
    card, taskId: card.dataset.taskId, sourceColumnId: card.parentElement?.dataset.columnId,
    pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY, startTime: Date.now(),
    isTouch: e.pointerType !== 'mouse', fromGrip: !!grip, active: false, timer: null,
    frame: null, scrollPending: false
  };
  lastPointer = { x: e.clientX, y: e.clientY };
  // Capture on a stationary parent: a card may move between columns during drag.
  if (grip) {
    if (e.cancelable) e.preventDefault();
    const board = $('#board');
    if (board.setPointerCapture) {
      try { board.setPointerCapture(e.pointerId); } catch (_) {}
    }
  }
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  if (drag.isTouch && !drag.fromGrip) drag.timer = setTimeout(() => { if (drag && !drag.active) startDrag(); }, 300);
}
function startDrag() {
  if (!drag || drag.active) return;
  drag.active = true;
  clearTimeout(drag.timer);
  drag.card.classList.add('dragging');
  $('#board').classList.add('is-dragging');
  document.body.style.userSelect = 'none';
  document.addEventListener('touchmove', preventTouch, { passive: false });
  try { globalThis.KanbanHaptics?.postMessage('drag'); } catch (_) {}
  updateDropTarget(lastPointer.x, lastPointer.y);
}
function preventTouch(e) { if (drag && drag.active) e.preventDefault(); }
function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  lastPointer = { x: e.clientX, y: e.clientY };
  const wasActive = drag.active;
  if (!wasActive) {
    const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (drag.fromGrip) { if (dist < 5) return; startDrag(); }
    else if (drag.isTouch) { if (dist > 10) { cleanupDragWithoutRerender(); return; } }
    else { if (dist < 5) return; startDrag(); }
  }
  if (e.cancelable) e.preventDefault();
  // Activation remains immediate; subsequent moves share the next frame.
  if (wasActive) queueDragFrame();
  else updateAutoScroll(e.clientX, e.clientY);
}
function queueDragFrame(scroll = false) {
  if (!drag || !drag.active) return;
  if (scroll) drag.scrollPending = true;
  if (drag.frame !== null) return;
  const activeDrag = drag;
  activeDrag.frame = requestAnimationFrame(() => {
    activeDrag.frame = null;
    if (drag !== activeDrag || !activeDrag.active) return;
    const { x, y } = lastPointer;
    const scrollNow = activeDrag.scrollPending;
    activeDrag.scrollPending = false;
    if (scrollNow) {
      // A newer pointer event can change the scroll direction before this frame.
      updateAutoScroll(x, y);
      if (autoScrollInterval) {
        const board = $('#board');
        if (autoScrollDir.x !== 0) board.scrollLeft += autoScrollDir.x * 6;
        if (autoScrollDir.y !== 0) {
          const list = document.elementFromPoint(x, y)?.closest('.task-list');
          if (list) list.scrollTop += autoScrollDir.y * 6;
        }
      }
    }
    updateDropTarget(x, y);
    if (!scrollNow) updateAutoScroll(x, y);
  });
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
  const taskId = drag.taskId;
  const sourceColumnId = drag.sourceColumnId;
  cleanupDragListeners();
  clearTimeout(drag.timer);
  stopAutoScroll();
  if (wasActive) {
    const dropList = updateDropTarget(e.clientX, e.clientY);
    lastDragEndTime = Date.now();
    card.classList.remove('dragging');
    document.body.style.userSelect = '';
    $('#board').classList.remove('is-dragging');
    const list = dropList && card.parentElement === dropList ? dropList : null;
    const touched = [sourceColumnId, card.parentElement?.dataset.columnId];
    drag = null;
    let committed = false;
    if (list) {
      const newColId = list.dataset.columnId;
      const orderedIds = $$('.task-card', list).map(c => c.dataset.taskId);
      // Keep the first match, as Array.find did, without rescanning per card.
      const tasksById = new Map();
      for (const task of state.tasks) {
        if (!tasksById.has(task.id)) tasksById.set(task.id, task);
      }
      const toUpdate = [];
      for (let i = 0; i < orderedIds.length; i++) {
        const t = tasksById.get(orderedIds[i]);
        if (!t) continue;
        if (t.columnId === newColId && t.order === i) continue;
        const updated = applyColumnChange(t, newColId);
        updated.order = i;
        toUpdate.push(updated);
      }
      try {
        // Save a moved parent and all descendants in one IndexedDB transaction.
        const changes = new Map(toUpdate.map(t => [t.id, t]));
        for (const parent of toUpdate) {
          const previous = tasksById.get(parent.id);
          if (!previous || previous.columnId === parent.columnId) continue;
          for (const child of subtree(parent.id)) {
            const current = changes.get(child.id) || child;
            if (current.columnId !== parent.columnId) {
              changes.set(child.id, applyColumnChange(current, parent.columnId));
            }
          }
        }
        const updates = [...changes.values()];
        await dbPutTasks(updates);
        // Storage is asynchronous: index the current array, not the old positions.
        const currentTasks = state.tasks;
        const positions = new Map();
        for (let i = 0; i < currentTasks.length; i++) {
          const id = currentTasks[i].id;
          if (!positions.has(id)) positions.set(id, i);
        }
        for (const cand of updates) {
          const idx = positions.get(cand.id);
          if (idx !== undefined) currentTasks[idx] = cand;
        }
        notifyOtherTabs();
        committed = updates.length > 0;
      } catch (err) { showToast('Не удалось сохранить порядок: ' + err.message); }
    }
    renderMovedTaskColumns(touched, list ? [taskId] : []);
    if (committed) {
      const feedbackSent = typeof offerTaskResult === 'function' && offerTaskResult(taskId, sourceColumnId);
      if (!feedbackSent) try { globalThis.KanbanHaptics?.postMessage('move'); } catch (_) {}
    }
  } else {
    drag = null;
  }
}
function onPointerCancel(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const wasActive = drag.active;
  const touched = [drag.sourceColumnId, drag.card.parentElement?.dataset.columnId];
  cleanupDragWithoutRerender();
  if (wasActive) {
    lastDragEndTime = Date.now();
    renderMovedTaskColumns(touched); // restore only affected columns after cancellation
  }
}
function cleanupDragListeners() {
  if (drag && drag.frame !== null) {
    cancelAnimationFrame(drag.frame);
    drag.frame = null;
    drag.scrollPending = false;
  }
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  document.removeEventListener('touchmove', preventTouch);
}
function getAfterElement(container, y) {
  const cards = container.querySelectorAll('.task-card:not(.dragging)');
  // Kanban lists are vertical, non-wrapping flex columns. Card padding,
  // borders and gap keep their midpoints ordered even with the small
  // cardIn/hover translations. Search the first midpoint strictly below y
  // on the screen (greater clientY), reading fresh rectangles on each call.
  let low = 0, high = cards.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const box = cards[mid].getBoundingClientRect();
    if (y - box.top - box.height / 2 < 0) high = mid;
    else low = mid + 1;
  }
  return cards[low] || null;
}
function getDropListAt(x, y) {
  const rect = $('#board').getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  return el.closest('.task-list') || el.closest('.column')?.querySelector('.task-list') || null;
}
function updateDropTarget(x, y) {
  if (!drag || !drag.active) return null;
  const list = getDropListAt(x, y);
  // Keep an unchanged highlight; avoid repeated style mutations on each move.
  $$('.task-list.drag-over').forEach(el => {
    if (el !== list) el.classList.remove('drag-over');
  });
  if (!list) return null;
  if (!list.classList.contains('drag-over')) list.classList.add('drag-over');
  const after = getAfterElement(list, y);
  const card = drag.card;
  if (after !== card) {
    if (after == null) { if (list.lastElementChild !== card) list.appendChild(card); }
    else { if (after.previousSibling !== card) list.insertBefore(card, after); }
  }
  return list;
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
      queueDragFrame(true);
    }, 16);
  }
}
function stopAutoScroll() { if (autoScrollInterval) { clearInterval(autoScrollInterval); autoScrollInterval = null; } }

// ============================================================
// EVENT BINDINGS
// ============================================================
function closeHeaderMenu(restoreFocus = false) {
  const actions = $('#headerActions');
  if (!actions.classList.contains('is-open')) return false;
  actions.classList.remove('is-open');
  const trigger = $('#headerMenuBtn');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', 'Открыть меню');
  if (restoreFocus) trigger.focus();
  return true;
}
function toggleHeaderMenu() {
  const actions = $('#headerActions');
  if (actions.classList.contains('is-open')) { closeHeaderMenu(true); return; }
  actions.classList.add('is-open');
  const trigger = $('#headerMenuBtn');
  trigger.setAttribute('aria-expanded', 'true');
  trigger.setAttribute('aria-label', 'Закрыть меню');
  actions.querySelector('button')?.focus();
}

// Keyboard-accessible tablist: Arrow keys move/activate tabs; Home/End jump.
function bindViewTabs() {
  const tabs = $$('.view-tab');
  tabs.forEach((tab, index) => {
    tab.onclick = () => switchView(tab.dataset.view);
    tab.onkeydown = e => {
      let next = index;
      if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      else return;
      e.preventDefault();
      switchView(tabs[next].dataset.view);
      tabs[next].focus();
    };
  });
}

function bindEvents() {
  $('#headerMenuBtn').onclick = toggleHeaderMenu;
  document.addEventListener('click', (e) => {
    const actions = $('#headerActions');
    if (!actions.classList.contains('is-open')) return;
    if (e.target.closest('#headerMenuBtn')) return;
    if (!actions.contains(e.target) || e.target.closest('button')) closeHeaderMenu();
  });
  document.addEventListener('focusin', (e) => {
    const actions = $('#headerActions');
    if (actions.classList.contains('is-open') &&
        !actions.contains(e.target) && e.target !== $('#headerMenuBtn')) closeHeaderMenu();
  });
  window.addEventListener('resize', () => { if (window.innerWidth > 960) closeHeaderMenu(); });
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

  bindViewTabs();

  let searchTimer = null;
  $('#searchInput').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchQuery = e.target.value.trim(); renderFilteredBoard(); }, 150);
  };
  $('#tagFilter').onchange = (e) => { filterTag = e.target.value; saveUIState(); renderFilteredBoard(); };
  $('#priorityFilter').onchange = (e) => { filterPriority = e.target.value; saveUIState(); renderFilteredBoard(); };
  $('#deadlineFilter').onchange = (e) => { filterDeadline = e.target.value; saveUIState(); renderFilteredBoard(); };
  $('#sortSelect').onchange = (e) => { sortMode = e.target.value; saveUIState(); renderFilteredBoard(); };

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
    const selection = Array.from(e.target.files || []);
    e.target.value = ''; // Permit selecting the same file again after a cancelled edit.
    stageSelectedFiles(selection);
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
  const viewer = $('#lightbox');
  viewer.addEventListener('click', e => { if (e.target === viewer) closeLightbox(); });
  $('#lightboxClose').onclick = closeLightbox;
  $('#lightboxPrev').onclick = () => changeLightboxItem(-1);
  $('#lightboxNext').onclick = () => changeLightboxItem(1);
  $('#lightboxZoomIn').onclick = () => updateLightboxZoom(lightboxGallery.zoom * 1.5);
  $('#lightboxZoomOut').onclick = () => updateLightboxZoom(lightboxGallery.zoom / 1.5);
  viewer.addEventListener('pointerdown', lightboxPointerDown);
  viewer.addEventListener('pointermove', lightboxPointerMove);
  viewer.addEventListener('pointerup', lightboxPointerUp);
  viewer.addEventListener('pointercancel', lightboxPointerUp);

  document.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      if ($('#lightbox').classList.contains('open')) { closeLightbox(); return; }
      if ($('#confirmModal').classList.contains('open')) { $('#confirmCancel').click(); return; }
      if ($('#textPromptModal').classList.contains('open')) { $('#textPromptCancel').click(); return; }
      if ($('#taskModal').classList.contains('open')) { await tryCloseTaskModal(); return; }
      if ($('#settingsModal').classList.contains('open')) { closeModal('settingsModal'); return; }
      if ($('#shortcutsModal').classList.contains('open')) { closeModal('shortcutsModal'); return; }
      if (closeHeaderMenu(true)) { e.preventDefault(); return; }
      if (document.activeElement === $('#searchInput')) {
        $('#searchInput').value = ''; searchQuery = '';
        document.activeElement.blur();
        renderBoard();
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
    // An open menu owns keyboard focus; do not trigger global task/view shortcuts.
    if ($('#headerActions').classList.contains('is-open')) return;
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


function comradeHandleAndroidBack() {
  if ($('#lightbox').classList.contains('open')) { closeLightbox(); return true; }
  if ($('#confirmModal').classList.contains('open')) { $('#confirmCancel').click(); return true; }
  if ($('#textPromptModal').classList.contains('open')) { $('#textPromptCancel').click(); return true; }
  if ($('#taskModal').classList.contains('open')) { void saveTaskFromModal(); return true; }
  if ($('#settingsModal').classList.contains('open')) { closeModal('settingsModal'); return true; }
  if ($('#shortcutsModal').classList.contains('open')) { closeModal('shortcutsModal'); return true; }
  if (closeHeaderMenu(true)) return true;
  if (!$('#dayPlanPanel').hidden) { $('#dayPlanPanel').hidden = true; return true; }
  if (!$('#pomo').hidden) { $('#pomo').hidden = true; return true; }
  return false;
}
window.comradeHandleAndroidBack = comradeHandleAndroidBack;

// Keep selections from several Android picker visits until the task is saved.
// The actual media blobs are committed only by saveTaskFromModal().
function stageSelectedFiles(files) {
  if (savingTask) { showToast('Дождитесь сохранения задачи'); return 0; }
  let accepted = 0, rejected = 0;
  for (const file of files || []) {
    if (!file || !Number.isFinite(file.size) || file.size < 0 || file.size > MAX_VIDEO_SIZE) {
      rejected++;
      continue;
    }
    newFiles.push(file);
    accepted++;
    if (isAudio(file)) {
      void prepAudio(file).then(() => {
        if ($('#taskModal').classList.contains('open')) renderFiles();
      }).catch(() => {}); // Decoder may reject; the save path reports persistent errors.
    }
  }
  renderFiles();
  if (rejected) showToast(`${rejected} файл(ов) пропущено: лимит 50 МБ на файл`);
  return accepted;
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
  notifyOtherTabs(); renderTaskCollectionChange(task, false);
  showToast(`Добавлено в «${state.boardName}»`);
  return true;
}


// Daily plan is an ordered, dated selection of existing task IDs.
// It never moves cards, changes task priorities, or rewrites deadlines.
// Preserve existing daily-plan records across application upgrades.
const COMRADE_DAY_KEY = 'comrade_day_plan_v1';
const dayPlanEl = id => document.getElementById(id);
const dayPlanTasks = () => Object.values(state._tasksByBoard).flat();
function dayPlanNotice(message) {
  const item=document.createElement('div');
  item.className='day-plan-notice';
  item.textContent=String(message);
  const log=dayPlanEl('dayPlanLog');
  if(log){log.appendChild(item);log.scrollTop=log.scrollHeight;}
}
function bindDailyPlan() {
  dayPlanEl('dayPlanClose').onclick=()=>{dayPlanEl('dayPlanPanel').hidden=true;};
}

function comradeDayCandidates(today = todayISO()) {
  const boards = new Map(state.boards.map(board => [board.id, board]));
  return dayPlanTasks().flatMap(task => {
    if (task.parentId) return []; // Avoid listing the same work twice via parent and child.
    const board = boards.get(task.boardId);
    if (!board) return [];
    const index = board.columns.findIndex(c => c.id === task.columnId);
    if (index < 0 || board.columns[index].isDone) return [];
    const priorityValue = PRIORITY_ORDER[task.priority] || 0;
    const inProgress = index > 0;
    let rank = 0, reason = '';
    if (task.deadline && task.deadline < today) {
      rank = 500; reason = 'Просрочено';
    } else if (task.deadline === today) {
      rank = 400; reason = 'Срок сегодня';
    } else if (inProgress) {
      rank = 300; reason = 'В работе';
    } else if (!task.deadline && task.priority === 'high') {
      rank = 250; reason = 'Важная без срока';
    } else if (task.deadline && task.priority === 'high') {
      const target = new Date(today + 'T12:00:00');
      target.setDate(target.getDate() + 1);
      const tomorrow = [
        target.getFullYear(),
        String(target.getMonth()+1).padStart(2,'0'),
        String(target.getDate()).padStart(2,'0')
      ].join('-');
      if (task.deadline === tomorrow) { rank = 200; reason = 'Высокий приоритет · завтра'; }
    }
    // Keep all remaining unfinished top-level tasks selectable too.
    // Their low score keeps them out of the default six-task suggestion.
    if (!rank) {
      rank = task.deadline ? 90 : 50;
      reason = task.deadline ? 'Позднее' : 'Без срока';
    }
    return [{
      id: task.id, title: task.title, board: board.name, boardId: board.id,
      priority: task.priority || 'none', deadline: task.deadline || '',
      reason, score: rank + priorityValue * 10
    }];
  }).sort((a,b) =>
    b.score - a.score ||
    (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31') ||
    a.title.localeCompare(b.title,'ru') || a.id.localeCompare(b.id)
  ).slice(0,60);
}

function comradeDayDraft(candidates, saved, today = todayISO(), fresh = false) {
  const valid = new Map(candidates.map(item => [item.id,item]));
  const savedIds = !fresh && saved?.date === today && Array.isArray(saved.ids)
    ? [...new Set(saved.ids.filter(id => typeof id === 'string'))] : [];
  const rows = [
    ...savedIds.filter(id => valid.has(id)).map(id => valid.get(id)),
    ...candidates.filter(item => !savedIds.includes(item.id))
  ];
  const availableSaved = savedIds.filter(id => valid.has(id));
  const selected = availableSaved.length && !fresh
    ? availableSaved : rows.slice(0,6).map(item => item.id);
  return {rows, selected, fromSaved:saved?.date===today && availableSaved.length>0 && !fresh};
}

// Commit only an ordered list of existing task IDs into the separate settings store.
async function comradePersistDay(ids, date = todayISO()) {
  if (date !== todayISO()) throw new Error('Начался новый день; обнови план.');
  const eligible = new Set(comradeDayCandidates(date).map(task => task.id));
  const validIds = [...new Set(ids)].filter(id => eligible.has(id));
  if (!validIds.length) throw new Error('Нет выбранных незавершённых задач.');
  await dbPutSettingsBulk([[COMRADE_DAY_KEY, {
    date, ids:validIds, updatedAt:Date.now()
  }]]);
  return validIds;
}

async function comradeOpenDailyPlan({fresh = false} = {}) {
  const panel=dayPlanEl('dayPlanPanel');
  panel.hidden=false;
  dayPlanEl('dayPlanLog').replaceChildren();
  const today=todayISO();
  let saved;
  try {
    const settings = await dbGetSettings();
    saved = settings[COMRADE_DAY_KEY];
  } catch(e) {
    dayPlanNotice('Не удалось прочитать план: ' + (e.message || e)); return;
  }
  if (panel.hidden) return;
  const candidates = comradeDayCandidates(today);
  if (!candidates.length) {
    dayPlanNotice('На ' + today + ' нет незавершённых просроченных, сегодняшних ' +
      'или высокоприоритетных задач. Проверил все ' + state.boards.length + ' доски.');
    return;
  }
  const draft = comradeDayDraft(candidates,saved,today,fresh);
  const rows = draft.rows.slice();
  const selected = new Set(draft.selected);
  const entry = document.createElement('section');
  entry.className = 'day-plan-card';
  const title = document.createElement('strong');
  title.textContent = (draft.fromSaved?'Сохранённый план':'Предложенный план') +
    ' на ' + today;
  const note = document.createElement('p');
  note.className = 'day-plan-note';
  note.textContent = 'Все ' + state.boards.length + ' доски · ' + candidates.length +
    ' незавершённых задач. Сначала просроченные, сегодняшние и важные. ' +
    'Остальные тоже можно выбрать. Измени порядок стрелками.' +
    (candidates.length >= 60 ? ' Показаны первые 60 задач по срочности.' : '');
  const list = document.createElement('div');
  list.className = 'day-plan-list';
  const footer = document.createElement('div');
  footer.className = 'day-plan-actions';
  const control = (text,klass='btn btn-secondary btn-small')=>{
    const button=document.createElement('button');
    button.type='button';button.className=klass;button.textContent=text;
    footer.appendChild(button);return button;
  };
  const save=control('Сохранить в «Мой день»','btn btn-small');
  const rebuild=control('Новый вариант');
  const close=control('Закрыть');
  entry.append(title,note,list,footer);
  dayPlanEl('dayPlanLog').appendChild(entry);
  entry.scrollIntoView({block:'nearest'});
  function redraw() {
    list.replaceChildren();
    rows.forEach((item,index)=>{
      const row=document.createElement('div');row.className='day-plan-row';
      const label=document.createElement('label');label.className='day-plan-description';
      const check=document.createElement('input');check.type='checkbox';
      check.checked=selected.has(item.id);
      check.setAttribute('aria-label','Включить в план: '+item.title);
      check.onchange=()=>{if(check.checked)selected.add(item.id);else selected.delete(item.id);redraw();};
      const details=document.createElement('span');
      const name=document.createElement('strong');name.textContent=item.title;
      const meta=document.createElement('small');
      const priority={high:'высокий',medium:'средний',low:'низкий',none:'нет'}[item.priority]||'нет';
      meta.textContent=item.board+' · '+item.reason+' · приоритет: '+priority+
        (item.deadline?' · до '+item.deadline:'');
      details.append(name,meta);
      label.append(check,details);
      const arrows=document.createElement('div');arrows.className='day-plan-arrows';
      const makeArrow=(symbol,move,disabled)=>{
        const button=document.createElement('button');
        button.type='button';button.className='btn btn-ghost btn-small';
        button.textContent=symbol;button.disabled=disabled;
        button.setAttribute('aria-label',(move<0?'Переместить выше: ':'Переместить ниже: ')+item.title);
        button.onclick=()=>{
          const other=index+move;
          [rows[index],rows[other]]=[rows[other],rows[index]];
          redraw();
        };
        arrows.appendChild(button);
      };
      makeArrow('↑',-1,index===0);
      makeArrow('↓',1,index===rows.length-1);
      row.append(label,arrows);
      list.appendChild(row);
    });
    save.textContent='Сохранить в «Мой день» ('+selected.size+')';
    save.disabled=!selected.size;
  }
  redraw();
  save.onclick=async()=>{
    const ids=rows.filter(item=>selected.has(item.id)).map(item=>item.id);
    save.disabled=true;
    try {
      const persisted=await comradePersistDay(ids,today);
      title.textContent='Сохранённый план на '+today;
      dayPlanNotice('Сохранено '+persisted.length+' задач в «Мой день» по всем доскам. '+
        'Их сроки, статусы, приоритеты и доски не изменены.');
    } catch(e){dayPlanNotice('Ошибка сохранения плана: '+(e.message||e));}
    finally{redraw();}
  };
  rebuild.onclick=()=>{entry.remove();void comradeOpenDailyPlan({fresh:true});};
  close.onclick=()=>{panel.hidden=true;};
}
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
function mediaStep(id, expected, send, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(null, new Error('Android не ответил')), timeout);
    function finish(event, error) {
      clearTimeout(timer);
      mediaSteps.delete(id);
      if (error) reject(error); else resolve(event);
    }
    mediaSteps.set(id, { expected, finish });
    try { send(); } catch (error) { finish(null, error); }
  });
}
async function sendMediaChunks(id, blob, isCurrent = () => true) {
  const chunkSize = 256 * 1024;
  const header = new TextEncoder().encode(id);
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const data = await blob.slice(offset, offset + chunkSize).arrayBuffer();
    if (!isCurrent()) throw new Error('Передача отменена');
    const frame = new Uint8Array(header.length + data.byteLength);
    frame.set(header);
    frame.set(new Uint8Array(data), header.length);
    await mediaStep(id, 'chunk', () => globalThis.KanbanMedia.postMessage(frame.buffer));
  }
}
function mediaDiscard(id) {
  mediaSteps.get(id)?.finish(null, new Error('Передача отменена'));
  try { mediaCommand(id, 'discard'); } catch (_) {}
}
let mediaQueue = Promise.resolve();
function stageNativeMedia(id, blob, isCurrent, options = {}) {
  const transfer = mediaQueue.then(async () => {
    if (!isCurrent()) throw new Error('Передача отменена');
    try {
      await mediaStep(id, 'begin', () => mediaCommand(id, 'begin', { size: blob.size, ...options }));
      await sendMediaChunks(id, blob, isCurrent);
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
  if (step && (event.type === 'error' || event.type === step.expected ||
      (Array.isArray(step.expected) && step.expected.includes(event.type)))) {
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

  if (canUseZip()) {
    try {
      const pending = (await dbGetSettings())[ZIP_PROJECTION];
      if (pending) { await projectZipState(pending); initTheme(); }
    } catch (error) { alert('Восстановление настроек ZIP будет повторено при следующем запуске: ' + error.message); }
  }

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

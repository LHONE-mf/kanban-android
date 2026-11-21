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

async function exportData() {
  try {
    const allTasks = Object.values(state._tasksByBoard).flat();
    const settings = await dbGetSettings();
    const nativeJapanese = await nativeJapaneseCommand('read');
    const parts = ['{"version":6,"app":"comrade","exportedAt":' + JSON.stringify(new Date().toISOString())
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
  // Full v5/v6 backups must have both collections; otherwise an incomplete
  // archive could silently replace a real board with an empty one.
  if (!Array.isArray(data) && data && Object.prototype.hasOwnProperty.call(data, 'version')) {
    const version = Number(data.version);
    if (!Number.isInteger(version) || version < 1 || version > 6)
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
async function handleImport(file) {
  if (!file) return;
  if (importInProgress) { showToast('Импорт уже выполняется'); return; }
  importInProgress = true;
  try { await importSingleFile(file); }
  finally { importInProgress = false; }
}
async function importSingleFile(file) {
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


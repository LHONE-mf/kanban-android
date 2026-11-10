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
    deadline: $('#taskDeadline').value, reminder: $('#taskReminder').value, reminderRepeat: $('#taskReminderRepeat').value, priority: editingPriority, checklist: tempChecklist,
    parent: $('#taskParent').value, files: tempFiles.map(f => f.id + f.name), nf: newFiles.map(f => (f._name || f.name) + f.size)
  });
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

  titleEl.value = ''; descEl.value = ''; deadlineEl.value = ''; $('#taskReminder').value = ''; $('#taskReminderRepeat').value = 'none'; tagsEl.value = '';
  fileInput.value = '';
  $('#taskTitleError').hidden = true; $('#taskDeadlineError').hidden = true; $('#taskReminderError').hidden = true;
  setPriorityChips('none'); renderChecklistUI();

  if (taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    $('#taskModalTitle').textContent = 'Редактирование задачи';
    titleEl.value = task.title; descEl.value = task.desc || '';
    deadlineEl.value = task.deadline || ''; $('#taskReminder').value = task.reminder || ''; $('#taskReminderRepeat').value = task.reminderRepeat || 'none'; tagsEl.value = task.tags.join(', ');
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
    priority: editingPriority, deadline, reminder, reminderRepeat, files,
    checklist: tempChecklist.map(c => ({ id: c.id, text: c.text.trim(), checked: !!c.checked })).filter(c => c.text),
    order: !moved ? existing.order : (sib.length ? Math.min(...sib.map(t => t.order ?? 0)) - 1 : 0),
    createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now(),
    completedAt: computeCompletedAt(existing ? existing.columnId : null, columnId, existing ? existing.completedAt : null)
  };
  try { await dbPutTask(candidate); }
  catch (e) { stored.forEach(x => mediaDelete(x.id).catch(() => {})); showToast('Не удалось сохранить: ' + e.message, null, null, 5000); return; }

  const idx = existing ? state.tasks.findIndex(t => t.id === candidate.id) : -1;
  if (idx > -1) state.tasks[idx] = candidate; else state.tasks.push(candidate);
  syncNativeReminder(candidate);
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
    files, completedAt: null,
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


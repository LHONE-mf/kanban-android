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

// CROSS-BOARD TASK MOVE
// Keep the entire nested subtree together and persist it in one IndexedDB
// transaction. Never change the in-memory boards if storage rejects the write.
async function moveTaskToBoard(taskId, destinationBoardId) {
  const sourceBoard = getBoard(state.activeBoardId);
  const destination = getBoard(destinationBoardId);
  const sourceTasks = state._tasksByBoard[state.activeBoardId];
  const root = sourceTasks?.find(t => t.id === taskId);
  if (!sourceBoard || !destination || !root || sourceBoard.id === destination.id) {
    showToast('Доска или задача не найдена');
    return false;
  }

  const sourceColumn = sourceBoard.columns.find(c => c.id === root.columnId);
  if (!sourceColumn) {
    showToast('Колонка исходной задачи не найдена');
    return false;
  }
  const equivalentColumns = destination.columns.filter(c => !!c.isDone === !!sourceColumn.isDone);
  const destinationColumn = equivalentColumns.find(c =>
    c.title.trim().toLocaleLowerCase() === sourceColumn.title.trim().toLocaleLowerCase()
  ) || equivalentColumns[0];
  if (!destinationColumn) {
    showToast('В целевой доске нет подходящей колонки для этого статуса');
    return false;
  }

  const descendants = subtree(taskId);
  const group = [root, ...descendants];
  const ids = new Set(group.map(t => t.id));
  if (group.some(t => activeTaskWrites.has(t.id))) {
    showToast('Задача уже сохраняется');
    return false;
  }

  const destinationTasks = state._tasksByBoard[destination.id] || [];
  const orders = destinationTasks.filter(t =>
    !t.parentId && t.columnId === destinationColumn.id).map(t => t.order ?? 0);
  const firstOrder = orders.length ? Math.min(...orders) - 1 : 0;
  const now = Date.now();
  const relocated = group.map((task, index) => ({
    ...task,
    boardId: destination.id,
    columnId: destinationColumn.id,
    parentId: index === 0 ? '' : task.parentId,
    order: index === 0 ? firstOrder : task.order,
    updatedAt: now
  }));

  ids.forEach(id => activeTaskWrites.add(id));
  try {
    await dbPutTasks(relocated);
    const remaining = sourceTasks.filter(t => !ids.has(t.id));
    sourceTasks.splice(0, sourceTasks.length, ...remaining);
    state._tasksByBoard[destination.id] = destinationTasks;
    destinationTasks.push(...relocated);
    relocated.forEach(syncNativeReminder);
  } catch (error) {
    showToast('Не удалось переместить: ' + (error.message || error));
    return false;
  } finally {
    ids.forEach(id => activeTaskWrites.delete(id));
  }

  closeModal('taskModal');
  notifyOtherTabs();
  await switchBoard(destination.id);
  switchView('kanban');
  openTaskModal(taskId);
  showToast('Перемещено в «' + destination.name + '»');
  return true;
}

function updateTaskMoveControls(task) {
  const field = $('#taskMoveField');
  const select = $('#taskMoveBoard');
  field.hidden = !task || state.boards.length < 2;
  select.replaceChildren();
  if (field.hidden) return;
  for (const board of state.boards) {
    if (board.id === state.activeBoardId) continue;
    const option = document.createElement('option');
    option.value = board.id;
    option.textContent = board.name;
    select.appendChild(option);
  }
  $('#taskMoveHint').textContent = task.parentId
    ? 'Задача и вложенные узлы перейдут на другую доску. Эта задача станет самостоятельной.'
    : 'Вложенные узлы, вложения и напоминания переместятся вместе с задачей.';
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

  updateTaskMoveControls(taskId ? state.tasks.find(t => t.id === taskId) : null);
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


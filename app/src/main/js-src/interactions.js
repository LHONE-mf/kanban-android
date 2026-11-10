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
        await dbPutTasks(toUpdate);
        toUpdate.forEach(cand => {
          const idx = state.tasks.findIndex(x => x.id === cand.id);
          if (idx !== -1) state.tasks[idx] = cand;
        });
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
function bindEvents() {
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

  let searchTimer = null;
  $('#searchInput').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchQuery = e.target.value.trim(); renderBoard(); }, 150);
  };
  $('#tagFilter').onchange = (e) => { filterTag = e.target.value; saveUIState(); renderBoard(); };
  $('#priorityFilter').onchange = (e) => { filterPriority = e.target.value; saveUIState(); renderBoard(); };
  $('#deadlineFilter').onchange = (e) => { filterDeadline = e.target.value; saveUIState(); renderBoard(); };
  $('#sortSelect').onchange = (e) => { sortMode = e.target.value; saveUIState(); renderBoard(); };

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
  let swipeStart = null;
  $('#lightbox').addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest('video')) { swipeStart = null; return; }
    swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  $('#lightbox').addEventListener('touchend', e => {
    if (!swipeStart || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - swipeStart.x;
    const dy = e.changedTouches[0].clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.25) stepLightbox(dx < 0 ? 1 : -1);
  }, { passive: true });
  // Native Android Back first asks the page to close the photo viewer.
  window.kanbanHandleBack = () => {
    if (!$('#lightbox').classList.contains('open')) return false;
    closeLightbox();
    return true;
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


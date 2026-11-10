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
  items.sort((a, b) =>
    (deadlineFilter && deadlineFilter !== 'none'
      ? a.task.deadline.localeCompare(b.task.deadline) : 0) ||
    b.score - a.score ||
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


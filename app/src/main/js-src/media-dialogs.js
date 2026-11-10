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
async function dbSaveBoardAndTasks(boards, activeBoardId, changedTasks, deletedTaskIds = []) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_TASKS, STORE_SETTINGS], 'readwrite');
    try {
      const ts = tx.objectStore(STORE_TASKS), ss = tx.objectStore(STORE_SETTINGS);
      changedTasks.forEach(t => ts.put(t));
      deletedTaskIds.forEach(id => ts.delete(id));
      ss.put({ key: 'boards', value: boards });
      ss.put({ key: 'activeBoardId', value: activeBoardId });
    } catch (e) {
      try { tx.abort(); } catch (_) {}
      reject(wrapTxError(e));
      return;
    }
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


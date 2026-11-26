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


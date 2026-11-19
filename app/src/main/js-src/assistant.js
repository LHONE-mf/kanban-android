
// COMRADE: local, request-driven task assistant. All writes use Kanban's IndexedDB helpers.
let comradeBusy = false;
let comradeRequestId = 0;
let comradeQuestion = '';
const comradeEl = id => document.getElementById(id);

function comradeLog(message, user = false) {
  const element = document.createElement('div');
  element.className = 'comrade-line ' + (user ? 'comrade-user' : 'comrade-response');
  element.textContent = String(message).slice(0, 3500);
  const log = comradeEl('comradeLog');
  log.appendChild(element);
  log.scrollTop = log.scrollHeight;
}

function comradeNative(type, data = {}) {
  if (!window.KanbanAssistant?.postMessage) return false;
  window.KanbanAssistant.postMessage(JSON.stringify({ type, ...data }));
  return true;
}

function comradeBusySet(busy) {
  comradeBusy = busy;
  comradeEl('comradeSend').disabled = busy;
  comradeEl('comradeInput').disabled = busy;
  comradeEl('comradeWait').hidden = !busy;
}

function comradeBoard(name) {
  if (!name) return state.boards.find(b => b.id === state.activeBoardId) || state.boards[0];
  const needle = name.toLocaleLowerCase('ru');
  return state.boards.find(b => b.name.toLocaleLowerCase('ru') === needle) ||
    state.boards.find(b => b.name.toLocaleLowerCase('ru').includes(needle));
}

function comradeMentionedBoard(text) {
  const value = text.toLocaleLowerCase('ru');
  return [...state.boards].sort((a,b) => b.name.length-a.name.length)
    .find(b => value.includes(b.name.toLocaleLowerCase('ru'))) || comradeBoard();
}
const comradeTasks = () => Object.values(state._tasksByBoard).flat();

function comradeList(filter = 'all', boardName = '') {
  const board = boardName ? comradeBoard(boardName) : null;
  if (boardName && !board) { comradeLog('Доска не найдена: ' + boardName); return; }
  const today = todayISO();
  const found = comradeTasks().filter(task => {
    if (board && board.id !== task.boardId) return false;
    const b = state.boards.find(x => x.id === task.boardId);
    if (b?.columns.some(c => c.id === task.columnId && c.isDone)) return false;
    if (filter === 'today') return task.deadline && task.deadline <= today;
    if (filter === 'overdue') return task.deadline && task.deadline < today;
    return true;
  }).sort((a,b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
  comradeLog(found.length ? ('Найдено: ' + found.length + '\n' +
    found.slice(0,20).map(t => '• ' + t.title +
      (t.deadline ? ' · ' + t.deadline : '') +
      ' (' + (state.boards.find(b => b.id === t.boardId)?.name || '') + ')').join('\n') +
    (found.length > 20 ? '\nПоказаны первые 20 задач.' : ''))
    : 'Подходящих незавершённых задач нет.');
}

function comradeConfirm(label) {
  return new Promise(resolve => {
    const entry = document.createElement('div');
    entry.className = 'comrade-line comrade-response';
    const title = document.createElement('div');
    title.textContent = label;
    const yes = document.createElement('button');
    yes.className = 'btn btn-small'; yes.textContent = 'Подтвердить';
    const no = document.createElement('button');
    no.className = 'btn btn-secondary btn-small'; no.textContent = 'Отменить';
    const row = document.createElement('div');
    row.className = 'comrade-confirm';
    row.append(yes,no); entry.append(title,row);
    comradeEl('comradeLog').appendChild(entry);
    entry.scrollIntoView({block:'nearest'});
    const done = val => { entry.remove(); resolve(val); };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
  });
}

async function comradeCreateTask(plan) {
  const title = typeof plan.title === 'string' ? plan.title.trim().slice(0, 200) : '';
  if (title.length < 2) { comradeLog('Укажи название задачи.'); return; }
  const board = plan.board ? comradeBoard(String(plan.board)) : comradeBoard();
  if (!board) { comradeLog('Не нашёл доску.'); return; }
  const col = board.columns.find(c => !c.isDone) || board.columns[0];
  if (!col) { comradeLog('Не нашёл колонку для задач.'); return; }
  const deadline = typeof plan.deadline === 'string' && isValidISODate(plan.deadline) ? plan.deadline : '';
  const priority = ['none','low','medium','high'].includes(plan.priority) ? plan.priority : 'none';
  if (!(await comradeConfirm('Создать «' + title + '» в «' + board.name + '»' +
    (deadline ? ' к ' + deadline : '') + '?'))) { comradeLog('Отменено.'); return; }
  const bucket = state._tasksByBoard[board.id] || [];
  const siblings = bucket.filter(t => t.columnId === col.id && !t.parentId);
  const order = siblings.length ? Math.min(...siblings.map(t => t.order || 0)) - 1 : 0;
  const task = sanitizeTask({id: generateId(), boardId: board.id,
    columnId: col.id, title, deadline, priority, order});
  try {
    await dbPutTask(task);
    if (!state._tasksByBoard[board.id]) state._tasksByBoard[board.id] = bucket;
    bucket.push(task);
    if (board.id === state.activeBoardId) { state.tasks = bucket; renderBoard(); }
    notifyOtherTabs();
    comradeLog('Готово. Создана задача «' + title + '».');
  } catch(e) { comradeLog('Ошибка сохранения: ' + (e.message || e)); }
}

async function comradeChangeTask(plan, action) {
  const targetText = String(plan.task || '').trim().toLocaleLowerCase('ru');
  if (targetText.length < 3) { comradeLog('Уточни название задачи.'); return; }
  const boardHint = plan.board ? comradeBoard(String(plan.board)) : null;
  const found = comradeTasks().filter(t => {
    if (boardHint && t.boardId !== boardHint.id) return false;
    const title = t.title.toLocaleLowerCase('ru');
    return title === targetText || title.includes(targetText);
  });
  if (!found.length) { comradeLog('Задача не найдена: ' + targetText); return; }
  if (found.length > 1) {
    comradeLog('Есть несколько совпадений, уточни название:\n' +
      found.slice(0,8).map(t => '• ' + t.title).join('\n')); return;
  }
  const task = found[0];
  const board = state.boards.find(b => b.id === task.boardId);
  const column = action === 'complete'
    ? board?.columns.find(c => c.isDone)
    : board?.columns.find(c => c.title.toLocaleLowerCase('ru') ===
        String(plan.column || '').toLocaleLowerCase('ru')) ||
      ((/(работ|progress)/i).test(String(plan.column || ''))
        ? board?.columns.find(c => !c.isDone && c.id !== task.columnId) : null);
  if (!column) { comradeLog('Нет подходящей колонки.'); return; }
  if (!(await comradeConfirm('Перенести «' + task.title + '» в «' + column.title + '»?'))) {
    comradeLog('Отменено.'); return;
  }
  const updated = {...task, columnId:column.id, updatedAt:Date.now(),
    completedAt:column.isDone ? (task.completedAt || Date.now()) : null};
  try {
    await dbPutTask(updated);
    const bucket = state._tasksByBoard[task.boardId];
    const idx = bucket.findIndex(t => t.id === task.id);
    if (idx >= 0) bucket[idx] = updated;
    if (task.boardId === state.activeBoardId) { state.tasks = bucket; renderBoard(); }
    notifyOtherTabs();
    comradeLog('Готово. Задача перемещена в «' + column.title + '».');
  } catch(e) { comradeLog('Не удалось изменить задачу: ' + (e.message || e)); }
}

async function comradeApply(plan, request) {
  if (!plan || typeof plan !== 'object') { comradeLog('Не понял команду.'); return; }
  if (plan.action === 'create') {
    if (!/^(добавь|создай|запиши|запланируй|поставь|add|create)/i.test(request)) {
      comradeLog('Для создания задачи попроси явно: «Добавь задачу…».'); return;
    }
    await comradeCreateTask(plan);
  } else if (plan.action === 'list') {
    comradeList(['today','overdue'].includes(plan.filter) ? plan.filter : 'all',
      typeof plan.board === 'string' ? plan.board : '');
  } else if (plan.action === 'complete' || plan.action === 'move') {
    if (!/заверш|выполн|закрой|отметь|перенес|перемест|complete|move/i.test(request)) {
      comradeLog('Для изменения задачи попроси об этом явно.'); return;
    }
    await comradeChangeTask(plan, plan.action);
  } else {
    comradeLog(typeof plan.text === 'string' ? plan.text : 'Не удалось распознать действие.');
  }
}

function comradeBasic(text) {
  const query = text.trim();
  if (/^(покажи|список|какие|что.*(?:задач|сделать)|найди|list|show)/i.test(query)) {
    return {action:'list', filter:/просроч/i.test(query) ? 'overdue' :
      /сегодня|today/i.test(query) ? 'today' : 'all',
      board: comradeMentionedBoard(query)?.name || ''};
  }
  const found = query.match(/^(?:добавь|создай|запиши|поставь|запланируй|add|create)\s+(?:мне\s+)?(?:задачу|напоминание)?\s*[:\-]?\s*(.+)$/i);
  if (found) {
    const board = comradeMentionedBoard(query);
    let title = found[1];
    if (board && title.toLocaleLowerCase('ru').includes('доску ' + board.name.toLocaleLowerCase('ru'))) {
      const point = title.toLocaleLowerCase('ru').indexOf('доску ' + board.name.toLocaleLowerCase('ru'));
      title = title.slice(0,point).replace(/\s+(?:на|в)\s*$/,'') +
        title.slice(point + 6 + board.name.length);
    }
    const extracted = parseQuick(title);
    return {action:'create', title:extracted.title, deadline:extracted.deadline,
      priority:extracted.priority, board:board?.name || ''};
  }
  const done = query.match(/^(?:заверши|закрой|отметь выполненной|выполни|complete)\s+(?:задачу\s+)?(.+)$/i);
  if (done) return {action:'complete', task:done[1]};
  return null;
}

function comradeModelContext() {
  return JSON.stringify({
    today: todayISO(),
    boards:state.boards.slice(0,16).map(b => ({name:b.name,columns:b.columns.map(c => c.title)})),
    tasks:comradeTasks().slice(0,25).map(t => ({
      title:t.title.slice(0,100), board:state.boards.find(b => b.id === t.boardId)?.name || '',
      deadline:t.deadline,
      column:state.boards.find(b => b.id === t.boardId)?.columns.find(c => c.id === t.columnId)?.title || ''
    }))
  }).slice(0,4800);
}

async function comradeSend() {
  if (comradeBusy) return;
  const box = comradeEl('comradeInput');
  const question = box.value.trim().slice(0,800);
  if (!question) return;
  box.value='';
  comradeLog(question,true);
  const direct = comradeBasic(question);
  if (direct) { await comradeApply(direct,question); return; }
  comradeQuestion = question;
  comradeBusySet(true);
  const id = ++comradeRequestId;
  if (!comradeNative('infer',{requestId:id,text:question,context:comradeModelContext()})) {
    comradeBusySet(false);
    comradeLog('Локальная LLM доступна только в Android APK. Простые задачи работают без модели.');
  }
}

window.kanbanAssistantReceive = async function(payload) {
  let data;
  try { data=typeof payload==='string' ? JSON.parse(payload) : payload; } catch(_) { return; }
  if (!data || typeof data!=='object') return;
  if (data.type==='status' || data.type==='model') {
    comradeEl('comradeModelName').textContent = data.name || 'Модель не выбрана';
    if (data.text) comradeLog(data.text);
    return;
  }
  if (data.type!=='result' || data.requestId!==comradeRequestId) return;
  comradeBusySet(false);
  if (data.error) { comradeLog(data.error); return; }
  const reply = String(data.text || '').slice(0,4500);
  let plan;
  try {
    const clean = reply.replace(/<think>[\s\S]*?<\/think>/g,'').trim();
    const braces = clean.match(/\{[\s\S]*\}/);
    plan = JSON.parse(braces ? braces[0] : clean);
  } catch(_) { comradeLog(reply || 'Ответ модели пуст.'); return; }
  await comradeApply(plan,comradeQuestion);
};

function comradeBind() {
  const panel=comradeEl('comradePanel');
  if (!panel) return;
  comradeEl('comradeOpen').onclick=()=>{
    panel.hidden=false;
    comradeEl('comradeInput').focus();
    comradeNative('status');
  };
  comradeEl('comradeClose').onclick=()=>{
    panel.hidden=true;
    comradeRequestId++;
    comradeBusySet(false);
    comradeNative('release');
  };
  comradeEl('comradeChooseModel').onclick=()=>{
    if (!comradeNative('choose_model')) comradeLog('Выбор GGUF доступен в Android-приложении.');
  };
  comradeEl('comradeSend').onclick=()=>{void comradeSend();};
  comradeEl('comradeInput').onkeydown=e=>{
    if (e.key==='Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault(); void comradeSend();
    }
  };
}

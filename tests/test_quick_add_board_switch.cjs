// Exercise quick-add completion after real board navigation while storage is pending.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = fs.readFileSync('app/src/main/js-src/core.js', 'utf8');
const interactions = fs.readFileSync('app/src/main/js-src/interactions.js', 'utf8');
const views = fs.readFileSync('app/src/main/js-src/views.js', 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = end ? source.indexOf(end, from) : source.length;
  assert(from >= 0 && to > from);
  return source.slice(from, to);
}

function fixture() {
  const boards = [
    { id: 'a', name: 'Quality', columns: [{ id: 'todo-a', isDone: false }] },
    { id: 'b', name: 'Work', columns: [{ id: 'todo-b', isDone: false }] }
  ];
  const existing = { id: 'existing', boardId: 'b', columnId: 'todo-b', title: 'Existing', tags: [] };
  const state = { boards, activeBoardId: 'a', _tasksByBoard: { a: [], b: [existing] } };
  let finish;
  let reject;
  const stored = [];
  const toasts = [];
  const ctx = { state, Date, console,
    getActiveBoard: () => boards.find(b => b.id === state.activeBoardId),
    getBoard: id => boards.find(b => b.id === id),
    $: selector => selector === '#boardSelect' ? null : ({ classList: { contains: () => false } }),
    updateBoardSelect() {}, dbPutSettingsBulk: async () => {},
    renderBoard() {}, saveUIState() {}, notifyOtherTabs() {},
    showToast: text => toasts.push(text),
    generateId: () => 'new-task', topOrder: () => -1,
    PRIORITY_LABELS: { none: 'None', high: 'High' }, DATE_RE: /^\d{4}-\d{2}-\d{2}$/,
    dbPutTask: task => new Promise((resolve, fail) => {
      finish = () => { stored.push(structuredClone(task)); resolve(); };
      reject = () => fail(new Error('disk full'));
    })
  };
  vm.createContext(ctx);
  vm.runInContext(section(core, 'function sanitizeTask(', 'function sanitizeColumn('), ctx);
  vm.runInContext(section(core, 'function applyActiveBoard()', 'async function addBoard('), ctx);
  vm.runInContext(section(interactions, 'function parseQuick('), ctx);
  vm.runInContext(section(views, '// GLOBAL SEARCH', 'function updateGlobalSearchBoardFilter()'), ctx);
  ctx.applyActiveBoard();
  return { ctx, state, stored, toasts, finish: () => finish(), reject: () => reject() };
}

(async () => {
  for (const navigate of [false, true]) {
    const f = fixture();
    const saving = f.ctx.quickAddTask('Inspect battery #qc !h');
    if (navigate) await f.ctx.switchBoard('b');
    f.finish();
    assert.equal(await saving, true);
    assert.equal(f.state._tasksByBoard.a.length, 1, 'Save must update the board where quick-add began');
    assert.equal(f.state._tasksByBoard.b.length, 1, 'Navigation must not copy the new task onto the selected board');
    assert.equal(f.state._tasksByBoard.a[0].boardId, 'a');
    assert.equal(f.state._tasksByBoard.a[0].columnId, 'todo-a');
    assert.equal(f.state._tasksByBoard.a[0].priority, 'high');
    assert.deepEqual(Array.from(f.state._tasksByBoard.a[0].tags), ['qc']);
    assert.deepEqual(f.stored[0], structuredClone(f.state._tasksByBoard.a[0]));
    assert.equal(f.ctx.searchAllBoards('Inspect battery').total, 1, 'Cross-board search must find the saved task exactly once');
    assert.equal(f.toasts.at(-1), 'Добавлено в «Quality»', 'Confirmation must name the actual destination');
    assert.equal(f.state.activeBoardId, navigate ? 'b' : 'a', 'Saving must preserve navigation');
    assert.equal(f.state.tasks, f.state._tasksByBoard[f.state.activeBoardId]);
  }
  const f = fixture();
  const saving = f.ctx.quickAddTask('Inspect battery');
  await f.ctx.switchBoard('b');
  f.reject();
  assert.equal(await saving, false);
  assert.equal(f.state._tasksByBoard.a.length, 0);
  assert.equal(f.state._tasksByBoard.b.length, 1);
  assert.equal(f.stored.length, 0, 'Failed storage must leave both boards unchanged');
  assert(f.toasts.at(-1).includes('disk full'));
  console.log('Quick-add: pending board switch, search uniqueness, destination, navigation and failure rollback passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

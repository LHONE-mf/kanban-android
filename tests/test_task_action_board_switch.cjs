// Task actions must finish on their source board when navigation overlaps storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(from >= 0 && to > from);
  return source.slice(from, to);
}

function fixture() {
  const root = { id: 'root', boardId: 'a', columnId: 'todo', parentId: '',
    title: 'Inspect', files: [], tags: ['qc'], checklist: [], reminder: '2026-11-12T09:00' };
  const child = { ...root, id: 'child', parentId: 'root', title: 'Measure' };
  const other = { ...root, id: 'other', boardId: 'b', title: 'Other' };
  const state = { boards: [{ id: 'a' }, { id: 'b' }], activeBoardId: 'a', tasks: [root, child], _tasksByBoard: {} };
  state._tasksByBoard.a = state.tasks;
  state._tasksByBoard.b = [other];
  const stored = new Map([root, child, other].map(t => [t.id, structuredClone(t)]));
  const reminders = [], toasts = [], undos = [];
  let finish, reject, nextId = 0;
  function pending(commit) {
    return new Promise((resolve, fail) => {
      finish = () => { commit(); resolve(); };
      reject = () => fail(new Error('disk full'));
    });
  }
  const ctx = { state, Date, console,
    getBoard: id => state.boards.find(b => b.id === id),
    subtree: id => state.tasks.filter(t => t.parentId === id),
    dbDeleteTasks: ids => pending(() => ids.forEach(id => stored.delete(id))),
    dbPutTask: task => pending(() => stored.set(task.id, structuredClone(task))),
    dbPutTasks: async tasks => tasks.forEach(t => stored.set(t.id, structuredClone(t))),
    switchBoard: async id => {
      if (!state.boards.some(b => b.id === id)) return;
      state.activeBoardId = id; state.tasks = state._tasksByBoard[id];
    },
    syncNativeReminder: task => reminders.push(task),
    pushUndo: undo => { undos.push(undo); return undos.length; },
    scheduleMediaDelete() {}, cancelMediaDelete() {},
    renderBoard() {}, notifyOtherTabs() {}, closeModal() {},
    showToast: text => toasts.push(text), truncate: text => text,
    generateId: () => 'new-' + ++nextId
  };
  vm.createContext(ctx);
  vm.runInContext(section('async function deleteTask(', '// CROSS-BOARD TASK MOVE'), ctx);
  vm.runInContext(section('async function duplicateTask(', '// FOCUS TRAP'), ctx);
  return { ctx, state, root, child, other, stored, reminders, toasts, undos,
    finish: () => finish(), reject: () => reject() };
}

async function checkDelete() {
  const f = fixture();
  const deleting = f.ctx.deleteTask('root');
  await f.ctx.switchBoard('b');
  f.finish(); await deleting;
  assert.equal(f.state._tasksByBoard.a.length, 0, 'Pending deletion must remove the original subtree from search and source board');
  assert.deepEqual(f.state._tasksByBoard.b, [f.other]);
  assert.equal(f.state.activeBoardId, 'b');
  assert.equal(f.state.tasks, f.state._tasksByBoard.b);
  assert.deepEqual([...f.stored.keys()], ['other']);
  assert.equal(f.reminders.length, 2);
  assert(f.reminders.every(t => !t.reminder));
  assert.equal(await f.undos[0].restore(), true);
  assert.deepEqual(f.state._tasksByBoard.a, [f.root, f.child], 'Undo restores the source subtree once');
  assert.equal(f.stored.size, 3);
}

async function checkDuplicate() {
  const f = fixture();
  const copying = f.ctx.duplicateTask('root');
  await f.ctx.switchBoard('b');
  f.finish(); await copying;
  assert.equal(f.state._tasksByBoard.a.length, 3, 'Pending duplicate must appear on the original board');
  assert.deepEqual(f.state._tasksByBoard.b, [f.other]);
  const copy = f.state._tasksByBoard.a.at(-1);
  assert.equal(copy.boardId, 'a');
  assert.equal(copy.title, 'Inspect (копия)');
  assert.deepEqual(f.stored.get(copy.id), structuredClone(copy));
  assert.deepEqual(Array.from(copy.tags), ['qc']);
  assert.equal(f.state.activeBoardId, 'b');
}

async function checkFailure(action) {
  const f = fixture();
  const saving = f.ctx[action]('root');
  await f.ctx.switchBoard('b');
  f.reject(); await saving;
  assert.deepEqual(f.state._tasksByBoard.a, [f.root, f.child]);
  assert.deepEqual(f.state._tasksByBoard.b, [f.other]);
  assert.equal(f.stored.size, 3);
  assert.equal(f.reminders.length, 0);
  assert.equal(f.undos.length, 0);
  assert(f.toasts.at(-1).includes('disk full'));
}

async function checkRemovedBoardUndo() {
  const f = fixture();
  const deleting = f.ctx.deleteTask('root');
  f.finish(); await deleting;
  await f.ctx.switchBoard('b');
  f.state.boards = f.state.boards.filter(b => b.id !== 'a');
  delete f.state._tasksByBoard.a;
  assert.equal(await f.undos[0].restore(), false, 'Undo must refuse restoration into a removed board');
  assert.deepEqual([...f.stored.keys()], ['other'], 'Undo must not persist orphaned tasks');
  assert.deepEqual(f.state.tasks, [f.other], 'Undo must not place a deleted board subtree on the active board');
  assert.equal(f.reminders.length, 2, 'Undo must not reschedule reminders for a deleted board');
  assert(f.toasts.at(-1).includes('доска удалена'));
}

(async () => {
  const results = await Promise.allSettled([checkDelete(), checkDuplicate(),
    checkFailure('deleteTask'), checkFailure('duplicateTask'), checkRemovedBoardUndo()]);
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (errors.length) throw new AggregateError(errors, 'Pending task actions changed the wrong board');
  console.log('Task actions: pending delete/duplicate navigation, subtree undo, reminders and storage failure passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

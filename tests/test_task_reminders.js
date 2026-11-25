const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const js = fs.readFileSync('app/src/main/js-src/android-extras.js', 'utf8');
const start = js.indexOf('function taskReminderRows()');
const end = js.indexOf('// SERVICE WORKER', start);
const boards = ['a', 'b'].map(id => ({ id, columns: [{ id: 'todo' }, { id: 'done', isDone: true }] }));
const task = (id, columnId) => ({ id, columnId, title: 'Task ' + id, deadline: '2026-12-05', reminderTime: '09:30' });
const active = task('first', 'todo');
const due = task('second', 'todo');
const state = { boards, _tasksByBoard: { a: [active, task('completed', 'done')], b: [due] }, activeBoardId: 'a' };
state.tasks = state._tasksByBoard.a;
const sent = [], opens = [], messages = [];
const timers = new Map();
let serial = 0, taskModalOpen = true, discard = false;
const env = {
  state, window: {}, KanbanTaskReminders: { postMessage: raw => sent.push(JSON.parse(raw)) },
  setTimeout: (fn, delay) => { const key = { delay }; timers.set(key, fn); return key; },
  clearTimeout: key => timers.delete(key), generateId: () => 'reminder_' + ++serial,
  isValidISODate: value => value === '2026-12-05',
  savingTask: false, importInProgress: false, drag: null, switchingBoard: false, editingTaskId: 'draft',
  $: () => ({ classList: { contains: () => taskModalOpen } }),
  tryCloseTaskModal: async () => { if (discard) taskModalOpen = false; },
  switchBoard: async id => { state.activeBoardId = id; state.tasks = state._tasksByBoard[id]; taskModalOpen = false; return true; },
  switchView: () => {}, openTaskModal: id => opens.push(id), showToast: text => messages.push(text)
};
vm.createContext(env);
vm.runInContext(js.slice(start, end) + '\nreminderUiReady = true;', env);
function flush() {
  const key = [...timers.keys()].find(key => key.delay === 0);
  assert.ok(key);
  const run = timers.get(key); timers.delete(key); run();
}
function ack(id = sent.at(-1).id) { env.window.kanbanTaskRemindersResult(JSON.stringify({ id, ok: true })); }

(async () => {
  env.queueTaskReminders();
  env.queueTaskReminders(true);
  flush();
  assert.equal(sent[0].askPermission, true);
  assert.deepEqual(sent[0].rows.map(row => row.task), ['first', 'second']);
  active.columnId = 'done';
  env.queueTaskReminders();
  ack('stale');
  assert.equal(sent.length, 1);
  ack();
  flush();
  assert.deepEqual(sent[1].rows.map(row => row.task), ['second']);
  state._tasksByBoard.b.length = 0;
  env.queueTaskReminders();
  ack();
  flush();
  assert.deepEqual(sent[2].rows, []);
  ack();

  env.window.kanbanOpenReminder(JSON.stringify({ board: 'b', task: 'second' }));
  assert.match(messages.at(-1), /удалена/);
  assert.deepEqual(opens, []);
  active.columnId = 'todo';
  env.window.kanbanOpenReminder(JSON.stringify({ board: 'a', task: 'first' }));
  await new Promise(setImmediate);
  assert.deepEqual(opens, [], 'a dirty editor can keep its draft');
  discard = true;
  env.window.kanbanOpenReminder(JSON.stringify({ board: 'a', task: 'first' }));
  await new Promise(setImmediate);
  assert.deepEqual(opens, ['first']);
  state._tasksByBoard.b.push(due);
  env.window.kanbanOpenReminder(JSON.stringify({ board: 'b', task: 'second' }));
  await new Promise(setImmediate);
  assert.equal(state.activeBoardId, 'b');
  assert.deepEqual(opens, ['first', 'second']);
  console.log('Task reminders: cross-board scheduling, deletion, completion and safe opening verified.');
})().catch(error => { console.error(error); process.exitCode = 1; });

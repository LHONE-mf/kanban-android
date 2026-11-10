// Board removal must commit its settings and task deletions together.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = fs.readFileSync('app/src/main/js-src/core.js', 'utf8');
const dialogs = fs.readFileSync('app/src/main/js-src/media-dialogs.js', 'utf8');
const deletion = core.slice(core.indexOf('async function deleteBoard('), core.indexOf('// UTILITIES'));
const save = dialogs.slice(dialogs.indexOf('async function dbSaveBoardAndTasks('), dialogs.indexOf('async function saveSettingsFromModal('));

function fixture({ fail = '', active = 'b1', empty = false, approved = true } = {}) {
  const boards = ['b1', 'b2'].map(id => ({ id, name: id, columns: [] }));
  const task = { id: 't1', boardId: 'b1', files: [{ id: 'photo' }], reminder: '2026-12-01T10:00' };
  const nested = { id: 'child', boardId: 'b1', parentId: 't1', files: [], reminder: '' };
  const other = { id: 't2', boardId: 'b2', files: [], reminder: '' };
  const state = { boards, activeBoardId: active, _tasksByBoard: { b1: empty ? [] : [task, nested], b2: [other] } };
  state.tasks = state._tasksByBoard[active];
  let persisted = { tasks: { t2: other }, settings: { boards, activeBoardId: active } };
  if (!empty) Object.assign(persisted.tasks, { t1: task, child: nested });
  persisted = structuredClone(persisted);
  const before = JSON.stringify(state), storedBefore = JSON.stringify(persisted);
  const effects = [], transactions = [], toasts = [];
  // A transaction-scoped fake tests orchestration; Chromium checks real rollback separately.
  const db = { transaction(stores) {
    const draft = structuredClone(persisted);
    const names = Array.isArray(stores) ? [...stores] : [stores];
    transactions.push(names);
    let aborted = false;
    const tx = {
      abort() { aborted = true; },
      objectStore(name) {
        assert(names.includes(name), 'Writes must belong to the declared transaction');
        return {
          delete(id) { delete draft[name][id]; },
          put(record) {
            if (name === 'settings' && fail === 'sync') throw Error('settings clone failed');
            draft[name][record.key || record.id] = structuredClone(record.value ?? record);
          }
        };
      }
    };
    setImmediate(() => {
      if (names.includes('settings') && fail === 'abort') {
        aborted = true; tx.error = Error('settings write failed');
      }
      if (aborted) tx.onabort?.();
      else { persisted = draft; effects.push('commit'); tx.oncomplete?.(); }
    });
    return tx;
  } };
  const ctx = { state, db, STORE_TASKS: 'tasks', STORE_SETTINGS: 'settings',
    getBoard: id => state.boards.find(b => b.id === id),
    confirmDialog: async () => approved, wrapTxError: e => e || Error('aborted'),
    // Use the production helpers even for the pre-fix two-transaction path.
    syncNativeReminder: t => effects.push('cancel:' + t.id),
    scheduleMediaDelete: id => effects.push('media:' + id),
    closeModal: id => effects.push('close:' + id),
    applyActiveBoard: () => { state.tasks = state._tasksByBoard[state.activeBoardId]; },
    renderBoard: () => effects.push('render'), saveUIState: () => {}, notifyOtherTabs: () => {},
    showToast: text => toasts.push(text)
  };
  vm.createContext(ctx);
  const deleteTasks = core.slice(core.indexOf('async function dbDeleteTasks('), core.indexOf('async function dbGetSettings('));
  const settings = core.slice(core.indexOf('async function dbPutSettingsBulk('), core.indexOf('async function dbClearActiveBoardTasks('));
  vm.runInContext(deletion + save + deleteTasks + settings + '\nasync function persistBoards() { await dbPutSettingsBulk([["boards", state.boards], ["activeBoardId", state.activeBoardId]]); }', ctx);
  return { ctx, state, before, storedBefore, effects, transactions, toasts, stored: () => persisted };
}

(async () => {
  for (const fail of ['abort', 'sync']) {
    const f = fixture({ fail });
    await f.ctx.deleteBoard('b1');
    await new Promise(setImmediate);
    assert.equal(JSON.stringify(f.stored()), f.storedBefore,
      'Failed settings write must preserve every persisted task and board: ' + fail);
    assert.equal(JSON.stringify(f.state), f.before, 'Failed deletion must preserve visible data');
    assert.deepEqual(f.effects, [], 'Failed deletion must not cancel alarms, delete media or close settings');
    assert(f.toasts.some(text => text.includes('Ошибка удаления')));
  }
  for (const active of ['b1', 'b2']) {
    const f = fixture({ active });
    await f.ctx.deleteBoard('b1');
    assert.deepEqual(f.transactions, [['tasks', 'settings']], 'One transaction for the whole removal');
    assert.deepEqual(Object.keys(f.stored().tasks), ['t2'], 'Remove nested tasks but keep other boards');
    assert.equal(f.stored().settings.boards.length, 1);
    assert.equal(f.stored().settings.activeBoardId, 'b2');
    assert.equal(f.state.activeBoardId, 'b2');
    assert.equal(f.state.tasks[0].id, 't2');
    assert.equal(f.state._tasksByBoard.b1, undefined);
    assert.deepEqual(f.effects.slice(0, 4), ['commit', 'cancel:t1', 'media:photo', 'cancel:child'],
      'Cancel reminders and clean attachments only after commit');
    assert(f.effects.includes('close:settingsModal'), 'Dismiss stale settings after successful deletion');
  }
  const empty = fixture({ empty: true });
  await empty.ctx.deleteBoard('b1');
  assert.equal(empty.stored().settings.boards.length, 1, 'Empty boards can still be removed');
  for (const [options, id] of [[{ approved: false }, 'b1'], [{}, 'missing']]) {
    const f = fixture(options);
    await f.ctx.deleteBoard(id);
    assert.equal(JSON.stringify(f.stored()), f.storedBefore, 'Cancelled/invalid removal must preserve data');
    assert.deepEqual(f.transactions, []);
  }
  const last = fixture();
  last.state.boards.pop();
  await last.ctx.deleteBoard('b1');
  assert.deepEqual(last.transactions, [], 'Never delete the last board');
  console.log('Board deletion: atomic commit, failed-write rollback, nested tasks, media, reminders and cancellation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

// A pending attachment save must retain its editor/board until the write commits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const tasks = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
const core = fs.readFileSync('app/src/main/js-src/core.js', 'utf8');
const extras = fs.readFileSync('app/src/main/js-src/android-extras.js', 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(from >= 0 && to > from, 'Missing source section: ' + start);
  return source.slice(from, to);
}
const saveSource = section(tasks, 'let savingTask = false;', 'async function duplicateTask(');
const boardSource = section(core, 'async function switchBoard(', 'async function addBoard(');
const notificationSource = section(extras, '// Notification taps may arrive', '// ============================================================\n// INIT');

function fixture() {
  const boards = [{id: 'a', name: 'First'}, {id: 'b', name: 'Second'}];
  const other = {id: 'other', boardId: 'b', title: 'Other task'};
  const state = {boards, activeBoardId: 'a', _tasksByBoard: {a: [], b: [other]}};
  state.tasks = state._tasksByBoard.a;
  const inputs = Object.fromEntries([
    ['taskTitle','New task'], ['taskDeadline',''], ['taskReminder',''], ['taskReminderRepeat','none'],
    ['taskRepeat','none'], ['taskTags',''], ['taskParent','col:todo'], ['taskDesc','Notes']
  ].map(([id,value]) => [id,{value,focus(){}}]));
  for (const id of ['taskTitleError','taskDeadlineError','taskReminderError'])
    inputs[id] = {hidden: true};
  const modal = {open: true, classList: {
    contains: name => name === 'open' && modal.open,
    remove: name => {if (name === 'open') modal.open = false}
  }};
  inputs.taskModal = modal;
  inputs.mediaPreview = {querySelectorAll: () => []};
  const writes = [], opened = [], toasts = [];
  let releaseFile;
  let fileCount = 0;
  const firstFile = new Promise(resolve => {releaseFile = resolve});
  const ctx = {
    window: {}, console, Date, Math,
    state, editingTaskId: null, newFiles: [
      {name:'a.jpg',size:123}, {name:'b.jpg',size:456}
    ], tempFiles: [], tempChecklist: [], editingPriority: 'none',
    modalInitialSnapshot: null, lastFocusBeforeModal: null, rec: {mr: null},
    $: selector => inputs[selector.slice(1)],
    isValidISODate: () => true, computeCompletedAt: () => null,
    generateId: () => 'created',
    storeFile: async file => {
      if (++fileCount === 1) await firstFile;
      return {id:'media-' + fileCount, name:file.name, size:file.size};
    },
    mediaDelete: async () => {},
    persistTaskChanges: async candidates => {
      writes.push(...candidates);
      state.tasks.push(...candidates);
    },
    syncKids: async () => {}, notifyOtherTabs() {}, renderBoard() {}, saveUIState() {},
    getBoard: id => boards.find(b => b.id === id),
    applyActiveBoard: () => {state.tasks = state._tasksByBoard[state.activeBoardId]},
    persistBoards: async () => {},
    showToast: text => toasts.push(text),
    releaseFocusTrap() {}, recAbort() {}, apStop() {}, revokeTrackedURL() {},
    confirmDialog: async () => true,
    switchView() {}, openTaskModal: taskId => {opened.push(taskId);modal.open = true},
    captureModalSnapshot: () => '',
    isModalDirty: () => false
  };
  vm.createContext(ctx);
  vm.runInContext(saveSource + '\n' + boardSource + '\n' + notificationSource, ctx);
  vm.runInContext('notificationUiReady = true', ctx);
  return {ctx, state, modal, writes, opened, toasts, releaseFile};
}

(async () => {
  const f = fixture();
  const pendingSave = f.ctx.saveTaskFromModal();
  assert.equal(f.writes.length, 0, 'Attachments must finish before storing the task');

  await f.ctx.switchBoard('b');
  assert.equal(f.state.activeBoardId, 'a', 'Board navigation must not switch during a pending save');
  f.ctx.closeModal('taskModal');
  assert.equal(f.modal.open, true, 'Closing the editor during a save must be refused');

  f.ctx.window.__kanbanNotificationPending = {taskId:'other', boardId:'b'};
  await f.ctx.window.kanbanApplyPendingNotification();
  assert(f.ctx.window.__kanbanNotificationPending, 'Notification must remain queued until the save completes');
  assert.equal(f.opened.length, 0, 'Notification must not replace the editor while saving');

  f.releaseFile();
  await pendingSave;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.length, 1, 'Create only one task');
  assert.equal(f.writes[0].boardId, 'a', 'Task belongs to its source board');
  assert.deepEqual(Array.from(f.writes[0].files, x => x.id), ['media-1','media-2']);
  assert.equal(f.state._tasksByBoard.a.length, 1, 'Task is saved to the source board');
  assert.equal(f.state._tasksByBoard.b.length, 1, 'Target board stays unchanged');
  assert.equal(f.state.activeBoardId, 'b', 'Queued notification should navigate after successful save');
  assert.deepEqual(f.opened, ['other'], 'Queued notification opens the intended task once');

  console.log('Pending task save: attachment isolation, board lock and deferred notification passed');
})().catch(error => {console.error(error); process.exitCode = 1});

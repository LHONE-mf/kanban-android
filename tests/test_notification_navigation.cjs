// Fast, offline regression tests for native reminder payload and task deep-link navigation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const taskJs = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
const extrasJs = fs.readFileSync('app/src/main/js-src/android-extras.js', 'utf8');
const native = fs.readFileSync('app/src/main/java/com/kanban/offline/KanbanReminders.kt', 'utf8');
const activity = fs.readFileSync('app/src/main/java/com/kanban/offline/MainActivity.kt', 'utf8');
const manifest = fs.readFileSync('app/src/main/AndroidManifest.xml', 'utf8');
const html = fs.readFileSync('app/src/main/assets/kanban.html', 'utf8');

const start = extrasJs.indexOf('// Notification taps may arrive');
const end = extrasJs.indexOf('// ============================================================\n// INIT', start);
assert(start !== -1 && end > start, 'Missing notification navigation function');
const events = [], toasts = [];
const taskModal = {classList:{open:false,contains(name){return this.open && name === 'open'}}};
const state = {
  activeBoardId:'first',
  boards:[{id:'first',name:'Home'},{id:'second',name:'Production'}],
  _tasksByBoard:{first:[],second:[{id:'target',title:'Check oven'}]}
};
let dirty = false, allowDiscard = true;
const context = {
  state,
  window:{},
  $:selector => selector === '#taskModal' ? taskModal : null,
  isModalDirty:()=>dirty,
  confirmDialog:async()=>allowDiscard,
  closeModal:id=>{events.push('close:'+id);taskModal.classList.open=false},
  switchBoard:async id=>{events.push('board:'+id);state.activeBoardId=id},
  switchView:view=>events.push('view:'+view),
  openTaskModal:id=>events.push('task:'+id),
  showToast:message=>toasts.push(message)
};
vm.createContext(context);
vm.runInContext(extrasJs.slice(start,end),context);

(async()=>{
  // Cold start: the notification arrives before IndexedDB has loaded.
  context.window.__kanbanNotificationPending={boardId:'second',taskId:'target'};
  await context.window.kanbanApplyPendingNotification();
  assert.deepEqual(events,[],'Navigation must wait until app data is ready');
  vm.runInContext('notificationUiReady = true',context);
  await context.window.kanbanApplyPendingNotification();
  assert.deepEqual(events,['board:second','view:kanban','task:target']);
  assert.equal(context.window.__kanbanNotificationPending,undefined);

  // Warm start: opening another notification switches boards again.
  events.length=0;
  state.activeBoardId='second';
  state._tasksByBoard.first=[{id:'moved',title:'Moved task'}];
  context.window.__kanbanNotificationPending={boardId:'second',taskId:'moved'};
  await context.window.kanbanApplyPendingNotification();
  assert.deepEqual(events,['board:first','view:kanban','task:moved']);

  // Existing unsaved task editing must not be discarded without confirmation.
  events.length=0; dirty=true; allowDiscard=false;
  taskModal.classList.open=true;
  context.window.__kanbanNotificationPending={boardId:'second',taskId:'target'};
  await context.window.kanbanApplyPendingNotification();
  assert.deepEqual(events,[],'Declined navigation must preserve unsaved edits');
  assert.equal(taskModal.classList.open,true);

  // Missing tasks should not navigate to an unrelated task.
  dirty=false; taskModal.classList.open=false; events.length=0;
  context.window.__kanbanNotificationPending={boardId:'second',taskId:'deleted'};
  await context.window.kanbanApplyPendingNotification();
  assert.deepEqual(events,[]);
  assert(toasts.at(-1).includes('не найдена'));

  // The browser-to-native reminder message must include an actual board id/name.
  const sent=[];
  const payloadCtx={
    window:{KanbanReminders:{postMessage:raw=>sent.push(JSON.parse(raw))}},
    state:{boards:[{id:'second',name:'Production'}]},
    getBoard:id=>id==='second'?{id,name:'Production'}:null,
    Date,Number,JSON
  };
  vm.createContext(payloadCtx);
  vm.runInContext(taskJs.slice(0,taskJs.indexOf('// ============================================================\n// TASK OPS')),payloadCtx);
  vm.runInContext('syncNativeReminder',payloadCtx)({
    id:'target',title:'Check oven',boardId:'second',
    reminder:'2026-11-12T09:30:00',reminderRepeat:'weekly'
  });
  assert.equal(sent.length,1);
  assert.equal(sent[0].boardId,'second');
  assert.equal(sent[0].boardName,'Production');
  assert.equal(sent[0].title,'Check oven');

  assert(native.includes('EXTRA_TASK_ID') && native.includes('EXTRA_BOARD_ID'));
  assert(native.includes('PendingIntent.getActivity') && native.includes('Notification.BigTextStyle'));
  assert(native.includes('ReminderNotificationText.summary'));
  assert(activity.includes('override fun onNewIntent(intent: Intent)'));
  assert(activity.includes('deliverNotificationTask()'));
  assert(manifest.includes('android:launchMode="singleTop"'));
  const csvButton = html.indexOf('id="exportCsvBtn"');
  const headerEnd = html.indexOf('</header>');
  const settingsStart = html.indexOf('id="settingsModal"');
  assert(csvButton > headerEnd && csvButton > settingsStart,
    'CSV export should remain accessible only inside settings');
  console.log('Native reminder task routing, metadata, draft safety and CSV settings: passed');
})().catch(error=>{console.error(error);process.exitCode=1});

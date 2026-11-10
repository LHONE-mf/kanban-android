// Regression for durable Android notification completion, applied to IndexedDB on app resume.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/android-extras.js', 'utf8');
const start = source.indexOf('// Native Mark Done notifications');
const end = source.indexOf('// Notification taps may arrive', start);
assert(start >= 0 && end > start, 'Mark Done action reconciliation section missing');

const parent = {id:'p',boardId:'b2',columnId:'todo2',parentId:'',title:'Parent',
  completedAt:null,reminder:'2027-01-01T09:00',updatedAt:12};
const child = {id:'c',boardId:'b2',columnId:'todo2',parentId:'p',title:'Child',
  completedAt:null,reminder:'',updatedAt:13};
const state={boards:[
  {id:'b1',name:'Personal',columns:[{id:'todo1',isDone:false},{id:'done1',isDone:true}]},
  {id:'b2',name:'Work',columns:[{id:'todo2',isDone:false},{id:'done2',isDone:true}]},
  {id:'b3',name:'No Done',columns:[{id:'todo3',isDone:false}]}
],activeBoardId:'b1',_tasksByBoard:{b1:[],b2:[parent,child],b3:[
  {id:'noDone',boardId:'b3',columnId:'todo3',parentId:'',title:'No done column',completedAt:null}
]}};
state.tasks=state._tasksByBoard.b1;
const messageLog=[],persisted=[],toasts=[],syncs=[];
let modalOpen=false, fail=false, updated=0;
const ctx={state,window:{KanbanTaskActions:{postMessage:raw=>messageLog.push(JSON.parse(raw))}},
  Date,Math,console,
  $:()=>({classList:{contains:()=>modalOpen}}),
  dbPutTasks:async tasks=>{if(fail)throw Error('disk full');persisted.push(tasks)},
  syncNativeReminder:t=>syncs.push(t.id),
  renderBoard:()=>{updated++},notifyOtherTabs:()=>{},showToast:s=>toasts.push(s)};
vm.createContext(ctx);
vm.runInContext(source.slice(start,end),ctx);
const send=async actions=>vm.runInContext('window.kanbanReceiveTaskActions',ctx)(JSON.stringify(actions));
const action=(taskId,token='nonce')=>({action:'complete',taskId,token,boardId:'b2'});
(async()=>{
  // Requests only after IndexedDB is ready.
  ctx.window.kanbanRequestPendingActions();
  assert.deepEqual(messageLog,[],'No native pull before app loads');
  vm.runInContext('taskActionUiReady = true',ctx);
  ctx.window.kanbanRequestPendingActions();
  assert.deepEqual(messageLog,[{op:'list'}]);

  await send([action('p')]);
  assert.equal(persisted.length,1);
  assert.equal(persisted[0].length,2,'Completing parent moves nested children atomically');
  assert.equal(state._tasksByBoard.b2[0].columnId,'done2');
  assert.equal(state._tasksByBoard.b2[1].columnId,'done2');
  assert(state._tasksByBoard.b2[0].completedAt>0);
  assert.deepEqual(syncs,['p','c'],'Both changed task reminders are reconciled');
  assert.deepEqual(messageLog.at(-1),{op:'ack',taskId:'p',token:'nonce'});
  assert.equal(updated,1,'Refresh board after committed database update');

  await send([action('p','again')]);
  assert.equal(persisted.length,1,'Repeat delivery is idempotent');
  assert.deepEqual(messageLog.at(-1),{op:'ack',taskId:'p',token:'again'});

  await send([action('deleted','lost')]);
  assert.deepEqual(messageLog.at(-1),{op:'ack',taskId:'deleted',token:'lost'});
  assert.equal(persisted.length,1,'Missing task must not create a phantom record');

  const other=state._tasksByBoard.b3[0];
  await send([action('noDone','noColumn')]);
  assert.equal(other.columnId,'todo3');
  assert(!messageLog.some(m=>m.op==='ack'&&m.token==='noColumn'),
    'No done column should retain the pending action');
  assert(toasts.some(t=>t.includes('Готово')));

  // A failed IndexedDB write must not mutate JS state or acknowledge the native action.
  const blocked={id:'blocked',boardId:'b2',parentId:'',columnId:'todo2',title:'Blocked',completedAt:null};
  state._tasksByBoard.b2.push(blocked);
  fail=true;
  await send([action('blocked','dbFail')]);
  assert.equal(blocked.columnId,'todo2');
  assert(!messageLog.some(m=>m.op==='ack'&&m.token==='dbFail'));
  assert(toasts.some(t=>t.includes('disk full')));

  // Do not overwrite an in-progress task edit; preserve the durable action for later.
  fail=false;modalOpen=true;
  await send([action('blocked','editorOpen')]);
  assert.equal(blocked.columnId,'todo2');
  assert(!messageLog.some(m=>m.op==='ack'&&m.token==='editorOpen'));
  modalOpen=false;
  await send([action('blocked','editorOpen')]);
  assert.equal(state._tasksByBoard.b2.at(-1).columnId,'done2');
  assert.deepEqual(messageLog.at(-1),{op:'ack',taskId:'blocked',token:'editorOpen'});
  console.log('Mark Done: cross-board completion, children, idempotency, missing task, storage error and open editor: passed');
})().catch(err=>{console.error(err);process.exitCode=1});

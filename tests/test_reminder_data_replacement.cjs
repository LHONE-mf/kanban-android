// Removing/replacing Kanban tasks must reconcile native reminders only after DB commit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/data-transfer.js','utf8');
const from = source.indexOf('async function handleImport(');
const to = source.indexOf('// ============================================================\n// CLEAR',from);
const clearEnd = source.indexOf('\n}',to);
assert(from>=0 && to>from && clearEnd>to);
const oldTasks=[
  {id:'old',boardId:'b1',title:'Old',files:[],reminder:'2026-12-01T10:00'},
  {id:'other',boardId:'b2',title:'Other',files:[],reminder:'2026-12-02T10:00'}
];
const state={
  boards:[{id:'b1',name:'Original'},{id:'b2',name:'Other'}],
  _tasksByBoard:{b1:[oldTasks[0]],b2:[oldTasks[1]]},
  activeBoardId:'b1',boardName:'Original',tasks:[oldTasks[0]]
};
let fail=false,approved=true;
const events=[], toasts=[];
const imported={id:'new',boardId:'b3',title:'Imported',files:[],reminder:'2026-12-03T10:00'};
const context={
  state,JSON,console,undoStack:[],pendingMediaDeletes:new Map(),thumbCache:new Map(),
  buildImportPlan:async()=>({
    boards:[{id:'b3',name:'Imported board'}],activeBoardId:'b3',
    tasks:[imported],media:{},japanese:{},report:{warnings:[]}
  }),
  confirmDialog:async()=>approved,
  dbReplaceAll:async()=>{if(fail)throw Error('write error');events.push('db replace')},
  dbClearActiveBoardTasks:async()=>{if(fail)throw Error('write error');events.push('db clear')},
  syncNativeReminder:task=>events.push((task.reminder?'schedule ':'cancel ')+task.id),
  rebucket:(tasks,boards,activeId)=>{state.boards=boards;state.activeBoardId=activeId;state._tasksByBoard={b3:tasks};state.tasks=tasks},
  applyActiveBoard:()=>{},renderBoard:()=>{},saveUIState:()=>{},
  showToast:message=>toasts.push(message),alert:message=>toasts.push(message),
  apStop:()=>{},thumbCache:{clear(){}},pendingMediaDeletes:{values(){return []},clear(){}},
  scheduleMediaDelete:()=>{},notifyOtherTabs:()=>{}
};
vm.createContext(context);
vm.runInContext(source.slice(from,clearEnd+2),context);
(async()=>{
  fail=true;
  await context.handleImport({text:async()=>'{}'});
  assert.deepEqual(events,[],'Failed import must not cancel existing reminders');
  fail=false;approved=false;
  await context.handleImport({text:async()=>'{}'});
  assert.deepEqual(events,[],'Cancelled import must not change reminders');
  approved=true;
  await context.handleImport({text:async()=>'{}'});
  assert.deepEqual(events,['db replace','cancel old','cancel other','schedule new'],
    'Replace only after successful DB commit, then restore imported reminder');

  events.length=0;state.activeBoardId='b3';state.tasks=[imported];
  state._tasksByBoard={b3:state.tasks};
  fail=true;
  await context.clearActiveBoard();
  assert.deepEqual(events,[],'Failed board clear must not cancel alarms');
  fail=false;
  await context.clearActiveBoard();
  assert.deepEqual(events,['db clear','cancel new'],
    'Board clear must cancel reminder after successful DB deletion');
  assert.equal(state.tasks.length,0);
  console.log('Native reminder cancellation after board clear / backup replacement: passed');
})().catch(e=>{console.error(e);process.exitCode=1});

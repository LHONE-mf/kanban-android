// Saved board renames must refresh queued Android notification metadata only
// after the IndexedDB transaction succeeds, without changing the task data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync('app/src/main/js-src/media-dialogs.js','utf8');
const start=src.indexOf('async function saveSettingsFromModal()');
const end=src.indexOf('// ============================================================\n// CONFIRM MODAL',start);
assert(start>=0&&end>start,'Board settings save function not found');

const board={id:'board1',name:'Old board',columns:[{id:'todo',title:'To Do'}]};
const ready={id:'ready',boardId:'board1',title:'Task',reminder:'2026-12-10T09:00',completedAt:null};
const done={id:'done',boardId:'board1',title:'Completed',reminder:'2026-12-10T09:00',completedAt:42};
const without={id:'without',boardId:'board1',title:'No reminder',reminder:''};
const foreign={id:'foreign',boardId:'board2',title:'Other board',reminder:'2026-12-10T09:00'};
const state={boards:[board,{id:'board2',name:'Other',columns:[]}],activeBoardId:'board1',
  columns:board.columns,boardName:board.name,tasks:[ready,done,without],_tasksByBoard:{board1:[ready,done,without],board2:[foreign]}};
let fail=false;
const events=[],scheduled=[],toasts=[];
const field={value:'New board'};
const ctx={
  state,editingColumns:board.columns.map(c=>({...c})),JSON,console,
  $:sel=>sel==='#boardNameInput'?field:{},
  getActiveBoard:()=>board,
  sanitizeColumn:c=>c,
  applyColumnChange:()=>{throw Error('Unexpected column move')},
  dbSaveBoardAndTasks:async()=>{events.push('db'); if(fail)throw Error('disk full')},
  syncNativeReminder:t=>scheduled.push({id:t.id,boardName:state.boards.find(b=>b.id===t.boardId)?.name}),
  closeModal:()=>events.push('close'),
  updateBoardSelect:()=>{},notifyOtherTabs:()=>{},renderBoard:()=>{},
  showToast:message=>toasts.push(message)
};
vm.createContext(ctx);
vm.runInContext(src.slice(start,end),ctx);
(async()=>{
  fail=true;
  await ctx.saveSettingsFromModal();
  assert.equal(board.name,'Old board','Failed save must roll back board name');
  assert.deepEqual(scheduled,[],'Failed save must never update notifications');
  assert.deepEqual(events,['db']);
  assert(toasts.some(x=>x.includes('disk full')));

  events.length=0; fail=false;
  await ctx.saveSettingsFromModal();
  assert.equal(board.name,'New board');
  assert.deepEqual(events,['db','close'],'Notification refresh must happen after persistence');
  assert.deepEqual(scheduled,[
    {id:'ready',boardName:'New board'},
    {id:'done',boardName:'New board'}
  ],'Refresh both active and completed reminders, but not unrelated boards or tasks');
  assert.equal(ready.title,'Task','Renaming a board must not modify task content');
  console.log('Board rename reschedules native reminder metadata only after successful save: passed');
})().catch(error=>{console.error(error);process.exitCode=1});

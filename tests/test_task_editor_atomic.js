// C-03: a parent and every descendant must commit in a single transaction.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
const start = source.indexOf('async function _saveTask()');
const end = source.indexOf('\nfunction isModalDirty()', start);
assert.ok(start >= 0 && end > start);
const parent = { id:'p',boardId:'b',columnId:'todo',parentId:'',title:'Old',
  files:[],tags:[],checklist:[],order:0,createdAt:1 };
const child = { id:'c',boardId:'b',columnId:'todo',parentId:'p',title:'Child',
  files:[],tags:[],checklist:[],order:0,createdAt:1 };
const state = { tasks:[parent,child],activeBoardId:'b' };
const fields = { taskTitle:'New',taskParent:'col:progress',taskDeadline:'',taskDesc:'',taskTags:'' };
const result = { writes:[],closed:0,notices:[] };
let failWrite = true;
const context = {
  $:selector => ({value:fields[selector.slice(1)] || '',hidden:false,focus(){}}),
  state, editingTaskId:'p',editingPriority:'none',tempFiles:[],newFiles:[],tempChecklist:[],
  rec:{mr:null},isValidISODate:()=>true,subtree:id=>id==='p'?[state.tasks[1]]:[],
  applyColumnChange:(task,col)=>({...task,columnId:col}),computeCompletedAt:()=>null,
  dbPutTasks:async list=>{result.writes.push(list);if(failWrite)throw Error('disk');},
  showToast:s=>result.notices.push(s),mediaDelete:async()=>{},scheduleMediaDelete(){},
  closeModal:()=>result.closed++,notifyOtherTabs(){},renderBoard(){},Date,console
};
vm.createContext(context);
vm.runInContext(source.slice(start,end)+'\nthis.save=_saveTask;',context);
(async()=>{
  await context.save();
  assert.equal(result.writes.length,1);
  assert.equal(result.writes[0].length,2,'parent + child must be one IndexedDB operation');
  assert.equal(state.tasks[0],parent,'parent is unchanged on failed write');
  assert.equal(state.tasks[1],child,'child is unchanged on failed write');
  assert.equal(result.closed,0,'editor must remain open after storage failure');
  assert.ok(result.notices.some(s=>s.includes('Не удалось сохранить')));
  failWrite=false;
  await context.save();
  assert.equal(result.writes.length,2);
  assert.equal(state.tasks[0].columnId,'progress');
  assert.equal(state.tasks[1].columnId,'progress');
  assert.equal(result.closed,1);
  assert.ok(source.includes("if (savingTask) { showToast('Дождитесь сохранения задачи'); return; }"));
  console.log('Atomic editor-save and storage-failure regression passed');
})().catch(e=>{ console.error(e); process.exitCode=1; });

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
const result = { writes:[],closed:0,notices:[],partial:[],moved:[] };
let failWrite = true;
const context = {
  $:selector => ({value:fields[selector.slice(1)] || '',hidden:false,focus(){}}),
  state, editingTaskId:'p',editingPriority:'none',tempFiles:[],newFiles:[],tempChecklist:[],tempResults:[{id:'r1',text:'Measured result',createdAt:1,updatedAt:2}],
  rec:{mr:null},isValidISODate:()=>true,subtree:id=>id==='p'?[state.tasks[1]]:[],
  applyColumnChange:(task,col)=>({...task,columnId:col}),computeCompletedAt:()=>null,
  dbPutTasks:async list=>{result.writes.push(list);if(failWrite)throw Error('disk');},
  showToast:s=>result.notices.push(s),mediaDelete:async()=>{},scheduleMediaDelete(){},
  closeModal:()=>result.closed++,notifyOtherTabs(){},renderBoard(){},
  renderSavedTaskCard:(before,after)=>result.partial.push({before,after}),
  renderMovedTaskColumns:(columns,ids)=>result.moved.push({columns,ids}),Date,console,
  storeFile:async f=>({id:'file1',name:f.name,type:f.type,size:f.size,resultId:f._resultId})
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
  assert.equal(result.partial.length,0,'failed write cannot update any card');
  assert.equal(result.moved.length,0,'failed write cannot move any card');
  assert.ok(result.notices.some(s=>s.includes('Не удалось сохранить')));
  failWrite=false;
  context.tempResults.push({id:'r2',text:'',createdAt:3,updatedAt:3});
  context.newFiles.push({name:'report.pdf',type:'application/pdf',size:10,_resultId:'r2'});
  await context.save();
  assert.equal(result.writes.length,2);
  assert.equal(state.tasks[0].columnId,'progress');
  assert.equal(state.tasks[0].results[0].text,'Measured result','result saves on non-done column');
  assert.equal(state.tasks[0].results[1].id,'r2','file-only result survives save');
  assert.equal(state.tasks[0].files[0].resultId,'r2');
  assert.equal(state.tasks[1].columnId,'progress');
  assert.equal(result.closed,1);
  assert.equal(result.partial.length,0,'column change uses targeted move instead of edit refresh');
  assert.equal(result.moved.length,1,'successful save reconciles exactly two touched columns');
  assert.deepEqual(Array.from(result.moved[0].columns),['todo','progress']);
  assert.deepEqual(Array.from(result.moved[0].ids),['p']);
  assert.ok(source.includes("if (savingTask) { showToast('Дождитесь сохранения задачи'); return; }"));
  console.log('Atomic editor-save and storage-failure regression passed');
})().catch(e=>{ console.error(e); process.exitCode=1; });

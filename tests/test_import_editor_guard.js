// P7: import and task editor must never race a task-save or board change.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const trans = fs.readFileSync('app/src/main/js-src/data-transfer.js','utf8');
const tasks = fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
const begin = trans.indexOf('function restoreJapaneseImportSnapshot(');
const end = trans.indexOf('// ============================================================\n// CLEAR',begin);
const openStart = tasks.indexOf('function openTaskModal(');
const openEnd = tasks.indexOf('function setPriorityChips(',openStart);
const saveStart = tasks.indexOf('async function saveTaskFromModal()');
const saveEnd = tasks.indexOf('async function _saveTask()',saveStart);
assert.ok(begin>=0&&end>begin&&openStart>=0&&openEnd>openStart&&saveStart>=0&&saveEnd>saveStart);

function fixture({saveBusy=false,switchBusy=false,editorOpen=false,confirmDeferred=false,
  dbFailure=false}={}) {
  const state={boards:[{id:'old'}],activeBoardId:'old',_tasksByBoard:{old:[{id:'t1'}]}};
  let writes=0,saved=0,open=editorOpen,resolveConfirm,reads=0;
  const toasts=[],alerts=[];
  const ctx={
    state,console:{warn(){},error(){}},Date,JSON,Map,Set,Object,clearTimeout(){},
    savingTask:saveBusy,switchingBoard:switchBusy,
    $:s=>s==='#taskModal'?{classList:{contains:()=>open}}:null,
    showToast:message=>toasts.push(message),
    alert:message=>alerts.push(message),
    buildImportPlan:async()=>({boards:[{id:'new'}],tasks:[{id:'new-task'}],
      activeBoardId:'new',media:{},japanese:null,nativeJapanese:null,report:{warnings:[]}}),
    confirmDialog:async()=>{
      if(confirmDeferred)return new Promise(resolve=>{resolveConfirm=resolve;});
      return true;
    },
    dbReplaceAll:async()=>{writes++;if(dbFailure)throw Error('db-full');},
    undoStack:[],pendingMediaDeletes:new Map(),apStop(){},
    rebucket:(_tasks,boards,id)=>{state.boards=boards;state.activeBoardId=id;state._tasksByBoard={new:[{id:'new-task'}]};},
    applyActiveBoard(){},thumbCache:{clear(){}},renderBoard(){},saveUIState(){},
    localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    nativeJapaneseCommand:async()=>null,restoreJapaneseBackup(){},
    window:{},
    _saveTask:async()=>{saved++;}
  };
  vm.createContext(ctx);
  vm.runInContext(trans.slice(begin,end)+'\n'+
    tasks.slice(openStart,openEnd)+'\n'+tasks.slice(saveStart,saveEnd)+
    '\nthis.importFile=handleImport;this.openTask=openTaskModal;this.saveTask=saveTaskFromModal;'+
    'this.lock=()=>importInProgress;',ctx);
  const file={text:async()=>{reads++;return '{"version":6}';}};
  return {
    ctx,state,file,toasts,alerts,
    resolveConfirm:yes=>resolveConfirm(yes),
    setEditorOpen:value=>open=value,
    get open(){return open;},get reads(){return reads;},
    get writes(){return writes;},get saved(){return saved;}
  };
}

(async()=>{
  let f=fixture({saveBusy:true});
  await f.ctx.importFile(f.file);
  assert.equal(f.reads,0,'cannot read archive during task save');
  assert.equal(f.writes,0);
  assert.equal(f.state.activeBoardId,'old');
  assert.equal(f.ctx.lock(),false);
  assert.ok(f.toasts.some(s=>s.includes('редактор задачи')));

  f=fixture({switchBusy:true});
  await f.ctx.importFile(f.file);
  assert.equal(f.reads,0,'cannot begin import while changing board');
  assert.equal(f.writes,0);

  f=fixture({editorOpen:true});
  await f.ctx.importFile(f.file);
  assert.equal(f.reads,0,'open editor blocks import even when clean');
  assert.equal(f.open,true);
  assert.equal(f.writes,0);

  f=fixture({confirmDeferred:true});
  const importing=f.ctx.importFile(f.file);
  for(let n=0;n<8&&!f.ctx.lock();n++)await Promise.resolve();
  assert.equal(f.ctx.lock(),true);
  f.ctx.openTaskModalPlaceholder = true;
  f.ctx.openTask();
  assert.equal(f.open,false,'editor blocked before any DOM manipulation');
  await f.ctx.saveTask();
  assert.equal(f.saved,0,'task save blocked during import');
  f.resolveConfirm(true);
  await importing;
  assert.equal(f.writes,1);
  assert.equal(f.state.activeBoardId,'new');
  assert.equal(f.ctx.lock(),false);
  assert.ok(f.toasts.filter(s=>s.includes('завершения импорта')).length>=2);

  f=fixture({confirmDeferred:true});
  const pending=f.ctx.importFile(f.file);
  for(let n=0;n<8&&!f.ctx.lock();n++)await Promise.resolve();
  f.setEditorOpen(true); // editor changed by another UI event while confirming
  f.resolveConfirm(true);
  await pending;
  assert.equal(f.writes,0,'editor opened before confirmation cannot be lost');
  assert.equal(f.state.activeBoardId,'old');
  assert.equal(f.ctx.lock(),false);
  assert.equal(f.open,true,'unsaved editor remains visible');

  f=fixture({dbFailure:true});
  await f.ctx.importFile(f.file);
  assert.equal(f.writes,1);
  assert.equal(f.state.activeBoardId,'old','failed import leaves old tasks');
  assert.equal(f.ctx.lock(),false,'failure releases import lock');
  assert.equal(f.alerts.length,1);

  f=fixture();
  await f.ctx.importFile(f.file);
  assert.equal(f.writes,1);
  assert.equal(f.state.activeBoardId,'new');
  assert.equal(f.ctx.lock(),false);
  // Saving after an import is allowed once the lock has been released.
  await f.ctx.saveTask();
  assert.equal(f.saved,1);

  console.log('P7: import/editor/save concurrency and cancellation guard passed.');
})().catch(err=>{console.error(err);process.exitCode=1;});

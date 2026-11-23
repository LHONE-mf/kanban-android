// Cross-store import: never replace IndexedDB until Japanese restores succeed.
// On a failed import, compensate both progress stores and preserve existing boards.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const src = fs.readFileSync('app/src/main/js-src/data-transfer.js', 'utf8');
const helperStart = src.indexOf('const JAPANESE_BACKUP_KEYS = [');
const helperEnd = src.indexOf('// Native Android mini-quiz progress', helperStart);
const start = src.indexOf('function restoreJapaneseImportSnapshot(');
const end = src.indexOf('// ============================================================\n// CLEAR',start);
assert.ok(helperStart >= 0 && helperEnd > helperStart && start >= 0 && end > start);

const originalNative = {
  question_count:12,correct_count:10,current_question:3,next_question:4,
  katakana_unlocked:false,review_queue:'1,3'
};
const incomingNative = {
  question_count:24,correct_count:19,current_question:5,next_question:6,
  katakana_unlocked:true,review_queue:'2,4'
};
const jpKey = 'kanban-japanese-script-v1';
const extraKey = 'kanban-japanese-active-tab-v1';

function fixture({webFailure=false,nativeFailure=false,readFailure=false,dbFailure=false,
  rollbackWebFailure=false,rollbackNativeFailure=false,missingBridge=false,
  cancel=false,includeProgress=true}={}) {
  const stored = new Map([[jpKey,'hiragana']]);
  const oldBoards=[{id:'old-board',name:'Saved'}];
  const oldTasks=[{id:'old-task',boardId:'old-board'}];
  const state={boards:oldBoards,activeBoardId:'old-board',_tasksByBoard:{'old-board':oldTasks}};
  const plan={boards:[{id:'new-board'}],activeBoardId:'new-board',tasks:[{id:'new-task'}],
    media:{},japanese:includeProgress?{[jpKey]:'katakana',[extraKey]:'review'}:null,
    nativeJapanese:includeProgress?incomingNative:null,report:{warnings:[]}};
  let nativeState=structuredClone(originalNative), writes=0, rendered=0, stopCalls=0;
  const calls=[],alerts=[],toasts=[];
  const localStorage={
    getItem:k=>stored.has(k)?stored.get(k):null,
    setItem:(k,v)=>{
      if(webFailure&&k===extraKey&&v==='review') throw Error('quota exceeded');
      if(rollbackWebFailure&&k===jpKey&&v==='hiragana') throw Error('rollback quota');
      stored.set(k,v);
    },
    removeItem:k=>stored.delete(k)
  };
  const ctx={
    localStorage,state,window:{},Map,Set,JSON,Object,Date,
    savingTask:false,switchingBoard:false,
    $:selector=>selector==='#taskModal'?{classList:{contains:()=>false}}:null,
    console:{warn(){},error(){}},clearTimeout(){},alert:msg=>alerts.push(msg),
    confirmDialog:async()=>!cancel,
    buildImportPlan:async()=>plan,
    nativeJapaneseCommand:async(type,value)=>{
      calls.push(type);
      if(missingBridge)return null;
      if(type==='read') {
        if(readFailure)throw Error('native read error');
        return structuredClone(nativeState);
      }
      if(type==='restore'){
        if(nativeFailure&&value===incomingNative)throw Error('native restore error');
        if(rollbackNativeFailure&&value!==incomingNative)throw Error('native rollback error');
        nativeState=structuredClone(value);return true;
      }
    },
    dbReplaceAll:async()=>{
      writes++;
      if(dbFailure)throw Error('disk full');
    },
    undoStack:[{}], pendingMediaDeletes:new Map(), apStop:()=>stopCalls++,
    rebucket:(tasks,boards,id)=>{
      state.boards=boards;state.activeBoardId=id;
      state._tasksByBoard={'new-board':tasks};
    },
    applyActiveBoard(){},thumbCache:{clear(){}},
    renderBoard:()=>rendered++,saveUIState(){},
    showToast:msg=>toasts.push(msg)
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(helperStart,helperEnd)+'\n'+src.slice(start,end)+
    '\nthis.import=handleImport;',ctx);
  const file={text:async()=>JSON.stringify({version:6})};
  return {
    run:()=>ctx.import(file),state,stored,alerts,toasts,calls,
    get nativeState(){return nativeState;},
    get writes(){return writes;},get rendered(){return rendered;},
    get stopCalls(){return stopCalls;}
  };
}
(async()=>{
  let f=fixture({webFailure:true});
  await f.run();
  assert.equal(f.writes,0,'web quota failure cannot replace boards');
  assert.equal(f.state.boards[0].id,'old-board');
  assert.equal(f.stored.get(jpKey),'hiragana','web progress rolls back after partial write');
  assert.equal(f.stored.has(extraKey),false,'newly created web key removed');
  assert.equal(f.calls.length,1,'native must only have been read');
  assert.equal(f.rendered,0);

  f=fixture({nativeFailure:true});
  await f.run();
  assert.equal(f.writes,0,'native failure cannot replace boards');
  assert.equal(f.stored.get(jpKey),'hiragana');
  assert.equal(f.stored.has(extraKey),false);
  assert.equal(f.nativeState.correct_count,originalNative.correct_count);
  assert.deepEqual(f.calls,['read','restore','restore'],'native rollback follows a failed restore');

  f=fixture({readFailure:true});
  await f.run();
  assert.equal(f.writes,0);
  assert.equal(f.stored.get(jpKey),'hiragana');
  assert.equal(f.calls.length,1);

  f=fixture({missingBridge:true});
  await f.run();
  assert.equal(f.writes,0,'unsupported browser native restore cannot silently import');
  assert.equal(f.stored.get(jpKey),'hiragana');
  assert.ok(f.alerts.some(s=>s.includes('без изменений')));

  f=fixture({dbFailure:true});
  await f.run();
  assert.equal(f.writes,1,'IndexedDB attempted only after progress restored');
  assert.equal(f.state.boards[0].id,'old-board');
  assert.equal(f.stored.get(jpKey),'hiragana');
  assert.equal(f.stored.has(extraKey),false);
  assert.equal(f.nativeState.correct_count,originalNative.correct_count);
  assert.deepEqual(f.calls,['read','restore','restore']);
  assert.equal(f.rendered,0);
  assert.equal(f.toasts.length,0);

  f=fixture({dbFailure:true,rollbackWebFailure:true,rollbackNativeFailure:true});
  await f.run();
  assert.equal(f.state.boards[0].id,'old-board');
  assert.ok(f.alerts.some(s=>s.includes('откат японского прогресса')));
  assert.equal(f.toasts.length,0,'never report success when rollback incomplete');

  f=fixture();
  await f.run();
  assert.equal(f.writes,1);
  assert.equal(f.state.boards[0].id,'new-board');
  assert.equal(f.stored.get(jpKey),'katakana');
  assert.equal(f.stored.get(extraKey),'review');
  assert.equal(f.nativeState.correct_count,incomingNative.correct_count);
  assert.equal(f.rendered,1);
  assert.equal(f.toasts.length,1);
  assert.equal(f.alerts.length,0);

  f=fixture({cancel:true});
  await f.run();
  assert.equal(f.writes,0);
  assert.equal(f.calls.length,0);
  assert.equal(f.state.boards[0].id,'old-board');

  f=fixture({includeProgress:false});
  await f.run();
  assert.equal(f.writes,1);
  assert.equal(f.calls.length,0,'old archives do not overwrite native progress');
  assert.equal(f.stored.get(jpKey),'hiragana');
  assert.equal(f.state.boards[0].id,'new-board');

  console.log('Import: web/native failures, unreadable bridge, DB abort, rollback and success verified.');
})().catch(err=>{console.error(err);process.exitCode=1;});

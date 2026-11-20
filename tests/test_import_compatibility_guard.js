// P5: preserve legacy archive imports, reject incomplete modern backups and
// never execute two overlapping import sessions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const src = fs.readFileSync('app/src/main/js-src/data-transfer.js','utf8');
const start = src.indexOf('function base64ToBlob(');
const end = src.indexOf('// ============================================================\n// CLEAR', start);
assert.ok(start>=0 && end>start, 'run actual import code');

const board = {id:'new-board',name:'Imported',columns:[{id:'todo',title:'Todo'}]};
const task = {id:'new-task',boardId:'new-board',columnId:'todo',parentId:'',
  title:'Imported task',files:[],deadline:'',order:0};
const archive = () => ({version:6,app:'comrade',boards:[board],tasks:[task],
  activeBoardId:board.id,media:{}});

function fixture({failWrite=false,delayConfirm=false}={}) {
  const state={boards:[{id:'old-board',name:'Existing',columns:[{id:'todo'}]}],
    activeBoardId:'old-board',
    _tasksByBoard:{'old-board':[{id:'old-task',boardId:'old-board'}]}};
  const writes=[],messages=[],toasts=[],prompts=[];
  let renders=0,resolveConfirm;
  const ctx={
    state,console:{warn(){},error(){}},JSON,Map,Set,Blob,Uint8Array,Date,Object,
    MAX_VIDEO_SIZE:50*1048576,
    DEFAULT_COLUMNS:()=>[{id:'todo',title:'Todo'}],
    generateId:()=> 'generated-1',
    sanitizeBoard:b=>({...b,columns:b.columns||[{id:'todo'}]}),
    sanitizeTask:t=>({...t,files:t.files||[],parentId:t.parentId||'',deadline:t.deadline||''}),
    normalizeTree(){},isValidISODate:()=>true,
    validateJapaneseBackup:x=>x??null,
    validateNativeJapaneseBackup:x=>x??null,
    confirmDialog:async(title,msg)=>{
      prompts.push([title,msg]);
      if(delayConfirm)return new Promise(resolve=>resolveConfirm=resolve);
      return true;
    },
    dbReplaceAll:async plan=>{
      writes.push(plan);
      if(failWrite)throw Error('database full');
    },
    alert:message=>messages.push(message),
    showToast:message=>toasts.push(message),
    undoStack:[],pendingMediaDeletes:new Map(),
    clearTimeout(){},apStop(){},thumbCache:{clear(){}},
    rebucket:(tasks,boards,id)=>{
      state.boards=boards;state.activeBoardId=id;
      state._tasksByBoard=Object.fromEntries(boards.map(b=>[b.id,tasks.filter(t=>t.boardId===b.id)]));
    },
    applyActiveBoard(){},renderBoard:()=>renders++,saveUIState(){},
    localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    nativeJapaneseCommand:async()=>null,
    restoreJapaneseBackup(){},
    window:{},showMessage(){}
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start,end)+'\nthis.importFile=handleImport; this.plan=buildImportPlan;this.lock=()=>importInProgress;',ctx);
  const file=data=>({text:async()=>JSON.stringify(data)});
  return {ctx,state,file,writes,messages,toasts,prompts,
    approve:()=>resolveConfirm(true),
    get renders(){return renders;}};
}

(async()=>{
  let f=fixture();
  await f.ctx.importFile(f.file(archive()));
  assert.equal(f.writes.length,1);
  assert.equal(f.state.boards[0].id,'new-board');
  assert.equal(f.renders,1);

  for (const invalid of [
    {...archive(),tasks:undefined},
    {...archive(),tasks:{}},
    {...archive(),boards:undefined},
    {...archive(),boards:{}},
    {...archive(),version:5,tasks:undefined},
    {...archive(),version:7},
    {...archive(),version:'invalid'}
  ]) {
    f=fixture();
    await f.ctx.importFile(f.file(invalid));
    assert.equal(f.writes.length,0,'invalid modern archive cannot write');
    assert.equal(f.prompts.length,0,'reject invalid archive before confirmation');
    assert.equal(f.state.boards[0].id,'old-board');
    assert.equal(f.messages.length,1);
    assert.equal(f.ctx.lock(),false,'invalid import releases the lock');
  }

  for(const legacy of [
    [{id:'old1',title:'Legacy array',files:[],columnId:'todo'}],
    {version:2,tasks:[{id:'old2',title:'Legacy tasks',columnId:'todo'}]},
    {version:3,boardName:'Old Board',tasks:[{id:'old3',title:'Old format',columnId:'todo'}]},
    {version:4,boards:[board],tasks:[task],activeBoardId:board.id}
  ]){
    f=fixture();
    await f.ctx.importFile(f.file(legacy));
    assert.equal(f.writes.length,1,'legacy archive imports without new fields');
    assert.equal(f.state.boards.length,1);
    assert.equal(f.messages.length,0);
  }

  f=fixture();
  let completeText;
  let reads=0;
  const slowFile={text:()=>{reads++;return new Promise(resolve=>completeText=resolve);}};
  const first=f.ctx.importFile(slowFile);
  assert.equal(f.ctx.lock(),true,'lock taken before file read');
  await f.ctx.importFile(f.file(archive()));
  assert.equal(reads,1,'only first file is read');
  assert.equal(f.writes.length,0,'second import cannot write');
  assert.ok(f.toasts.some(m=>m.includes('Импорт уже выполняется')));
  completeText(JSON.stringify(archive()));
  await first;
  assert.equal(f.writes.length,1,'first import commits once');
  assert.equal(f.ctx.lock(),false,'lock released after successful import');
  await f.ctx.importFile(f.file(archive()));
  assert.equal(f.writes.length,2,'later sequential import is allowed');

  f=fixture({delayConfirm:true});
  const duringConfirmation=f.ctx.importFile(f.file(archive()));
  for(let i=0;i<5 && !f.prompts.length;i++)await Promise.resolve();
  assert.equal(f.prompts.length,1);
  await f.ctx.importFile(f.file(archive()));
  assert.equal(f.prompts.length,1,'no second confirmation dialog');
  f.approve();
  await duringConfirmation;
  assert.equal(f.writes.length,1);
  assert.equal(f.ctx.lock(),false);

  f=fixture();
  await f.ctx.importFile({text:async()=>'{invalid'});
  assert.equal(f.ctx.lock(),false,'invalid JSON releases lock');
  await f.ctx.importFile(f.file(archive()));
  assert.equal(f.writes.length,1,'valid file works after bad JSON');

  f=fixture({failWrite:true});
  await f.ctx.importFile(f.file(archive()));
  assert.equal(f.ctx.lock(),false,'database failure releases lock');
  assert.equal(f.state.boards[0].id,'old-board','existing tasks survive failed storage');

  console.log('P5: v2-v4 legacy, modern format rejection and concurrent import guard passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

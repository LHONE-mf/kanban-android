// Regressions for losing unsaved task edits when changing boards.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = fs.readFileSync('app/src/main/js-src/core.js','utf8');
const start = core.indexOf('async function persistBoards(');
const end = core.indexOf('async function addBoard(',start);
assert.ok(start>=0 && end>start);

function fixture({dirty=false,saving=false,confirm=true,failWrite=false,deferred=false}={}) {
  const state={boards:[{id:'a'},{id:'b'}],activeBoardId:'a'};
  const select={value:'b'},writes=[],prompts=[],toasts=[];
  let open=true,closed=0,renders=0,notified=0,resolvePrompt;
  const ctx={
    state,savingTask:saving,isModalDirty:()=>dirty,
    $:s=>s==='#boardSelect'?select:s==='#taskModal'?{classList:{contains:()=>open}}:null,
    getBoard:id=>state.boards.find(b=>b.id===id),
    confirmDialog:(title,body)=>{
      prompts.push([title,body]);
      return deferred?new Promise(resolve=>resolvePrompt=resolve):Promise.resolve(confirm);
    },
    dbPutSettingsBulk:async values=>{
      writes.push(values.map(([key,value])=>[key,value]));
      if(failWrite)throw Error('disk full');
    },
    closeModal:id=>{assert.equal(id,'taskModal');closed++;open=false;},
    applyActiveBoard:()=>{select.value=state.activeBoardId;},
    renderBoard:()=>renders++, saveUIState(){},notifyOtherTabs:()=>notified++,
    showToast:s=>toasts.push(s)
  };
  vm.createContext(ctx);
  vm.runInContext(core.slice(start,end)+'\nthis.switch= switchBoard; this.switching=()=>switchingBoard;',ctx);
  return {ctx,state,select,writes,prompts,toasts,
    answer:v=>resolvePrompt(v),
    get open(){return open;}, get closed(){return closed;},
    get renders(){return renders;},get notified(){return notified;}};
}
(async()=>{
  let f=fixture({dirty:true,confirm:false});
  assert.equal(await f.ctx.switch('b'),false);
  assert.equal(f.state.activeBoardId,'a');
  assert.equal(f.select.value,'a','cancel resets dropdown');
  assert.equal(f.open,true,'cancel preserves editor');
  assert.equal(f.writes.length,0);

  f=fixture({dirty:true});
  assert.equal(await f.ctx.switch('b'),true);
  assert.equal(f.state.activeBoardId,'b');
  assert.equal(f.select.value,'b');
  assert.equal(f.closed,1);
  assert.equal(f.writes.length,1,'one settings transaction');
  assert.equal(f.writes[0][1][1],'b');
  assert.equal(f.renders,1);
  assert.equal(f.prompts.length,1);

  f=fixture();
  assert.equal(await f.ctx.switch('b'),true,'clean editor can switch');
  assert.equal(f.prompts.length,0);

  f=fixture({saving:true,dirty:true});
  assert.equal(await f.ctx.switch('b'),false,'active save blocks switch');
  assert.equal(f.open,true);
  assert.equal(f.select.value,'a');
  assert.equal(f.prompts.length,0);
  assert.equal(f.writes.length,0);

  f=fixture({dirty:true,deferred:true});
  const waiting=f.ctx.switch('b');
  assert.equal(f.ctx.switching(),true);
  f.ctx.savingTask=true;
  f.answer(true);
  assert.equal(await waiting,false,'save beginning during prompt blocks switch');
  assert.equal(f.open,true);
  assert.equal(f.writes.length,0);
  assert.equal(f.select.value,'a');

  f=fixture({dirty:true,failWrite:true});
  assert.equal(await f.ctx.switch('b'),false,'storage failure prevents board change');
  assert.equal(f.state.activeBoardId,'a');
  assert.equal(f.open,true,'failed storage preserves draft');
  assert.equal(f.select.value,'a');
  assert.equal(f.renders,0);
  assert.equal(f.notified,0);
  assert.ok(f.toasts.some(s=>s.includes('disk full')));

  f=fixture({dirty:true,deferred:true});
  const first=f.ctx.switch('b');
  assert.equal(await f.ctx.switch('b'),false,'concurrent switch blocked');
  f.answer(true);
  assert.equal(await first,true);
  assert.equal(f.writes.length,1);

  f=fixture();
  assert.equal(await f.ctx.switch('missing'),false);
  assert.equal(await f.ctx.switch('a'),false);
  assert.equal(f.select.value,'a');
  assert.equal(f.writes.length,0);

  const tasks=fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
  const s=tasks.indexOf('async function saveTaskFromModal()');
  const e=tasks.indexOf('async function _saveTask()',s);
  assert.ok(s>=0&&e>s);
  const c={savingTask:false,switchingBoard:true,calls:0,warnings:[],
    _saveTask:async()=>c.calls++,showToast:msg=>c.warnings.push(msg)};
  vm.createContext(c);
  vm.runInContext(tasks.slice(s,e)+'\nthis.save=saveTaskFromModal;',c);
  await c.save();
  assert.equal(c.calls,0,'save cannot race board switch');
  assert.equal(c.warnings.length,1);
  c.switchingBoard=false;
  await c.save();
  assert.equal(c.calls,1,'save works after board switch completes');
  console.log('Board switch draft preservation, save guards and failure behavior passed.');
})().catch(err=>{console.error(err);process.exitCode=1;});

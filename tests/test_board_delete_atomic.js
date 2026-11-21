// P11 regression: atomic board deletion, shared media, cancellation and rollback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/core.js', 'utf8');
const uiStart = source.indexOf('let deletingBoard = false;');
const uiEnd = source.indexOf('// ============================================================\n// UTILITIES', uiStart);
const dbStart = source.indexOf('async function dbDeleteBoard(');
const dbEnd = source.indexOf('async function dbGetSettings()', dbStart);
assert.ok(uiStart>=0 && uiEnd>uiStart && dbStart>=0 && dbEnd>dbStart);
const a={id:'task-a',boardId:'a',files:[{id:'shared'},{id:'unique'}]};
const b={id:'task-b',boardId:'b',files:[{id:'shared'},{id:'only-b'}]};
function fixture({confirm=true,last=false,saving=false}={}) {
  const state={
    boards:last?[{id:'a',name:'Alpha'}]:[{id:'a',name:'Alpha'},{id:'b',name:'Beta'}],
    activeBoardId:'a',_tasksByBoard:{a:[a],b:[b]}
  };
  const committed={
    tasks:new Map([[a.id,a],[b.id,b]]),
    settings:new Map([['boards',{key:'boards',value:state.boards}],
      ['activeBoardId',{key:'activeBoardId',value:'a'}]]),
    media:new Map([['shared',{full:'shared'}],['unique',{full:'unique'}],
      ['only-b',{full:'only-b'}]])
  };
  let tx,settingsOpen=true,closed=0,renders=0,notified=0,transactions=0;
  const queued=[],toasts=[];
  const db={transaction(stores,mode){
    assert.deepEqual(Array.from(stores),['tasks','settings','media']);
    assert.equal(mode,'readwrite');
    transactions++;
    tx={
      error:null,
      objectStore(name){
        return {
          getAll(){
            assert.equal(name,'tasks');
            const req={};
            queueMicrotask(()=>{req.result=[...committed.tasks.values()];req.onsuccess();});
            return req;
          },
          delete(key){queued.push({name,op:'delete',key});},
          put(value){queued.push({name,op:'put',key:value.key,value});}
        };
      },
      abort(){queueMicrotask(()=>tx.onabort());}
    };
    return tx;
  }};
  const ctx={
    state,db,Promise,Set,Error,STORE_TASKS:'tasks',STORE_SETTINGS:'settings',
    STORE_MEDIA:'media',wrapTxError:e=>e,
    savingTask:saving,switchingBoard:false,importInProgress:false,
    getBoard:id=>state.boards.find(x=>x.id===id),
    confirmDialog:async(title,msg)=>{assert.match(msg,/Это нельзя отменить/);return confirm;},
    $:id=>id==='#taskModal'?{classList:{contains:()=>false}}:
      id==='#settingsModal'?{classList:{contains:()=>settingsOpen}}:null,
    closeModal:id=>{assert.equal(id,'settingsModal');closed++;settingsOpen=false;},
    showToast:x=>toasts.push(x),
    applyActiveBoard(){},renderBoard(){renders++;},saveUIState(){},
    notifyOtherTabs(){notified++;}
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(uiStart,uiEnd)+'\n'+source.slice(dbStart,dbEnd)
    +'\nthis.removeBoard=deleteBoard;this.lock=()=>deletingBoard;',ctx);
  function complete(){
    const copy=Object.fromEntries(Object.entries(committed).map(([k,v])=>[k,new Map(v)]));
    for(const item of queued){
      if(item.op==='delete')copy[item.name].delete(item.key);
      else copy[item.name].set(item.key,item.value);
    }
    Object.assign(committed,copy);
    tx.oncomplete();
  }
  return {ctx,state,committed,queued,toasts,complete,
    get tx(){return tx;},get closed(){return closed;},
    get renders(){return renders;},get notified(){return notified;},
    get transactions(){return transactions;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  let f=fixture({confirm:false});
  assert.equal(await f.ctx.removeBoard('a'),false);
  assert.equal(f.transactions,0,'cancelled deletion performs no writes');
  assert.equal(f.committed.tasks.has('task-a'),true);
  assert.equal(f.ctx.lock(),false);

  f=fixture({last:true});
  assert.equal(await f.ctx.removeBoard('a'),false,'last board cannot be deleted');
  assert.equal(f.transactions,0);

  f=fixture({saving:true});
  assert.equal(await f.ctx.removeBoard('a'),false,'editing blocks deletion');
  assert.equal(f.transactions,0);

  f=fixture();
  const pending=f.ctx.removeBoard('a');
  await tick();
  assert.equal(f.ctx.lock(),true,'block duplicate click until transaction completes');
  assert.equal(await f.ctx.removeBoard('a'),false);
  assert.equal(f.committed.tasks.has('task-a'),true,'no early commit');
  assert.equal(f.state.boards.length,2,'in-memory board not changed before commit');
  assert.equal(f.queued.some(x=>x.name==='media'&&x.key==='shared'),false);
  assert.equal(f.queued.some(x=>x.name==='media'&&x.key==='unique'),true);
  f.complete();
  assert.equal(await pending,true);
  assert.equal(f.committed.tasks.has('task-a'),false);
  assert.equal(f.committed.tasks.has('task-b'),true);
  assert.equal(f.committed.media.has('unique'),false);
  assert.equal(f.committed.media.has('shared'),true,'shared attachment preserved');
  assert.equal(f.committed.media.has('only-b'),true);
  assert.equal(f.committed.settings.get('boards').value.length,1);
  assert.equal(f.committed.settings.get('activeBoardId').value,'b');
  assert.equal(f.state.activeBoardId,'b');
  assert.equal(f.closed,1,'close settings for deleted board');
  assert.equal(f.renders,1);
  assert.equal(f.notified,1);

  f=fixture();
  const failed=f.ctx.removeBoard('a');
  await tick();
  f.tx.error=new Error('disk full');
  f.tx.onabort();
  assert.equal(await failed,false);
  assert.equal(f.state.boards.length,2);
  assert.equal(f.committed.tasks.has('task-a'),true);
  assert.equal(f.committed.media.has('unique'),true);
  assert.equal(f.renders,0);
  assert.equal(f.closed,0);
  assert.equal(f.ctx.lock(),false);
  assert.ok(f.toasts.some(x=>x.includes('disk full')));
  console.log('P11: atomic deletion, shared media, cancellation and rollback passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

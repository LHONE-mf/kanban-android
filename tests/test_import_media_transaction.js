// P6: simulate IndexedDB completion and failures during media-heavy imports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync('app/src/main/js-src/core.js','utf8');
const wrapStart = code.indexOf('function wrapTxError(');
const wrapEnd = code.indexOf('async function dbGetAllTasks()',wrapStart);
const importStart = code.indexOf('async function dbReplaceAll(');
const importEnd = code.indexOf('async function mediaPut(',importStart);
assert.ok(wrapStart>=0&&wrapEnd>wrapStart&&importStart>=0&&importEnd>importStart);

const quotaError = () => Object.assign(new Error('Quota exceeded'),{name:'QuotaExceededError'});
function fixture({syncError=false}={}) {
  const committed={
    tasks:new Map([['old-task',{id:'old-task',files:[{id:'old-media'}]}]]),
    settings:new Map([['boards',{key:'boards',value:[{id:'old-board'}]}],
      ['activeBoardId',{key:'activeBoardId',value:'old-board'}]]),
    media:new Map([['old-media',{full:new Blob(['original']),type:'text/plain'}]])
  };
  const queued=[];
  let tx;
  const db={
    transaction(stores,mode) {
      assert.equal(mode,'readwrite');
      assert.deepEqual(Array.from(stores),['tasks','settings','media']);
      tx={
        error:null, aborted:false,
        objectStore(name) {
          assert.ok(committed[name]);
          return {
            get(key){const request={};queued.push({name,op:'get',key:JSON.stringify(key),request});return request;},
            clear(){queued.push({name,op:'clear'});},
            put(value,key){
              if(syncError&&name==='media')throw quotaError();
              queued.push({name,op:'put',key:key??(name==='settings'?value.key:value.id),value});
            }
          };
        },
        abort(){
          tx.aborted=true;
          queueMicrotask(()=>tx.onabort?.());
        }
      };
      return tx;
    }
  };
  const ctx={db,STORE_TASKS:'tasks',STORE_SETTINGS:'settings',STORE_MEDIA:'media',
    Promise,Object,Error};
  vm.createContext(ctx);
  vm.runInContext(code.slice(wrapStart,wrapEnd)+'\n'+code.slice(importStart,importEnd)
    +'\nthis.replace = dbReplaceAll;',ctx);
  const plan={tasks:[{id:'new-task',files:[{id:'new-media'}]}],
    boards:[{id:'new-board'}],activeBoardId:'new-board',
    dayPlan:{date:'2026-11-20',ids:['new-task']},
    media:{'new-media':{full:new Blob(['restored']),thumb:null,type:'text/plain'}}};
  function complete(){
    const next=Object.fromEntries(Object.entries(committed)
      .map(([name,m])=>[name,new Map(m)]));
    for(const item of queued) {
      if(tx.aborted) return;
      if(item.op==='clear')next[item.name].clear();
      else if(item.op==='get') {
        item.request.result=next[item.name].get(item.key);
        item.request.onsuccess?.();
      }
      else next[item.name].set(item.key,item.value);
    }
    if(tx.aborted) return;
    for(const name of Object.keys(committed))committed[name]=next[name];
    tx.oncomplete();
  }
  return {ctx,plan,committed,queued,complete,get tx(){return tx;}};
}
(async()=>{
  let f=fixture();
  let settled=false;
  const ok=f.ctx.replace(f.plan).then(()=>{settled=true;});
  assert.equal(settled,false,'import cannot complete before IndexedDB oncomplete');
  assert.equal(f.committed.media.has('old-media'),true);
  assert.equal(f.committed.media.has('new-media'),false,'queued attachment is not yet committed');
  f.complete();
  await ok;
  assert.equal(settled,true);
  assert.equal(f.committed.tasks.has('new-task'),true);
  assert.equal(f.committed.tasks.has('old-task'),false);
  assert.equal(f.committed.media.has('new-media'),true);
  assert.equal(f.committed.media.has('old-media'),false);
  assert.equal(f.committed.settings.get('activeBoardId').value,'new-board');
  assert.equal(f.committed.settings.get('comrade_day_plan_v1').value.ids[0],'new-task');

  f=fixture();
  let failureSeen=false;
  const quota=f.ctx.replace(f.plan).catch(error=>{failureSeen=true;throw error;});
  assert.ok(f.queued.some(x=>x.name==='media'&&x.op==='put'));
  // The request is rejected while media.put is pending, but the abort event
  // has not yet confirmed that the original records survived.
  f.tx.onerror({target:{error:quotaError()}});
  await Promise.resolve();
  assert.equal(failureSeen,false,'do not report import failure before rollback finishes');
  assert.equal(f.committed.tasks.has('old-task'),true);
  assert.equal(f.committed.media.has('old-media'),true);
  f.tx.onabort();
  await assert.rejects(quota,/Хранилище переполнено/);
  assert.equal(failureSeen,true);
  assert.equal(f.committed.tasks.has('old-task'),true);
  assert.equal(f.committed.media.has('new-media'),false);

  f=fixture();
  const archivePlan={...f.plan,media:undefined,stagedMedia:{session:'zip',ids:['new-media']}};
  const temporary=JSON.stringify(['zip','new-media']);
  f.committed.media.set(temporary,f.plan.media['new-media']);
  const swap=f.ctx.replace(archivePlan);
  f.complete();
  await swap;
  assert.equal(await f.committed.media.get('new-media').full.text(), 'restored');
  assert.equal(f.committed.media.has(temporary), false);
  assert.equal(f.committed.media.has('old-media'), false);

  f=fixture();
  const missing=f.ctx.replace(archivePlan);
  f.complete();
  await assert.rejects(missing,/Временное вложение/);
  assert.equal(f.committed.media.has('old-media'), true);
  assert.equal(f.committed.tasks.has('old-task'), true);

  f=fixture();
  const requestError=f.ctx.replace(f.plan);
  f.tx.onerror({target:{error:new Error('Attachment write failed')}});
  f.tx.onabort();
  await assert.rejects(requestError,/Attachment write failed/,
    'report actual failed media request, not generic abort message');
  assert.equal(f.committed.media.has('old-media'),true);

  f=fixture();
  const aborted=f.ctx.replace(f.plan);
  f.tx.error=Object.assign(new Error('Transaction aborted'),{name:'AbortError'});
  f.tx.onabort();
  await assert.rejects(aborted,/Транзакция отменена/);
  assert.equal(f.committed.tasks.has('old-task'),true);

  f=fixture({syncError:true});
  const sync=f.ctx.replace(f.plan);
  assert.equal(f.tx.aborted,true,'queueing a media.put failure aborts the entire transaction');
  await assert.rejects(sync,/Хранилище переполнено/);
  assert.equal(f.committed.tasks.has('old-task'),true);
  assert.equal(f.committed.media.has('old-media'),true);
  assert.equal(f.committed.media.has('new-media'),false);

  // Import file preflight rejects truncated attachments before an IndexedDB tx.
  const transfer=fs.readFileSync('app/src/main/js-src/data-transfer.js','utf8');
  assert.ok(transfer.includes('if (brokenMedia || skippedTasks)') ||
    transfer.includes('(brokenMedia || skippedTasks)'),
    'modern full backups must not silently skip referenced media');
  console.log('P6: successful atomic media import, delayed rollback, quota and request errors passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

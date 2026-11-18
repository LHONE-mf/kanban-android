const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
const start = source.indexOf('async function duplicateTask(');
const end = source.indexOf('// ============================================================\n// FOCUS TRAP', start);
assert(start >= 0 && end > start);
const duplicateSource = source.slice(start, end);

async function run(failAt) {
  const original = {id:'original',boardId:'board',columnId:'todo',title:'Task',
    files:[{id:'one',type:'image/png'},{id:'two',type:'image/png'}],tags:[],checklist:[],order:0};
  const state = {activeBoardId:'board',tasks:[original]};
  const stored = new Set(['one','two']);
  const toasts=[];
  let generated=0, writes=0, deleted=0;
  const ctx={state,console,Date,
    generateId:()=>String(++generated),
    mediaGet:async id=>({full:id,thumb:null,type:'image/png'}),
    mediaPut:async id=>{
      if(failAt==='media' && id==='m_2')throw Error('media full');
      stored.add(id);
    },
    mediaDelete:async id=>{deleted++;stored.delete(id)},
    dbPutTask:async ()=>{writes++;if(failAt==='task')throw Error('database full')},
    showToast:s=>toasts.push(s),syncNativeReminder(){},closeModal(){},notifyOtherTabs(){},renderBoard(){}
  };
  vm.createContext(ctx);
  vm.runInContext(duplicateSource,ctx);
  await ctx.duplicateTask('original');
  // Wait for any best-effort media rollback promises.
  await Promise.resolve();
  if(failAt){
    assert.equal(state.tasks.length,1,'Failed duplicate must not enter memory');
    assert.deepEqual([...stored].sort(),['one','two'],'Failed duplicate must not leak copied media');
    assert(toasts.some(s=>s.includes('Не удалось')),'Failure must be visible');
    assert.equal(deleted,failAt==='task'?2:1);
  } else {
    assert.equal(state.tasks.length,2);
    assert.equal(writes,1);
    assert.equal(stored.size,4);
  }
}
(async()=>{await run('task');await run('media');await run(null);
  console.log('Duplicate attachment rollback and successful duplication passed');
})().catch(e=>{console.error(e);process.exitCode=1});

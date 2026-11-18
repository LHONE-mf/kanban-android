// Regression: moving/completing a parent must persist its descendants in one transaction.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const views = fs.readFileSync('app/src/main/js-src/views.js', 'utf8');
const from = views.indexOf('function topOrder(');
const to = views.indexOf('function updateTagFilter(', from);
assert(from >= 0 && to > from);
const code = views.slice(from, to);

function fixture() {
  const original = [
    {id:'root',parentId:'',columnId:'todo',title:'Parent',order:1},
    {id:'child',parentId:'root',columnId:'todo',title:'Child',order:0},
    {id:'grand',parentId:'child',columnId:'todo',title:'Grandchild',order:0},
    {id:'other',parentId:'',columnId:'todo',title:'Other',order:3}
  ];
  const state = {tasks: original.map(t=>({...t})),columns:[
    {id:'todo',isDone:false},{id:'done',isDone:true}
  ]};
  const writes=[], toasts=[];
  let fail = false;
  const ctx = {state,console,Date,
    applyColumnChange:(task,columnId)=>({...task,columnId,updatedAt:123,
      completedAt:columnId==='done'?123:null}),
    subtree:id=>state.tasks.filter(t=>t.parentId===id || (id==='root' && t.parentId==='child')),
    persistTaskChanges: async updates=>{
      writes.push(updates.map(t=>({...t})));
      if(fail)throw Error('disk full');
      for(const update of updates){
        const index=state.tasks.findIndex(t=>t.id===update.id);
        if(index>=0)state.tasks[index]=update;
      }
    },
    // The old code invokes this after saving the parent, causing a second write.
    syncKids: async root=>{
      const children=state.tasks.filter(t=>t.parentId==='root'||t.parentId==='child')
        .filter(t=>t.columnId!==root.columnId)
        .map(t=>({...t,columnId:root.columnId}));
      if(children.length)writes.push(children);
    },
    notifyOtherTabs(){},renderBoard(){},showToast:s=>toasts.push(s)
  };
  vm.createContext(ctx);
  vm.runInContext(code,ctx);
  return {ctx,state,writes,toasts,setFail:v=>fail=v};
}
async function verify(operation) {
  const f=fixture();
  if(operation==='move')await f.ctx.moveCardToAdjacentColumn('root',1);
  else await f.ctx.markTaskDone('root');
  assert.equal(f.writes.length,1,operation+': parent and children need ONE storage transaction');
  assert.deepEqual(f.writes[0].map(t=>t.id).sort(),
    ['root','child','grand'].sort(),operation+': all descendants must be in the same batch');
  assert(f.writes[0].every(t=>t.columnId==='done'),operation+': every child follows status');
  assert.equal(f.state.tasks.find(t=>t.id==='other').columnId,'todo');

  const failure=fixture();
  failure.setFail(true);
  if(operation==='move')await failure.ctx.moveCardToAdjacentColumn('root',1);
  else await failure.ctx.markTaskDone('root');
  assert.deepEqual(failure.state.tasks.map(t=>t.columnId),
    ['todo','todo','todo','todo'],operation+': failed writes preserve every task');
  assert(failure.toasts.some(s=>s.includes('disk full')));
}
(async()=>{
  await verify('move');
  await verify('done');
  console.log('Card movement and Mark Done atomically commit every descendant');
})().catch(error=>{console.error(error);process.exitCode=1});

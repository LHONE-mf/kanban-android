// Cross-board task move tests: atomic storage, nested task hierarchy and editor navigation.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const tasks=fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
const html=fs.readFileSync('app/src/main/assets/kanban.html','utf8');
const interactions=fs.readFileSync('app/src/main/js-src/interactions.js','utf8');
const start=tasks.indexOf('// CROSS-BOARD TASK MOVE');
const end=tasks.indexOf('// ============================================================\n// TASK MODAL',start);
assert(start>=0 && end>start,'Cross-board move logic must be available in tasks.js');
for(const id of ['taskMoveField','taskMoveBoard','moveTaskBoardBtn'])
  assert(html.includes('id="'+id+'"'),'Task editor must expose '+id);
assert(interactions.includes("$('#moveTaskBoardBtn').onclick"),'Move button must be wired');
assert(interactions.includes('isModalDirty()'),'Unsaved editor changes must be guarded');

function fixture() {
  const file={id:'photo1',name:'inspection.jpg',type:'image/jpeg',size:1024};
  const root={id:'r',boardId:'b1',columnId:'doing',parentId:'',title:'Inspect battery',
    deadline:'2026-11-12',reminder:'2026-11-12T09:00',completedAt:null,
    files:[file],tags:['qc'],checklist:[{id:'check1',text:'Measure',checked:true}],
    order:9,createdAt:1,updatedAt:2};
  const child={...root,id:'c',parentId:'r',title:'Measure voltage',files:[],order:1};
  const grand={...root,id:'g',parentId:'c',title:'Record result',files:[],order:2};
  const completed={...root,id:'d',columnId:'done',title:'Released batch',files:[],
    reminder:'',completedAt:123456,order:4};
  const unchanged={...root,id:'other',title:'Other task',files:[],reminder:'',order:3};
  const existing={...root,id:'dest',boardId:'b2',columnId:'wip',files:[],
    reminder:'',order:1};
  const boards=[
    {id:'b1',name:'Quality',columns:[
      {id:'todo',title:'Backlog',isDone:false},
      {id:'doing',title:'Doing',isDone:false},
      {id:'done',title:'Done',isDone:true}]},
    {id:'b2',name:'Production',columns:[
      {id:'backlog',title:'Backlog',isDone:false},
      {id:'wip',title:'Doing',isDone:false},
      {id:'closed',title:'Done',isDone:true}]}
  ];
  const state={boards,activeBoardId:'b1',_tasksByBoard:{b1:[root,child,grand,completed,unchanged],b2:[existing]}};
  state.tasks=state._tasksByBoard.b1;
  let failWrite=false;
  const writes=[],notifications=[],nav=[],toasts=[];
  const busy=new Set();
  const ctx={Date,console,activeTaskWrites:busy,state,
    getBoard:id=>state.boards.find(b=>b.id===id),
    subtree:id=>{
      const found=[];
      const walk=p=>{for(const t of state.tasks)if(t.parentId===p){found.push(t);walk(t.id)}};
      walk(id);return found;
    },
    dbPutTasks:async list=>{if(failWrite)throw Error('disk full');writes.push(list.map(x=>({...x})))},
    syncNativeReminder:t=>notifications.push({...t}),
    closeModal:id=>nav.push('close:'+id),
    switchBoard:async id=>{state.activeBoardId=id;state.tasks=state._tasksByBoard[id];nav.push('board:'+id)},
    switchView:id=>nav.push('view:'+id),
    openTaskModal:id=>nav.push('task:'+id),
    notifyOtherTabs:()=>nav.push('notify'),
    showToast:s=>toasts.push(s)
  };
  vm.createContext(ctx);
  vm.runInContext(tasks.slice(start,end),ctx);
  return {state,ctx,root,child,grand,completed,unchanged,existing,
    writes,notifications,nav,toasts,busy,setFail:val=>{failWrite=val}};
}

(async()=>{
  {
    const f=fixture();
    assert.equal(await f.ctx.moveTaskToBoard('r','b2'),true);
    assert.equal(f.writes.length,1,'All affected tasks must be persisted in one transaction');
    assert.equal(f.writes[0].length,3,'Move a full subtree, not just the root');
    assert.deepEqual(f.state._tasksByBoard.b1.map(t=>t.id),['d','other'],
      'Unrelated tasks stay on the source board');
    const moved=f.state._tasksByBoard.b2.filter(t=>t.id!=='dest');
    assert.equal(moved.length,3);
    assert(moved.every(t=>t.boardId==='b2' && t.columnId==='wip'),'Keep equivalent active status');
    assert.equal(moved.find(t=>t.id==='r').parentId,'','Root stays top level');
    assert.equal(moved.find(t=>t.id==='c').parentId,'r');
    assert.equal(moved.find(t=>t.id==='g').parentId,'c');
    assert.equal(moved.find(t=>t.id==='r').files[0].id,'photo1','Attachment reference must survive');
    assert.equal(moved.find(t=>t.id==='r').deadline,'2026-11-12','Deadline survives');
    assert.equal(moved.find(t=>t.id==='r').reminder,'2026-11-12T09:00','Reminder survives');
    assert(moved.find(t=>t.id==='r').order<f.existing.order,'Move task to top of destination');
    assert.equal(f.notifications.length,3,'Native reminder board labels must be refreshed');
    assert.deepEqual(f.nav.slice(-3),['board:b2','view:kanban','task:r'],
      'Show the relocated task on its destination board');
    assert.equal(f.busy.size,0,'Writing lock must release after success');
  }
  {
    const f=fixture();
    assert.equal(await f.ctx.moveTaskToBoard('c','b2'),true,'Nested subtrees can move independently');
    assert.deepEqual(f.state._tasksByBoard.b1.map(t=>t.id),['r','d','other']);
    const moved=f.state._tasksByBoard.b2;
    assert.equal(moved.find(t=>t.id==='c').parentId,'',
      'Moving a child away from its parent makes it a root task');
    assert.equal(moved.find(t=>t.id==='g').parentId,'c');
  }
  {
    const f=fixture();
    assert.equal(await f.ctx.moveTaskToBoard('d','b2'),true);
    const done=f.state._tasksByBoard.b2.find(t=>t.id==='d');
    assert.equal(done.columnId,'closed','Completed task remains completed');
    assert.equal(done.completedAt,123456,'Preserve original completion timestamp');
  }
  {
    const f=fixture();
    f.state.boards[1].columns=f.state.boards[1].columns.filter(c=>!c.isDone);
    assert.equal(await f.ctx.moveTaskToBoard('d','b2'),false,'Never silently reopen completed tasks');
    assert.equal(f.writes.length,0);
    assert.equal(f.state._tasksByBoard.b1.length,5);
  }
  {
    const f=fixture();
    f.busy.add('c');
    assert.equal(await f.ctx.moveTaskToBoard('r','b2'),false,'Concurrent subtree writes must be refused');
    assert.equal(f.writes.length,0);
    assert.equal(f.state._tasksByBoard.b1.length,5);
  }
  {
    const f=fixture();
    f.setFail(true);
    assert.equal(await f.ctx.moveTaskToBoard('r','b2'),false,'Database failures must stop moves');
    assert.equal(f.state._tasksByBoard.b1.length,5,'No in-memory mutations on failed write');
    assert.equal(f.state._tasksByBoard.b2.length,1);
    assert.equal(f.notifications.length,0,'Do not update notification metadata on failure');
    assert.equal(f.nav.length,0,'Keep the editor open when storage fails');
    assert(f.toasts.some(t=>t.includes('disk full')));
    assert.equal(f.busy.size,0,'Writing lock releases on failure');
    assert.equal(await f.ctx.moveTaskToBoard('r','missing'),false,'Invalid destinations must be refused');
    assert.equal(f.writes.length,0);
  }
  console.log('Cross-board move: atomic subtree transfer, status, media, reminders, navigation, and rollback passed');
})().catch(e=>{console.error(e);process.exitCode=1});

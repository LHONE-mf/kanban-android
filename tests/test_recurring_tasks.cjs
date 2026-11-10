// Recurring task scheduling and atomic completion regression tests (Node vm, no Android).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
process.env.TZ = 'Europe/Berlin';

const core = fs.readFileSync('app/src/main/js-src/core.js','utf8');
const tasksSource = fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
const views = fs.readFileSync('app/src/main/js-src/views.js','utf8');
const interactions = fs.readFileSync('app/src/main/js-src/interactions.js','utf8');
const extras = fs.readFileSync('app/src/main/js-src/android-extras.js','utf8');
const html = fs.readFileSync('app/src/main/assets/kanban.html','utf8');
const focusedFlow = fs.readFileSync('.maestro/recurring-search.yaml','utf8');
// Maestro's id field is a regular expression, not a plain string. Parentheses
// must be escaped or the copy exists but the UI test cannot locate it.
const copySelectors = focusedFlow.split('\n')
  .map(line => line.trim())
  .filter(line => line.startsWith("id: '^CI weekly recurring task "))
  .map(line => line.slice(5,-1));
assert.equal(copySelectors.length,4,'Check recurring copy both before and after app restart');
for (const source of copySelectors) {
  const selector = new RegExp(source);
  assert(selector.test('CI weekly recurring task (повтор)'),
    'Recurring-copy accessibility selector must match literal parentheses');
  assert(!selector.test('CI weekly recurring task'),
    'Recurring-copy selector must exclude the completed original');
}


const start = tasksSource.indexOf('// RECURRING TASKS');
const end = tasksSource.indexOf('// ============================================================\n// TASK OPS',start);
assert(start>=0 && end>start, 'Shared task recurrence helper must be defined before TASK OPS');
assert(html.includes('id="taskRepeat"'),'Task editor must offer a separate recurring-task selector');
for(const value of ['none','daily','weekly','monthly']) {
  assert(html.includes('value="'+value+'"'), 'Missing task recurrence option '+value);
}
assert(/taskRepeat:\s*.*t\.taskRepeat/.test(core),'Sanitizer must preserve recurring task setting');
assert(core.includes('repeatFrom:'),'Sanitizer must preserve idempotency relation');
assert(core.includes('repeatAnchor:'),'Sanitizer must preserve monthly calendar anchor');
assert(tasksSource.includes("taskRepeat: $('#taskRepeat').value"),'Editor must persist recurrence');
assert(tasksSource.includes("setTaskRepeat(task.taskRepeat || 'none')"),'Editor must restore recurrence through accessible controls');
assert(tasksSource.includes("taskRepeat: $('#taskRepeat').value"),'Dirty modal snapshot must include recurrence');
assert(views.includes('await persistTaskChanges('),'Card completion must use recurring transaction');
assert(interactions.includes('await persistTaskChanges('),'Drag and drop must use recurring transaction');
assert(extras.includes('await persistTaskChanges('),'Notification Mark Done must use recurring transaction');

const board={id:'work',columns:[
  {id:'todo',isDone:false},{id:'doing',isDone:false},{id:'done',isDone:true}
]};
const scheduled=[],writes=[];
let rejectWrites=false;
let n=0;
const ctx={
  Date,Math,console,
  generateId:()=>String(++n),
  toISO:d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'),
  parseISO:s=>{const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d)},
  isValidISODate:s=>/^\d{4}-\d{2}-\d{2}$/.test(s),
  formatTaskLocalDate:(d, withTime=false)=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')+
    (withTime?'T'+[String(d.getHours()).padStart(2,'0'),String(d.getMinutes()).padStart(2,'0')].join(':'):''),
  dbPutTasks:async x=>{if(rejectWrites) throw Error('disk full');writes.push(x)},
  syncNativeReminder:t=>scheduled.push(t.id)
};
vm.createContext(ctx);
vm.runInContext(tasksSource.slice(start,end),ctx);
const next=(date,mode,completed,anchor)=>ctx.nextTaskRepeatDate(date,mode,completed,anchor);

assert.equal(next('2026-11-10','daily',new Date(2026,10,10,13).getTime()),'2026-11-11');
assert.equal(next('2026-11-09','weekly',new Date(2026,10,16,10).getTime()),'2026-11-23');
assert.equal(next('2027-01-31','monthly',new Date(2027,0,31,16).getTime()),'2027-02-28');
assert.equal(next('2027-02-28','monthly',new Date(2027,1,28,16).getTime(),'2027-01-31'),'2027-03-31');
assert.equal(next('2028-01-31','monthly',new Date(2028,0,31,16).getTime()),'2028-02-29');
assert.equal(next('2026-01-10','daily',new Date(2026,10,10,16).getTime()),'2026-11-11','Skip overdue occurrences');
assert.equal(next('2027-03-27','daily',new Date(2027,2,27,18).getTime()),'2027-03-28','DST spring');
assert.equal(next('2027-10-30','daily',new Date(2027,9,30,18).getTime()),'2027-10-31','DST fall');

const root={
  id:'parent',boardId:'work',parentId:'',columnId:'doing',title:'Inspect battery lots',
  desc:'Checklist repeated',priority:'high',tags:['QC'],taskRepeat:'monthly',
  repeatFrom:'',repeatAnchor:'2027-01-31',reminder:'2027-01-31T08:30',
  reminderRepeat:'none',deadline:'2027-01-31',completedAt:null,
  checklist:[{id:'cl-old',text:'Measure',checked:true}],files:[{id:'media-original',type:'image/jpeg'}],
  order:2,createdAt:1,updatedAt:1
};
const child={
  ...root,id:'child',parentId:'parent',taskRepeat:'none',
  title:'Verify labels',checklist:[{id:'c2',text:'Read',checked:true}],
  files:[],reminder:'',deadline:'',order:0
};
const tasks=[root,child];
const when = new Date(2027,0,31,13).getTime();
const updated = {...root,columnId:'done',completedAt:when,updatedAt:when};
const generated=ctx.makeRecurringTaskCopies(root,tasks,board,when);
assert.equal(generated.length,2,'Generate fresh parent and nested task');
assert.equal(generated[0].columnId,'todo','Start next instance in first incomplete column');
assert.equal(generated[0].deadline,'2027-02-28');
assert.equal(generated[0].reminder,'2027-02-28T08:30');
assert.equal(generated[0].repeatAnchor,'2027-01-31');
assert.equal(generated[0].repeatFrom,'parent');
assert.equal(generated[0].completedAt,null);
assert.equal(generated[0].checklist[0].checked,false,'Reset checklist');
assert.equal(generated[0].files.length,0,'Never share media IDs between occurrences');
assert.equal(generated[1].parentId,generated[0].id,'Preserve nested parent relations');
assert.equal(generated[1].columnId,'todo');
assert.equal(generated[1].checklist[0].checked,false);
assert.notEqual(generated[0].id,generated[1].id);
assert.notEqual(generated[0].checklist[0].id,'cl-old');

// Next monthly completion must use the original Jan 31 anchor, not drift from Feb 28.
const afterFeb=ctx.makeRecurringTaskCopies(generated[0],generated,board,
  new Date(2027,1,28,13).getTime());
assert.equal(afterFeb[0].deadline,'2027-03-31');

(async()=>{
  const before=tasks.map(t=>({...t}));
  rejectWrites=true;
  await assert.rejects(ctx.persistTaskChanges([updated],tasks,board),/disk full/);
  assert.equal(tasks.length,2,'Failed DB transaction must not add recurrence');
  assert.equal(tasks[0],root,'Failed DB transaction must not mutate original');
  assert.equal(writes.length,0);
  assert.equal(scheduled.length,0);

  rejectWrites=false;
  const result=await ctx.persistTaskChanges([updated],tasks,board);
  assert.equal(writes.length,1,'Commit original and next occurrence in one transaction');
  assert.equal(writes[0].length,3);
  assert.equal(tasks.length,4);
  assert.equal(tasks[0].completedAt,when);
  assert.equal(result.created.length,2);
  assert.equal(scheduled.length,3,'Reconcile canceled original and fresh reminders');
  assert.equal(tasks[2].repeatFrom,'parent');

  await ctx.persistTaskChanges([{...tasks[0],updatedAt:when+1000}],tasks,board);
  assert.equal(tasks.length,4,'Updating the completed task cannot spawn another occurrence');
  // Reopening the original, then completing it again must not spawn duplicate recurrence.
  const reopened={...tasks[0],columnId:'doing',completedAt:null};
  await ctx.persistTaskChanges([reopened],tasks,board);
  await ctx.persistTaskChanges([{...reopened,columnId:'done',completedAt:when+2500}],tasks,board);
  assert.equal(tasks.length,4,'Idempotency persists when an old occurrence is reopened');

  const noDue={...root,id:'noDate',deadline:'',reminder:'',taskRepeat:'weekly',
    checklist:[],files:[],completedAt:null,columnId:'doing'};
  tasks.push(noDue);
  await ctx.persistTaskChanges([{...noDue,columnId:'done',completedAt:when}],tasks,board);
  assert.equal(tasks.at(-1).deadline,'2027-02-07','No due date means next week from completion date');
  // A notification may mark both the parent and all its descendants Done in one
  // transaction. If parent and child repeat, the child must not be duplicated.
  // Reversed input order exercises native queues independent of task ordering.
  const recurringParent={...root,id:'parentBoth',parentId:'',columnId:'doing',
    taskRepeat:'monthly',repeatFrom:'',completedAt:null};
  const repeatingChild={...child,id:'childBoth',parentId:'parentBoth',columnId:'doing',
    taskRepeat:'weekly',repeatAnchor:'2027-01-31',deadline:'2027-01-31',
    completedAt:null};
  const both=[recurringParent,repeatingChild];
  const completedBoth=[
    {...repeatingChild,columnId:'done',completedAt:when},
    {...recurringParent,columnId:'done',completedAt:when}
  ];
  const fromBoth=await ctx.persistTaskChanges(completedBoth,both,board);
  assert.equal(fromBoth.created.length,2,
    'Completing a repeating parent and repeating child together must only create one new tree');
  assert.equal(both.length,4,'No extra standalone recurring child');
  const newRoot=both.find(t=>t.repeatFrom==='parentBoth');
  const newChild=both.find(t=>t.repeatFrom==='childBoth');
  assert(newRoot&&newChild);
  assert.equal(newChild.parentId,newRoot.id,
    'The repeated child belongs to the new parent, not the finished occurrence');

  // If the parent is not repeating but a child is, the new child becomes a root.
  // It must not end up hidden under the newly completed parent.
  const onceParent={...root,id:'parentOnce',taskRepeat:'none',columnId:'doing',
    parentId:'',completedAt:null};
  const weeklyChild={...repeatingChild,id:'childWeekly',parentId:'parentOnce',
    columnId:'doing',completedAt:null};
  const mixed=[onceParent,weeklyChild];
  const newChildren=await ctx.persistTaskChanges([
    {...onceParent,columnId:'done',completedAt:when},
    {...weeklyChild,columnId:'done',completedAt:when}
  ],mixed,board);
  assert.equal(newChildren.created.length,1,'Child recurrence remains enabled');
  assert.equal(newChildren.created[0].parentId,'',
    'Repeated child cannot remain nested under a parent completed in the same batch');
  assert.equal(mixed.length,3);

  console.log('Recurring tasks: DST/monthly anchors, nested copies, attachments, atomic saves, retries and reopens passed');
})().catch(e=>{console.error(e);process.exitCode=1});

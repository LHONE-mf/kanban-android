// Daily plan tests: deterministic all-board ranking, safe persistence and date isolation.
// These run without Android, IndexedDB, a phone, or an LLM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const state = {
  activeBoardId:'lab',
  boards:[
    {id:'lab',name:'Лаборатория',
      columns:[{id:'todo',isDone:false},{id:'doing',isDone:false},{id:'done',isDone:true}]},
    {id:'prod',name:'Производство',
      columns:[{id:'todo',isDone:false},{id:'done',isDone:true}]}
  ],
  _tasksByBoard:{
    lab:[
      {id:'overdue-high',title:'Просроченный анализ',boardId:'lab',columnId:'todo',
        priority:'high',deadline:'2026-11-17',parentId:''},
      {id:'today-medium',title:'Сегодня анализ',boardId:'lab',columnId:'todo',
        priority:'medium',deadline:'2026-11-19',parentId:''},
      {id:'inprogress',title:'Работа над отчётом',boardId:'lab',columnId:'doing',
        priority:'low',deadline:'',parentId:''},
      {id:'done',title:'Завершённый анализ',boardId:'lab',columnId:'done',
        priority:'high',deadline:'2026-11-18',parentId:''},
      {id:'tomorrow-high',title:'Завтра важный анализ',boardId:'lab',columnId:'todo',
        priority:'high',deadline:'2026-11-20',parentId:''},
      {id:'subtask',title:'Подзадача',boardId:'lab',columnId:'todo',
        priority:'high',deadline:'2026-11-19',parentId:'overdue-high'}
    ],
    prod:[
      {id:'today-high',title:'Сегодня производство',boardId:'prod',columnId:'todo',
        priority:'high',deadline:'2026-11-19',parentId:''},
      {id:'overdue-low',title:'Просроченная поставка',boardId:'prod',columnId:'todo',
        priority:'low',deadline:'2026-11-18',parentId:''},
      {id:'high-no-date',title:'Важное без срока',boardId:'prod',columnId:'todo',
        priority:'high',deadline:'',parentId:''},
      {id:'no-date-low',title:'Мелкое дело',boardId:'prod',columnId:'todo',
        priority:'low',deadline:'',parentId:''},
      {id:'future-low',title:'Через месяц',boardId:'prod',columnId:'todo',
        priority:'low',deadline:'2026-12-19',parentId:''}
    ]
  }
};
let writes=[];
const sandbox={
  state,
  PRIORITY_ORDER:{high:3,medium:2,low:1,none:0},
  todayISO:()=> '2026-11-19',
  comradeTasks:()=>Object.values(state._tasksByBoard).flat(),
  dbPutSettingsBulk:async rows=>{writes.push(rows);},
  console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('app/src/main/js-src/daily-plan.js','utf8'),sandbox);
const rows=sandbox.comradeDayCandidates('2026-11-19');
assert.ok(rows.length>=6,'all relevant tasks included');
assert.ok(rows.some(t=>t.id==='today-high' && t.board==='Производство'),'cross-board result');
assert.ok(rows.some(t=>t.id==='today-medium' && t.board==='Лаборатория'),'active board result');
assert.ok(rows.some(t=>t.id==='high-no-date'),'important unscheduled tasks included');
assert.ok(rows.some(t=>t.id==='inprogress'),'work-in-progress included');
assert.ok(rows.some(t=>t.id==='tomorrow-high'),'tomorrow high priority included');
for(const id of ['done','subtask']) {
  assert.ok(!rows.some(t=>t.id===id),'exclude '+id);
}
assert.ok(rows.some(t=>t.id==='future-low'),'future tasks remain selectable');
assert.ok(rows.some(t=>t.id==='no-date-low'),'unscheduled tasks remain selectable');
assert.ok(rows.findIndex(t=>t.id==='overdue-high')<
  rows.findIndex(t=>t.id==='today-high'),'overdue before due today');
assert.ok(rows.findIndex(t=>t.id==='today-high')<
  rows.findIndex(t=>t.id==='today-medium'),'high priority first within date');

const saved={date:'2026-11-19',ids:['inprogress','today-high']};
const restored=sandbox.comradeDayDraft(rows,saved,'2026-11-19',false);
assert.equal(restored.fromSaved,true);
assert.equal(restored.rows[0].id,'inprogress');
assert.equal(restored.rows[1].id,'today-high');
assert.equal(JSON.stringify([...restored.selected]),JSON.stringify(saved.ids));
const refresh=sandbox.comradeDayDraft(rows,saved,'2026-11-19',true);
assert.equal(refresh.fromSaved,false);
assert.equal(refresh.rows[0].id,'overdue-high');
const nextDay=sandbox.comradeDayDraft(rows,saved,'2026-11-20',false);
assert.equal(nextDay.fromSaved,false);
const stale=sandbox.comradeDayDraft(rows,{date:'2026-11-19',ids:['deleted-task']},'2026-11-19');
assert.equal(stale.fromSaved,false);
assert.ok(stale.selected.length>0);

const before=JSON.stringify(state._tasksByBoard);
(async()=>{
  const persisted=await sandbox.comradePersistDay(['today-high','overdue-high','today-high','done'],'2026-11-19');
  assert.deepEqual([...persisted],['today-high','overdue-high']);
  assert.equal(writes.length,1);
  assert.equal(writes[0][0][0],'comrade_day_plan_v1');
  assert.equal(writes[0][0][1].date,'2026-11-19');
  assert.deepEqual([...writes[0][0][1].ids],['today-high','overdue-high']);
  assert.equal(JSON.stringify(state._tasksByBoard),before,'save does not change tasks');
  await assert.rejects(
    sandbox.comradePersistDay(['done'],'2026-11-19'),/незаверш/);
  await assert.rejects(
    sandbox.comradePersistDay(['today-high'],'2026-11-18'),/новый день/);
  assert.equal(writes.length,1,'invalid saves do not mutate settings');
  console.log('Comrade daily plan: cross-board ranking, exclusions, persisted order and read-only tasks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});

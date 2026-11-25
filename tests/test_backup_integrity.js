// Regression: a full backup must contain all referenced media and day/Japanese state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync('app/src/main/js-src/data-transfer.js', 'utf8');
const prefix = src.slice(src.indexOf('const JAPANESE_BACKUP_KEYS'), src.indexOf('function blobToBase64('));
const planSource = src.slice(src.indexOf('function base64ToBlob('), src.indexOf('async function handleImport('));
assert.ok(prefix.startsWith('const JAPANESE_BACKUP_KEYS'));
const day = {date:'2026-11-20', ids:['t1'], updatedAt:100};
const task = {id:'t1', boardId:'b', columnId:'todo', title:'Photo', parentId:'',
  deadline:'', files:[{id:'f1',name:'photo.png',type:'image/png',size:3}]};
const stored = new Map([
  ['kanban-japanese-hiragana-v1','["あ"]'],
  ['kanban-japanese-script-v1','katakana']
]);
const localStorage = {
  getItem:key => stored.has(key) ? stored.get(key) : null,
  setItem:(key,value) => stored.set(key,value),
  removeItem:key => stored.delete(key)
};
const notices = [];
const created = [];
let downloads = 0;
let lookup = async()=>null;
const context = {
  Date, JSON, Blob, Map, Set, window:{}, location:{origin:'https://browser.example'}, console:{error() {}},
  state:{activeBoardId:'b', boards:[{id:'b',name:'Board',columns:[{id:'todo'}]}],
    _tasksByBoard:{b:[task]}},
  dbGetSettings:async()=>({comrade_day_plan_v1:day}),
  mediaGet:async id=>lookup(id),
  blobToBase64:async()=> 'data:image/png;base64,UE5H',
  localStorage,
  document:{body:{appendChild(){}},
    createElement:()=>({click(){downloads++;},remove(){}})},
  URL:{createObjectURL:blob=>{created.push(blob);return 'blob:backup';}, revokeObjectURL(){}},
  setTimeout(){},
  todayISO:()=> '2026-11-20',
  showToast:message=>notices.push(message),
  sanitizeBoard:b=>b,
  PRIORITY_LABELS:{none:'Без'},
  normalizeTree(){},
  DEFAULT_COLUMNS:()=>[{id:'todo'}],
  generateId:()=> 'generated',
  isValidISODate:s=>/^\d{4}-\d{2}-\d{2}$/.test(s),
  MAX_VIDEO_SIZE:50*1048576
};
vm.createContext(context);
const actualCore=fs.readFileSync('app/src/main/js-src/core.js','utf8');
const sanitizer=actualCore.slice(actualCore.indexOf('function sanitizeTask('),actualCore.indexOf('function sanitizeColumn('));
vm.runInContext(sanitizer+'\n'+prefix+'\n'+planSource,context);
async function attempt(value) {
  lookup = value;
  created.length = 0; downloads = 0; notices.length = 0;
  await context.exportData();
  return {created:created.slice(),downloads,notices:notices.slice()};
}
(async()=>{
  const missing = await attempt(async()=>null);
  assert.equal(missing.downloads,0);
  assert.equal(missing.created.length,0);
  assert.ok(missing.notices.some(t=>t.includes('Ошибка экспорта')&&t.includes('photo.png')));
  const broken = await attempt(async()=>{throw Error('I/O error');});
  assert.equal(broken.downloads,0);
  assert.equal(broken.created.length,0);
  const ok = await attempt(async()=>({full:new Blob(['PNG'],{type:'image/png'}),
    thumb:null,type:'image/png'}));
  assert.equal(ok.downloads,1);
  assert.equal(ok.created.length,1);
  const archive = JSON.parse(await ok.created[0].text());
  assert.equal(archive.version,6);
  assert.equal(archive.nativeJapanese,null,'browser-only backup has no Android mini-quiz');
  assert.equal(archive.tasks.length,1);
  assert.ok(archive.media.f1);
  assert.equal(archive.dayPlan.ids[0],'t1');
  assert.equal(archive.japanese['kanban-japanese-hiragana-v1'],'["あ"]');
  assert.equal(archive.japanese['kanban-japanese-script-v1'],'katakana');

  // A result-bearing archive is explicitly versioned to avoid older importers
  // silently discarding results.
  const record={id:'result1',text:'Verified independently',createdAt:10,updatedAt:20};
  task.results=[record];
  const withResults=await attempt(async()=>({full:new Blob(['PNG'],{type:'image/png'}),thumb:null,type:'image/png'}));
  const resultArchive=JSON.parse(await withResults.created[0].text());
  assert.equal(resultArchive.version,7);
  assert.deepEqual(resultArchive.tasks[0].results,[record]);
  const resultPlan=await context.buildImportPlan({...resultArchive,tasks:[{...task,files:[]}]});
  assert.equal(resultPlan.tasks[0].results[0].text,record.text);
  task.results=[{...record,text:''}];
  task.files[0].resultId=record.id;
  const linked=await attempt(async()=>({full:new Blob(['PNG'],{type:'image/png'}),thumb:null,type:'image/png'}));
  const linkedArchive=JSON.parse(await linked.created[0].text());
  assert.equal(linkedArchive.version,8);
  assert.equal(linkedArchive.tasks[0].files[0].resultId,record.id);
  assert.ok(linkedArchive.media.f1);
  // Import a real base64 payload with the actual task sanitizer.
  linkedArchive.media.f1.data='data:image/png;base64,UE5H';
  context.atob=atob;
  const linkedPlan=await context.buildImportPlan(linkedArchive);
  assert.equal(linkedPlan.tasks[0].results[0].id,record.id);
  assert.equal(linkedPlan.tasks[0].results[0].text,'');
  assert.equal(linkedPlan.tasks[0].files[0].resultId,record.id);
  assert.equal(linkedPlan.media.f1.full.size,3);
  await assert.rejects(context.buildImportPlan({...linkedArchive,media:{}}),/Архив неполный/);
  delete task.files[0].resultId;
  delete task.results;
  const importData = {version:5,boards:context.state.boards,
    activeBoardId:'b',tasks:[{...task,files:[]}],media:{},japanese:archive.japanese,
    dayPlan:{date:'2026-11-20',ids:['t1','not-present']}};
  const plan = await context.buildImportPlan(importData);
  assert.equal(plan.dayPlan.ids.length,1);
  assert.equal(plan.dayPlan.ids[0],'t1');
  assert.equal(plan.japanese['kanban-japanese-script-v1'],'katakana');
  assert.equal(plan.nativeJapanese,null,'older backups never overwrite native progress');
  const native = {question_count:16,correct_count:12,current_question:4,next_question:5,
    katakana_unlocked:false,review_queue:'2,3,8'};
  assert.equal(context.validateNativeJapaneseBackup(native).correct_count,12);
  assert.throws(()=>context.validateNativeJapaneseBackup({...native,correct_count:999}));
  assert.throws(()=>context.validateNativeJapaneseBackup({...native,review_queue:'-1'}));
  assert.throws(()=>context.validateNativeJapaneseBackup({...native,current_question:999}));
  const nativePlan = await context.buildImportPlan({...importData,version:6,
    nativeJapanese:native});
  assert.equal(nativePlan.nativeJapanese.review_queue,'2,3,8');
  await assert.rejects(context.buildImportPlan({...importData,version:6,
    tasks:[task],media:{}}),/Архив неполный/,'modern full backups may not drop attachments');
  const old = await context.buildImportPlan({version:4,boards:context.state.boards,
    tasks:[{...task,files:[]}],activeBoardId:'b',media:{}});
  assert.equal(old.dayPlan,null);
  assert.equal(old.japanese,null);
  assert.throws(()=>context.validateJapaneseBackup({'kanban-japanese-script-v1':{bad:true}}));
  assert.equal(context.validateJapaneseBackup({'evil-key':'bad'})['evil-key'],undefined);

  stored.set('kanban-japanese-script-v1','hiragana');
  context.restoreJapaneseBackup(plan.japanese);
  assert.equal(stored.get('kanban-japanese-script-v1'),'katakana');
  const core = fs.readFileSync('app/src/main/js-src/core.js','utf8');
  assert.ok(core.includes("if (plan.dayPlan) ss.put({ key: 'comrade_day_plan_v1', value: plan.dayPlan })"),
    'import commits day plan in the same IndexedDB transaction');
  const html = fs.readFileSync('app/src/main/assets/kanban.html','utf8');
  const firstHeader = html.slice(0,html.indexOf('</header>'));
  assert.ok(!firstHeader.includes('id="exportCsvBtn"'),'CSV belongs in settings not header');
  assert.equal((html.match(/id="exportCsvBtn"/g)||[]).length,1);
  console.log('Backup: no incomplete downloads; day plan, web Japanese progress and legacy import verified.');
})().catch(e=>{console.error(e);process.exitCode=1});

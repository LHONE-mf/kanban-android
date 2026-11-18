// Full backups must never claim success when referenced media is missing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const src = fs.readFileSync('app/src/main/js-src/data-transfer.js', 'utf8');
const start = src.indexOf('async function exportData()');
const end = src.indexOf('function blobToBase64(', start);
assert(start >= 0 && end > start, 'Real exportData implementation is required');
const exportSource = src.slice(start, end);

async function runExport(lookup) {
  const task = {id:'task-1', title:'Keep my photo', files:[
    {id:'photo-1',name:'before.png',type:'image/png',size:6}
  ]};
  const notices = [], backups = [];
  const context = {
    Date, JSON, Blob, console: {error() {}},
    state: {boards:[{id:'board-a',name:'Safe'}],activeBoardId:'board-a',
      _tasksByBoard:{'board-a':[task]}},
    window:{KanbanBackup:{postMessage(){}}},
    location:{origin:'https://appassets.androidplatform.net'},
    mediaGet:lookup,
    blobToBase64:async()=> 'data:image/png;base64,UE5H',
    readJapaneseBackup:()=>({'kanban-japanese-script-v1':'hiragana'}),
    saveBackupViaAndroid:async (blob,name)=>{backups.push({blob,name});return true},
    todayISO:()=> '2026-11-18',
    showToast:message=>notices.push(message)
  };
  vm.createContext(context);
  vm.runInContext(exportSource,context);
  await context.exportData();
  return {notices,backups};
}

(async()=>{
  const missing = await runExport(async()=>null);
  assert.equal(missing.backups.length,0,
    'A backup missing task attachments must not be presented as complete');
  assert(missing.notices.some(n=>n.includes('Ошибка экспорта') && n.includes('before.png')),
    'Report the missing attachment explicitly');

  const unreadable = await runExport(async()=>{throw Error('disk read failed')});
  assert.equal(unreadable.backups.length,0,
    'A failed media read must not be hidden behind a successful backup');

  const complete = await runExport(async()=>({
    full:new Blob(['PNG'],{type:'image/png'}),thumb:null,type:'image/png'
  }));
  assert.equal(complete.backups.length,1, 'Complete backups still export normally');
  const saved = JSON.parse(await complete.backups[0].blob.text());
  assert(saved.media['photo-1'], 'Actual attachment contents belong in the backup');
  assert.equal(saved.tasks[0].files[0].id,'photo-1');
  assert.equal(saved.japanese['kanban-japanese-script-v1'],'hiragana');
  assert(complete.notices.some(n=>n.includes('Бэкап сохранён')));

  console.log('Backup: missing/read-error attachments block export; complete data still exports');
})().catch(error=>{console.error(error);process.exitCode=1});

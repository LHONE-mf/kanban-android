// The full Kanban JSON backup must also protect Japanese learning progress.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app/src/main/js-src/data-transfer.js','utf8');
function section(start,end){
 const i=source.indexOf(start),j=source.indexOf(end,i);
 assert(i>=0&&j>i,'Missing backup section: '+start);
 return source.slice(i,j);
}
const initial={
 'kanban-japanese-hiragana-v1':JSON.stringify(['あ','い']),
 'kanban-japanese-review-v1':JSON.stringify({'あ':{interval:1,due:2000}}),
 'kanban-japanese-script-v1':'katakana',
 'kanban-japanese-quiz-progress-v1':JSON.stringify({score:2,total:3}),
 'kanban-japanese-active-tab-v1':'writing',
 'kanban_theme':'dark'
};
let entries=new Map(Object.entries(initial)),failKey=null,download;
const localStorage={
 getItem:key=>entries.has(key)?entries.get(key):null,
 setItem:(key,value)=>{if(key===failKey)throw new Error('Storage full');entries.set(key,String(value))},
 removeItem:key=>entries.delete(key)
};
const notices=[];
const ctx={
 localStorage,JSON,Blob,Date,console,
 state:{boards:[{id:'b1',name:'Board'}],_tasksByBoard:{b1:[]},activeBoardId:'b1',tasks:[]},
 window:{KanbanBackup:{postMessage(){}}},
 saveBackupViaAndroid:async(blob)=>{download=blob;return true},
 todayISO:()=> '2026-11-10',showToast:message=>notices.push(message),
 location:{origin:'https://appassets.androidplatform.net'},
 undoStack:[],pendingMediaDeletes:new Map(),thumbCache:new Map(),
 apStop:()=>{},rebucket:()=>{},applyActiveBoard:()=>{},renderBoard:()=>{},saveUIState:()=>{},
 confirmDialog:async()=>true,dbReplaceAll:async()=>{},alert:message=>notices.push(message),
 buildImportPlan:async(data)=>({
  boards:[{id:'b1'}],tasks:[],activeBoardId:'b1',media:{},
  japanese:ctx.selectJapaneseBackup(data.japanese), report:{warnings:[]}
 })
};
vm.createContext(ctx);
vm.runInContext(
 section('const JAPANESE_BACKUP_KEYS =','// Android saves through SAF') +
 section('async function exportData()','function blobToBase64(') +
 section('async function handleImport(', '// ============================================================\n// CLEAR'),
 ctx
);
(async()=>{
  const keys=Array.from(vm.runInContext('JAPANESE_BACKUP_KEYS',ctx));
  assert.equal(keys.length,5);
  await ctx.exportData();
  const backup=JSON.parse(await download.text());
  assert.deepEqual(Object.keys(backup.japanese).sort(),[...keys].sort());
  assert.equal(backup.japanese['kanban-japanese-script-v1'],'katakana');
  assert.equal(backup.japanese['kanban-japanese-hiragana-v1'],initial['kanban-japanese-hiragana-v1']);
  assert.equal(backup.japanese['kanban_theme'],undefined,'Backup uses a strict key allowlist');

  // Restoring replaces only the recognized progress keys, not unrelated settings.
  for(const key of keys)entries.delete(key);
  await ctx.handleImport({text:async()=>JSON.stringify(backup)});
  assert.equal(localStorage.getItem('kanban-japanese-hiragana-v1'),initial['kanban-japanese-hiragana-v1']);
  assert.equal(localStorage.getItem('kanban-japanese-script-v1'),'katakana');
  assert.equal(localStorage.getItem('kanban_theme'),'dark');

  // Old backups never clear more recent local Japanese progress.
  entries.set('kanban-japanese-hiragana-v1',JSON.stringify(['う']));
  await ctx.handleImport({text:async()=>JSON.stringify({boards:[],tasks:[],media:{}})});
  assert.equal(localStorage.getItem('kanban-japanese-hiragana-v1'),JSON.stringify(['う']));

  // A storage failure rolls back partial learning changes and warns the user.
  entries.set('kanban-japanese-hiragana-v1',JSON.stringify(['う']));
  failKey='kanban-japanese-review-v1';
  await ctx.handleImport({text:async()=>JSON.stringify(backup)});
  assert.equal(localStorage.getItem('kanban-japanese-hiragana-v1'),JSON.stringify(['う']),
    'A failed restore must not leave a partly overwritten learning record');
  assert(notices.some(n=>n.includes('не удалось записать')),
    'Import must explain if Japanese data could not be restored');

  const selected=ctx.selectJapaneseBackup({
    'kanban-japanese-review-v1':{bad:'object'},
    'kanban-japanese-script-v1':'a'.repeat(100001),
    'unrecognized':'malicious',
    'kanban-japanese-hiragana-v1':'["あ"]'
  });
  assert.deepEqual(Object.keys(selected),['kanban-japanese-hiragana-v1']);
  console.log('Full backup contains all Japanese progress; old files remain compatible; failed restore rolls back: passed');
})().catch(e=>{console.error(e);process.exitCode=1});

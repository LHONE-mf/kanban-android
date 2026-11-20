// C-05: trusted native Japanese progress transfer, validation and legacy safety.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/src/main/js-src/data-transfer.js','utf8');
const begin=source.indexOf('const JAPANESE_BACKUP_KEYS');
const end=source.indexOf('// Android saves through SAF',begin);
assert.ok(begin>=0&&end>begin);
const sent=[];
const context={
  window:{KanbanJapaneseProgress:{postMessage:x=>sent.push(JSON.parse(x))}},
  location:{origin:'https://appassets.androidplatform.net'},
  setTimeout:()=>1,clearTimeout:()=>{},Date,Math,JSON,Promise
};
vm.createContext(context);
vm.runInContext(source.slice(begin,end)+
  '\nthis.send=nativeJapaneseCommand;this.validate=validateNativeJapaneseBackup;',context);
const native={question_count:20,correct_count:18,current_question:9,next_question:10,
  katakana_unlocked:false,review_queue:'1,4,8'};
(async()=>{
  const pending=context.send('read');
  assert.equal(sent[0].type,'read');
  context.window.comradeJapaneseNativeResult(JSON.stringify({id:sent[0].id,type:'read',data:native}));
  assert.equal((await pending).correct_count,18);
  const restore=context.send('restore',native);
  assert.equal(sent[1].type,'restore');
  assert.equal(sent[1].data.review_queue,'1,4,8');
  context.window.comradeJapaneseNativeResult(JSON.stringify({id:sent[1].id,type:'restored'}));
  assert.equal(await restore,true);
  assert.equal(context.validate(null),null);
  assert.throws(()=>context.validate({...native,review_queue:'9,bad'}));
  const kotlin=fs.readFileSync('app/src/main/java/com/kanban/offline/MainActivity.kt','utf8');
  assert.ok(kotlin.includes('addWebMessageListener(webView, "KanbanJapaneseProgress", setOf(appOrigin))'));
  assert.ok(kotlin.includes('isMainFrame'));
  assert.ok(kotlin.includes('getSharedPreferences("japanese_daily", MODE_PRIVATE)'));
  assert.ok(kotlin.includes('private fun restoreMiniBackup('));
  assert.ok(kotlin.includes('.commit()'));
  console.log('Native Japanese progress bridge and validation passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

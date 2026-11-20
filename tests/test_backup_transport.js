// Regression: large Android backup transfers must be ordered and confirmed.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app/src/main/js-src/data-transfer.js','utf8');
const begin=source.indexOf('// Android saves through SAF, not WebView blob downloads.');
const end=source.indexOf('async function exportData()',begin);
assert.ok(begin>=0&&end>begin);
const native=fs.readFileSync('app/src/main/java/com/kanban/offline/KanbanBackupSaver.kt','utf8');
const activity=fs.readFileSync('app/src/main/java/com/kanban/offline/MainActivity.kt','utf8');
assert.ok(native.includes('Activity') || native.includes('ComponentActivity'));
assert.ok(native.includes('onDestinationPicked') && native.includes('32 * 1024'));
assert.ok(native.includes('transfer.bytesWritten != transfer.totalBytes'));
assert.ok(activity.includes('WebViewCompat.addWebMessageListener(webView, "KanbanBackup", setOf(appOrigin))'));
assert.ok(activity.includes('ActivityResultContracts.CreateDocument("application/json")'));
assert.ok(activity.includes('backupSaver.onDestinationPicked(uri)'));
function fixture() {
  const events=[];
  const window={KanbanBackup:{postMessage:raw=>events.push(JSON.parse(raw))}};
  const sandbox={window,Blob,Uint8Array,Math,Date,JSON,
    btoa:s=>Buffer.from(s,'binary').toString('base64'),
    console};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(begin,end),sandbox);
  return {events,window,sandbox};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const f=fixture();
  const expected=new Uint8Array(70000);
  for(let i=0;i<expected.length;i++)expected[i]=i%251;
  const promise=f.sandbox.saveBackupViaAndroid(new Blob([expected]),'kanban-backup-2026-11-20.json');
  assert.equal(f.events.length,1);
  const start=f.events.shift();
  assert.equal(start.type,'start');assert.equal(start.size,70000);
  f.window.kanbanBackupNativeResult(JSON.stringify({id:start.id,type:'ready'}));
  const pieces=[];
  for(let index=0;index<3;index++){
    await tick();
    const chunk=f.events.shift();
    assert.equal(chunk.type,'chunk');assert.equal(chunk.index,index);
    const bytes=Buffer.from(chunk.data,'base64');
    assert.ok(bytes.length>0 && bytes.length<=32768);
    pieces.push(bytes);
    f.window.kanbanBackupNativeResult(JSON.stringify({id:start.id,type:'ack',index:index+1}));
  }
  await tick();
  assert.equal(f.events.shift().type,'finish');
  assert.deepEqual(Buffer.concat(pieces),Buffer.from(expected));
  f.window.kanbanBackupNativeResult(JSON.stringify({id:start.id,type:'saved'}));
  assert.equal(await promise,true);

  const cancelled=fixture();
  const cancelledPromise=cancelled.sandbox.saveBackupViaAndroid(
    new Blob(['data']),'kanban-backup-2026-11-20.json');
  const startCancelled=cancelled.events[0];
  cancelled.window.kanbanBackupNativeResult(JSON.stringify({
    id:startCancelled.id,type:'cancelled'}));
  assert.equal(await cancelledPromise,false);

  const failure=fixture();
  const failurePromise=failure.sandbox.saveBackupViaAndroid(
    new Blob(['data']),'kanban-backup-2026-11-20.json');
  const startFailure=failure.events[0];
  failure.window.kanbanBackupNativeResult(JSON.stringify({
    id:startFailure.id,type:'error',message:'Disk full'}));
  await assert.rejects(failurePromise,/Disk full/);
  console.log('Android SAF backup: 3 ordered chunks, completion/cancel/error handshakes verified.');
})().catch(e=>{console.error(e);process.exitCode=1});

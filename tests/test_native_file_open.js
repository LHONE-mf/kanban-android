// C-09: bounded, ordered Android ACTION_VIEW transfer without external data access.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
const start=src.indexOf('let activeFileOpen = null;');
const end=src.indexOf('// ============================================================\n// ATOMIC SAVE',start);
assert.ok(start>0&&end>start);
const messages=[];
const sandbox={
  window:{KanbanFileOpen:{postMessage:raw=>messages.push(JSON.parse(raw))}},
  MAX_VIDEO_SIZE:50*1024*1024,Date,Math,Promise,Uint8Array,String,Blob,
  btoa:input=>Buffer.from(input,'binary').toString('base64'),
  setTimeout:()=>1,clearTimeout:()=>{},console
};
vm.createContext(sandbox);
vm.runInContext(src.slice(start,end)+
 '\nthis.openNative=openFileViaAndroid;this.response=window.kanbanFileOpenNativeResult;',sandbox);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const send=(request,type,extra={})=>sandbox.response(JSON.stringify({id:request.id,type,...extra}));
(async()=>{
  const source=new Blob([Buffer.alloc(65543,9)],{type:'application/pdf'});
  const task=sandbox.openNative(source,{name:'инструкция.pdf',type:'application/pdf'});
  assert.equal(messages.length,1);
  assert.equal(messages[0].type,'start');
  assert.equal(messages[0].size,65543);
  send(messages[0],'ready');
  await tick();
  for(let i=0;i<3;i++){
    const chunk=messages[messages.length-1];
    assert.equal(chunk.type,'chunk');
    assert.equal(chunk.index,i);
    const bytes=Buffer.from(chunk.data,'base64');
    assert.equal(bytes.length,i<2?32768:7);
    send(messages[0],'ack',{index:i+1});
    await tick();
  }
  assert.equal(messages[messages.length-1].type,'finish');
  send(messages[0],'opened');
  await task;
  const failed=sandbox.openNative(new Blob(['hello']),{name:'text.txt',type:'text/plain'});
  const second=messages[messages.length-1];
  send(second,'ready');
  await tick();
  send(second,'ack',{index:9});
  await assert.rejects(failed,/Сбой передачи/);
  assert.equal(messages[messages.length-1].type,'abort');
  const kotlin=fs.readFileSync('app/src/main/java/com/kanban/offline/MainActivity.kt','utf8');
  const transfer=fs.readFileSync('app/src/main/java/com/kanban/offline/KanbanAttachmentOpener.kt','utf8');
  assert.ok(kotlin.includes('addWebMessageListener(webView, "KanbanFileOpen", setOf(appOrigin))'));
  assert.ok(kotlin.includes('Intent(Intent.ACTION_VIEW)'));
  assert.ok(kotlin.includes('Intent.FLAG_GRANT_READ_URI_PERMISSION'));
  assert.ok(!kotlin.includes('Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION'));
  assert.ok(transfer.includes('chunk.size > 32 * 1024'));
  assert.ok(transfer.includes('50L * 1024 * 1024'));
  console.log('C-09 native document stream and permission regression passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

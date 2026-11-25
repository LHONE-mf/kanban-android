// Regression: audio decoder failure cannot persist an orphaned blob.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
const start=source.indexOf('async function storeFile(');
const end=source.indexOf('async function editAttachmentExternally(',start);
assert.ok(start>=0 && end>start);
function fixture(reject) {
  const writes=[];
  const context={Blob, console, generateId:()=> 'id123',
    mediaPut:async(...args)=>{writes.push(args);},
    prepAudio:async()=>{if(reject)throw Error('cannot decode audio');return {dur:12,peaks:[10,20]};}};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end),context);
  return {context,writes};
}
(async()=>{
  const file={name:'audio.ogg',type:'audio/ogg',size:100,_resultId:'result1'};
  const fail=fixture(true);
  await assert.rejects(fail.context.storeFile(file),/cannot decode audio/);
  assert.equal(fail.writes.length,0);
  const ok=fixture(false);
  const saved=await ok.context.storeFile(file);
  assert.equal(ok.writes.length,1);
  assert.equal(saved.id,'m_id123');
  assert.equal(saved.dur,12);
  assert.equal(saved.name,'audio.ogg');
  assert.equal(saved.peaks.length,2);
  assert.equal(saved.resultId,'result1','recorded or selected audio keeps result association');
  console.log('Audio: successful save keeps metadata, failed decoding never writes.');
})().catch(e=>{console.error(e);process.exitCode=1});

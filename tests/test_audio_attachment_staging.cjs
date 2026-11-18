// A failed audio metadata read must not leave an unreferenced media blob.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
const start=source.indexOf('async function storeFile(');
const end=source.indexOf('async function editAttachmentExternally(',start);
assert(start>=0&&end>start,'Real storeFile path must be loaded');

function fixture(failDecode){
  const saved=[];
  const ctx={
    Blob,Date,console,Math,
    generateId:()=> 'test-id',
    mediaPut:async (...args)=> saved.push(args),
    prepAudio:async()=> {
      if(failDecode)throw Error('audio decoder unavailable');
      return {dur:5,peaks:[0.1,0.9]};
    }
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start,end),ctx);
  return {ctx,saved};
}

(async()=>{
  const audio={name:'recording.ogg',type:'audio/ogg',size:7};
  const failure=fixture(true);
  await assert.rejects(failure.ctx.storeFile(audio),/audio decoder unavailable/);
  assert.equal(failure.saved.length,0,
    'Decoder failure must not persist a media record nobody can reference');

  const complete=fixture(false);
  const meta=await complete.ctx.storeFile(audio);
  assert.equal(complete.saved.length,1,'Valid audio is stored exactly once');
  assert.equal(meta.id,'m_test-id');
  assert.equal(meta.name,'recording.ogg');
  assert.equal(meta.dur,5);
  assert.equal(meta.peaks.length,2);
  assert.equal(complete.saved[0][0],meta.id);

  console.log('Audio attachments: prepare metadata before write; failed decode leaves no orphan');
})().catch(e=>{console.error(e);process.exitCode=1});

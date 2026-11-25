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
  const extras=fs.readFileSync('app/src/main/js-src/android-extras.js','utf8');
  const manifest=fs.readFileSync('app/src/main/AndroidManifest.xml','utf8');
  const native=fs.readFileSync('app/src/main/java/com/kanban/offline/KanbanVoiceRecorder.kt','utf8');
  const activity=fs.readFileSync('app/src/main/java/com/kanban/offline/MainActivity.kt','utf8');
  assert.match(manifest,/android:name="android\.permission\.RECORD_AUDIO"/);
  assert.doesNotMatch(extras,/getUserMedia|new MediaRecorder/);
  assert.match(native,/setAudioSamplingRate\(48000\)/);
  assert.match(native,/setAudioEncodingBitRate\(128000\)/);
  assert.match(native,/AudioEncoder\.AAC/);
  assert.match(native,/HandlerThread/);
  assert.match(activity,/addWebMessageListener\(webView, "KanbanVoice", setOf\(appOrigin\)\)/);
  assert.match(native,/path != current.token/);
  const recSrc=extras.slice(extras.indexOf('const rec ='),extras.indexOf('async function registerServiceWorker()'));
  assert.ok(recSrc.length>100);
  const commands=[],files=[],notices=[],nodes=new Map();
  let serial=0,failFetch=false;
  const session=[{id:'r1'}];
  const audioBlob=new Blob(['audio'],{type:'audio/mp4'});
  const env={tempResults:session,newFiles:files,savingTask:false,MAX_VIDEO_SIZE:50*1024*1024,
    File:class extends Blob{constructor(chunks,name,opts){super(chunks,opts);this.name=name;}},
    window:{KanbanVoice:{postMessage:raw=>commands.push(JSON.parse(raw))}},
    generateId:()=>String(++serial),apStop(){},renderFiles(){},showToast:m=>notices.push(m),
    $:selector=>{if(!nodes.has(selector))nodes.set(selector,{classList:{contains:()=>true},children:[],replaceChildren(){},scrollIntoView(){}});return nodes.get(selector);},
    fetch:async()=>{if(failFetch)throw Error('transfer failed');return {ok:true,blob:async()=>audioBlob};}
  };
  vm.createContext(env);vm.runInContext(recSrc+'\nthis.recordState=rec;',env);
  const send=(id,type,extra={})=>env.window.kanbanVoiceNativeResult(JSON.stringify({id,type,...extra}));
  const ready={token:'a'.repeat(36),ms:1500,size:audioBlob.size,peaks:[20,40]};
  env.recStart('r1');
  const first=commands.at(-1).id;
  assert.equal(env.recordState.starting,true);
  send(first,'started');
  assert.equal(env.recordState.active,true);
  env.recPause();assert.equal(commands.at(-1).type,'pause');
  const stop=env.recStop();
  assert.equal(commands.at(-1).type,'stop');
  send(first,'ready',ready);
  assert.equal(await stop,true);
  assert.equal(files.length,1);
  assert.equal(files[0]._resultId,'r1');
  assert.equal(files[0].type,'audio/mp4');
  assert.equal(files[0]._meta.dur,1.5);
  assert.equal(commands.at(-1).type,'ack');
  env.recStart('r1');
  const second=commands.at(-1).id;
  send(second,'started');
  failFetch=true;
  const failing=env.recStop();send(second,'ready',ready);
  assert.equal(await failing,false);
  assert.equal(files.length,1);
  assert.equal(env.recordState.ready.token,ready.token,'failed transfer retains retryable file');
  assert.notEqual(commands.at(-1).type,'ack');
  failFetch=false;
  assert.equal(await env.recStop(),true);
  assert.equal(files.length,2);
  env.recStart('r1');
  const third=commands.at(-1).id;
  send(third,'started');
  env.recAbort();
  send(third,'ready',ready);
  assert.equal(files.length,2,'cancelled session cannot attach late file');
  assert.equal(commands.at(-1).type,'cancel');
  env.recStart('r1');
  const fourth=commands.at(-1).id;
  send(fourth,'started');
  const pending=env.recStop();
  env.tempResults=[];
  send(fourth,'ready',ready);
  assert.equal(await pending,false);
  assert.equal(files.length,2,'different editor cannot receive old recording');
  console.log('Native voice: session identity, retry, cancel, result association and capture contract verified.');
})().catch(e=>{console.error(e);process.exitCode=1});

(async () => {
  const extras = fs.readFileSync('app/src/main/js-src/android-extras.js', 'utf8');
  const audio = extras.slice(extras.indexOf('const fmtDur'), extras.indexOf('function createAudioPlayer'));
  const messages = [], states = [], notices = [];
  const id = 'aaa00000-0000-4000-8000-000000000000';
  let blockChunk = false, rejectFormat = false;
  class TestAudio extends EventTarget {
    paused = true;
    ended = false;
    duration = 12;
    currentTime = 0;
    get src() { return this.url || ''; }
    set src(value) {
      this.url = value;
      queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
    }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
    removeAttribute() { this.url = ''; }
    load() {}
  }
  const env = {
    Audio: TestAudio, TextEncoder, window: {}, navigator: {},
    crypto: { randomUUID: () => id }, setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout,
    createTrackedURL: () => 'blob:fallback', revokeTrackedURL() {}, showToast: text => notices.push(text)
  };
  function event(type, fields = {}) {
    env.window.kanbanMediaNativeResult(JSON.stringify({ id, type, ...fields }));
  }
  env.KanbanMedia = { postMessage(raw) {
    if (typeof raw === 'string') {
      const data = JSON.parse(raw);
      messages.push(data);
      assert.equal(data.id, id);
      if (data.type === 'begin') event('begin');
      if (data.type === 'finish') {
        if (rejectFormat) event('error', { message: 'unknown codec' });
        else event('loaded', { dur: 12, t: 0, playing: false });
      }
    } else {
      const frame = Buffer.from(raw);
      assert.equal(frame.subarray(0, 36).toString(), id);
      messages.push(frame.length - 36);
      if (!blockChunk) event('chunk');
    }
  } };
  vm.runInNewContext(audio + '\nthis.player = AP;', env);

  const ui = {
    key: 'media1', scope: 'modal', getBlob: async () => new Blob([Buffer.alloc(300000)]),
    root: { isConnected: true, classList: { add() {}, remove() {} } },
    render: state => states.push(state)
  };
  env.player.uis.add(ui);
  await env.apPlay(ui, 0.5);
  assert.deepEqual(messages.map(value => value.type || value), ['begin', 262144, 37856, 'finish', 'play']);
  assert.equal(messages.at(-1).fraction, 0.5);
  assert.equal(env.player.el.src, '', 'native playback does not allocate a WebView blob URL');
  event('state', { playing: true, t: 6, dur: 12 });
  assert.equal(states.at(-1).t, 6);
  env.apToggle(ui);
  assert.equal(messages.at(-1).type, 'pause');

  env.apStop();
  rejectFormat = true;
  await env.apPlay(ui);
  assert.equal(env.player.nativeId, null);
  assert.equal(env.player.el.src, 'blob:fallback', 'older formats can still use the WebView decoder');
  assert.equal(env.player.el.paused, false);

  blockChunk = true;
  rejectFormat = false;
  env.apStop();
  const inFlight = env.apPlay(ui);
  while (messages.at(-1) !== 262144) await new Promise(setImmediate);
  env.apStop('modal');
  await inFlight;
  assert.equal(messages.at(-1).type, 'discard');
  assert.equal(env.player.id, null);
  assert.equal(env.player.el.src, '', 'cancelled loads never start the fallback');
  assert.deepEqual(notices, []);
  console.log('Native player: binary chunk bounds, position, pause, compatibility and cancelled transfer verified.');
})().catch(error => { console.error(error); process.exitCode = 1; });

// C-07: adaptive images must not increase storage size or destroy transparency.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/media-dialogs.js', 'utf8');
const start = source.indexOf('async function compressImage(');
const end = source.indexOf('function generateThumb(', start);
assert.ok(start >= 0 && end > start);
async function scenario(type, size, mimeSupported = true) {
  const calls = { fills:0, types:[], revoked:0, draws:0 };
  const context = {
    URL: {createObjectURL: ()=>'blob:sample',revokeObjectURL:()=>calls.revoked++},
    Image: class {
      constructor() {this.width=4000;this.height=3000;}
      set src(_) { Promise.resolve().then(()=>this.onload()); }
    },
    document: {createElement:()=>({
      width:0,height:0,
      getContext() { return {
        clearRect() {}, fillRect() {calls.fills++;}, drawImage() {calls.draws++;}
      }; },
      toBlob(fn, mime, q) {
        calls.types.push(mime);
        const target = mimeSupported ? mime : 'image/png';
        const size = q > .7 ? 2_900_000 : 1_250_000;
        fn({type:target,size});
      }
    })},
    Promise, Math
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start,end)+'\nthis.compress=compressImage;',context);
  const input = {type,size,name:'photo.png'};
  const result = await context.compress(input,1600,.82);
  return {result,calls,input};
}
(async()=>{
  const small = await scenario('image/png',1_000_000);
  assert.equal(small.result,small.input,'small images remain byte-for-byte unchanged');
  assert.equal(small.calls.draws,0);
  const jpeg = await scenario('image/jpeg',12_000_000);
  assert.equal(jpeg.result.type,'image/jpeg');
  assert.ok(jpeg.result.size <= 2*1024*1024);
  assert.ok(jpeg.calls.fills>0,'JPEG explicitly gets an opaque background');
  assert.equal(jpeg.calls.revoked,1);
  const png = await scenario('image/png',15_000_000);
  assert.equal(png.result.type,'image/webp','preserve PNG alpha with WebP');
  assert.equal(png.calls.fills,0,'no opaque fill for alpha-capable formats');
  assert.equal(png.calls.revoked,1);
  const fallback = await scenario('image/png',10_000_000,false);
  assert.equal(fallback.result,fallback.input,'do not silently convert to unsupported codec');
  const tasks = fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
  const saved = [];
  const original = Object.assign(new Blob(['transparency'], { type: 'image/png' }), { name: 'photo.png', _resultId: 'r1' });
  const derived = new Blob(['webp'], { type: 'image/webp' });
  const thumb = new Blob(['preview'], { type: 'image/webp' });
  let fail = false;
  const discarded = [];
  const env = {
    generateId: () => 'test', mediaPut: async (...args) => saved.push(args),
    crypto: { randomUUID: () => 'session' }, KanbanMedia: { postMessage() {} },
    mediaDiscard: id => discarded.push(id),
    stageNativeMedia: async (_id, blob) => {
      assert.equal(blob, original);
      return { mime: derived.type, originalMime: original.type, fullSize: derived.size, thumbSize: thumb.size };
    },
    fetch: async path => ({ ok: !fail, blob: async () => path.endsWith('/full') ? derived : thumb }),
    FileReader: class { readAsDataURL(blob) { this.result = 'data:' + blob.type + ';base64,'; this.onload(); } }
  };
  vm.runInNewContext(source.slice(source.indexOf('async function processNativePhoto'), start) +
    tasks.slice(tasks.indexOf('async function storeFile'), tasks.indexOf('async function editAttachmentExternally')), env);
  const optimized = await env.storeFile(original);
  assert.equal(saved[0][1], derived);
  assert.equal(saved[0][2], 'data:image/webp;base64,');
  assert.equal(optimized.name, 'photo.webp');
  assert.equal(optimized.resultId, 'r1');
  fail = true;
  const preserved = await env.storeFile(original);
  assert.equal(saved[1][1], original);
  assert.equal(preserved.name, original.name);
  assert.deepEqual(discarded, ['session', 'session']);
  console.log('C-07 photo compression and transparency regression passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

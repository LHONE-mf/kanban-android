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
  assert.match(tasks,/type === 'image\/webp'/);
  assert.match(tasks,/\.webp' : originalName/);
  console.log('C-07 photo compression and transparency regression passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

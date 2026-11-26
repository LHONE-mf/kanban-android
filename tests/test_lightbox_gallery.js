// C-08: photo gallery navigation, pinch zoom and URL lifecycle.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/src/main/js-src/media-dialogs.js','utf8');
const a=source.indexOf('const lightboxGallery = {');
const b=source.indexOf('// ============================================================\n// SETTINGS',a);
assert.ok(a>0&&b>a);
const css=fs.readFileSync('app/src/main/assets/kanban.css','utf8');
const html=fs.readFileSync('app/src/main/assets/kanban.html','utf8');
for(const id of ['lightboxClose','lightboxPrev','lightboxNext','lightboxZoomIn','lightboxZoomOut','lightboxPosition'])
  assert.ok(html.includes('id="'+id+'"'),'lightbox control '+id);
assert.match(css,/\.lightbox-stage/);
assert.match(css,/\.lightbox-controls button/);
assert.match(css,/touch-action:\s*none/);
const names=['lightbox','lightboxContent','lightboxPosition','lightboxPrev',
  'lightboxNext','lightboxZoomIn','lightboxZoomOut'];
const elems=Object.fromEntries(names.map(x=>[x,{dataset:{},disabled:false,hidden:false,
  classList:{open:false,add(){this.open=true;},remove(){this.open=false;},contains(){return this.open;}},
  textContent:'',child:null,appendChild(c){this.child=c;},
  querySelector(tag){return this.child?.tagName===tag?this.child:null;},
  setPointerCapture(){}}]));
let created=0, revoked=0;
const context={
  $:q=>elems[q.slice(1)],
  mediaGet:async id=>({full:{id},type:'image/jpeg'}),
  createTrackedURL:()=>('blob:'+ ++created),
  revokeTrackedURL:()=>{revoked++;},
  document:{createElement:tag=>({tagName:tag,src:'',alt:'',style:{},
    clientWidth:300,clientHeight:200})},
  Map,Math,Promise,
  lightboxToken:0
};
vm.createContext(context);
vm.runInContext(source.slice(a,b)+
  '\nthis.viewer={openLightbox,changeLightboxItem,updateLightboxZoom,lightboxPointerDown,lightboxPointerUp,closeLightbox,lightboxGallery};',context);
const files=[{id:'img1',type:'image/jpeg'},{id:'img2',type:'image/png'}];
(async()=>{
  await context.viewer.openLightbox({title:'Tests',files},files[0]);
  assert.equal(elems.lightboxPosition.textContent,'1 / 2');
  assert.equal(elems.lightboxPrev.disabled,true);
  assert.equal(elems.lightboxNext.disabled,false);
  context.viewer.changeLightboxItem(1);
  await new Promise(setImmediate);
  assert.equal(elems.lightboxPosition.textContent,'2 / 2');
  assert.equal(revoked,1,'previous object URL must be released when changing image');
  context.viewer.updateLightboxZoom(2);
  assert.match(elems.lightboxContent.child.style.transform,/scale\(2\)/);
  context.viewer.updateLightboxZoom(1);
  const target={closest:()=>null};
  context.viewer.lightboxPointerDown({pointerId:9,clientX:40,clientY:100,pointerType:'touch',target});
  context.viewer.lightboxPointerUp({pointerId:9,clientX:180,clientY:105});
  await new Promise(setImmediate);
  assert.equal(elems.lightboxPosition.textContent,'1 / 2','right swipe selects previous image');
  context.viewer.closeLightbox();
  assert.equal(elems.lightbox.classList.open,false);
  assert.equal(revoked,3,'all old blob URLs must be released on switch/close');
  console.log('C-08 lightbox gallery and zoom regression passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

(async () => {
  const commands = [], bytes = [], discarded = [], reads = [];
  const bridge = { postMessage: raw => commands.push(JSON.parse(raw)) };
  const native = {
    ...context, KanbanGallery: bridge, apStop() {}, generateId: () => 'gallery',
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout,
    mediaGet: async id => { reads.push(id); return { full: { id } }; },
    mediaDiscard: id => discarded.push(id),
    stageNativeMedia: async (request, blob, current, options) => {
      assert.ok(current());
      bytes.push([request, blob.id, options.operation]);
    }
  };
  vm.runInNewContext(source.slice(a, b), native);
  const files = [{ id: 'photo', type: 'image/heic' }, { id: 'movie', type: 'video/mp4' }];
  await native.openLightbox({ title: 'Result', files }, files[1]);
  assert.deepEqual(commands[0], { id: 'gallery', type: 'open', index: 1, size: 2, title: 'Result' });
  assert.deepEqual(reads, [], 'opening native UI does not decode or load every item');
  const session = (type, fields) => native.kanbanGalleryResult(JSON.stringify({ id: 'gallery', type, ...fields }));
  await session('request', { index: 1, request: 'one' });
  await session('request', { index: 0, request: 'two' });
  assert.deepEqual(bytes, [['one', 'movie', 'gallery-video'], ['two', 'photo', 'gallery-image']]);
  assert.deepEqual(discarded, ['one']);
  await session('closed');
  assert.deepEqual(discarded, ['one', 'two']);
  await session('request', { index: 1, request: 'late' });
  assert.deepEqual(reads, ['movie', 'photo']);
  console.log('Native gallery: on-demand order, video route and cancellation verified.');
})().catch(error => { console.error(error); process.exitCode = 1; });

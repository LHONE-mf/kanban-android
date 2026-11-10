// Fast, emulator-free coverage for image size limits and task photo galleries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const mediaSource = fs.readFileSync('app/src/main/js-src/media-dialogs.js', 'utf8');
const taskSource = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
const html = fs.readFileSync('app/src/main/assets/kanban.html', 'utf8');
const interactionSource = fs.readFileSync('app/src/main/js-src/interactions.js', 'utf8');
const androidSource = fs.readFileSync('app/src/main/java/com/kanban/offline/MainActivity.kt', 'utf8');

for (const id of ['lightboxClose', 'lightboxPrev', 'lightboxNext', 'lightboxCounter', 'lightboxZoomControls', 'lightboxZoomIn', 'lightboxZoomOut', 'lightboxZoomReset']) {
  assert(html.includes('id="' + id + '"'), 'Missing photo viewer control: ' + id);
}
assert(interactionSource.includes("window.kanbanHandleBack = () =>"), 'Android Back handler missing');
assert(interactionSource.includes("addEventListener('touchend'"), 'Swipe gesture handler missing');
assert(androidSource.includes('result.data?.clipData'), 'Android multi-selection extraction missing');
assert(androidSource.includes('Intent.EXTRA_ALLOW_MULTIPLE'), 'Android multiple picker flag missing');

const section = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, 'Cannot extract ' + start);
  return source.slice(a, b);
};
const elements = Object.fromEntries(
  ['lightbox','lightboxClose','lightboxPrev','lightboxNext','lightboxCounter','lightboxContent','lightboxZoomControls','lightboxZoomIn','lightboxZoomOut','lightboxZoomReset']
    .map(id=>[id,{
      hidden:false, disabled:false, dataset:{}, innerHTML:'', textContent:'', children:[], clientWidth:400, clientHeight:320,
      querySelector(selector){return selector==='img' ? this.children.findLast(child=>child.tagName==='img') : null},
      classList:{
        classes:new Set(),
        add(name){this.classes.add(name)},
        remove(name){this.classes.delete(name)},
        contains(name){return this.classes.has(name)}
      },
      focus(){}, appendChild(child){this.children.push(child)}
    }])
);
const stored = [], revoked = [];
let urls = 0;
const context = {
  Blob, Math, console, lightboxToken:0,
  IMG_MAX_DIM:1600, IMG_QUALITY:0.82, IMG_THUMB_DIM:320,
  URL: { createObjectURL(){return 'blob:source'}, revokeObjectURL(url){revoked.push(url)} },
  Image: class { width=3800; height=2800; set src(value){this.onload()} },
  document: {
    activeElement:{isConnected:true,focus(){}},
    createElement(tag){
      if(tag !== 'canvas') return {tagName:tag,src:'',alt:'',controls:false,style:{},clientWidth:400,clientHeight:240};
      return {
        width:0,height:0,
        getContext(){return {fillStyle:'',fillRect(){},drawImage(){}}},
        toBlob(callback,type,quality){
          // First quality is too large, the adaptive JPEG attempt should shrink it.
          const bytes = quality > 0.7 ? 3 * 1024 * 1024 : 1.6 * 1024 * 1024;
          callback(new Blob([Buffer.alloc(bytes)],{type}));
        }
      };
    }
  },
  $:selector=>elements[selector.replace(/^#/, '')],
  mediaGet:async id=>({full:new Blob([id],{type:'image/jpeg'}),type:'image/jpeg'}),
  mediaPut:async (...args)=>stored.push(args),
  generateThumb:async ()=>'data:thumb',
  generateId:()=>String(stored.length+1),
  prepAudio:async () => null,
  createTrackedURL:()=> 'blob:viewer-' + (++urls),
  revokeTrackedURL:url=>revoked.push(url)
};
vm.createContext(context);
vm.runInContext(
  section(mediaSource,'async function compressImage(', 'function generateThumb(') +
  section(mediaSource,'let lightboxGallery =', '// ============================================================\n// SETTINGS') +
  section(taskSource,'async function storeFile(', 'async function editAttachmentExternally('),
  context
);

(async () => {
  const large = new Blob([Buffer.alloc(12 * 1024 * 1024)],{type:'image/png'});
  large.name = 'camera.png';
  const saved = await vm.runInContext('storeFile',context)(large);
  assert.equal(saved.type,'image/jpeg');
  assert.equal(saved.name,'camera.jpg','Saved extension must match JPEG contents');
  assert(saved.size <= 2 * 1024 * 1024, 'Converted photo should be at most 2 MiB');
  assert.equal(stored.length,1);
  assert.equal(stored[0][1].size,saved.size);

  // Converters must not preserve a large original photo on failure.
  context.Image = class {set src(value){this.onerror()}};
  await assert.rejects(vm.runInContext('storeFile',context)(large));
  assert.equal(stored.length,1,'Failed image conversion must not store original');

  const photos = [
    {id:'a',name:'a.jpg',type:'image/jpeg'},
    {id:'b',name:'b.jpg',type:'image/jpeg'},
    {id:'c',name:'c.jpg',type:'image/jpeg'}
  ];
  await vm.runInContext('openLightbox',context)({title:'My task',files:photos},photos[1]);
  assert.equal(elements.lightboxCounter.textContent,'2 / 3');
  assert.equal(elements.lightboxContent.children.at(-1).src,'blob:viewer-1');
  assert.equal(elements.lightboxZoomControls.hidden,false,'Photo viewer must offer zoom controls');
  vm.runInContext('setLightboxZoom(2)',context);
  assert.equal(vm.runInContext('lightboxZoom',context),2,'Photo can zoom to 200%');
  assert.equal(elements.lightboxZoomReset.textContent,'200%');
  vm.runInContext('panLightboxTo(999,999)',context);
  assert.equal(vm.runInContext('lightboxPanX',context),200,'Pan must stay within image bounds');
  assert.equal(vm.runInContext('lightboxPanY',context),80,'Vertical pan must stay within image bounds');
  vm.runInContext('setLightboxZoom(1)',context);
  assert.equal(vm.runInContext('lightboxPanX',context),0,'Returning to 100% resets pan');
  vm.runInContext('stepLightbox(1)',context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.lightboxCounter.textContent,'3 / 3');
  assert.equal(vm.runInContext('lightboxZoom',context),1,'New photo must reset zoom');
  assert(revoked.includes('blob:viewer-1'),'Previous image URL should be released');
  vm.runInContext('stepLightbox(1)',context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.lightboxCounter.textContent,'1 / 3','Gallery should wrap around');
  vm.runInContext('setLightboxZoom(3)',context);
  vm.runInContext('closeLightbox()',context);
  assert.equal(vm.runInContext('lightboxZoom',context),1,'Closing viewer must reset zoom');
  assert.equal(elements.lightbox.classList.contains('open'),false);
  assert(revoked.includes('blob:viewer-3'),'Closing viewer should release displayed image URL');

  console.log('Photo attachments: compact JPEG, failed conversion, gallery navigation and close: passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

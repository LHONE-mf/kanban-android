// Gesture-level checks without a slow Android emulator.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const js = fs.readFileSync('app/src/main/js-src/interactions.js', 'utf8');
const start = js.indexOf("  $('#lightbox').addEventListener('click',");
const end = js.indexOf('  // Android Back closes the topmost overlay.', start);
assert(start >= 0 && end > start, 'Photo gesture bindings missing');
const handlers = {lightbox:{},lightboxContent:{}};
const elements = Object.fromEntries(Object.entries(handlers).map(([id,events]) => [
  id, {addEventListener(name, fn){events[name]=fn}}
]));
for(const id of ['lightboxClose','lightboxPrev','lightboxNext','lightboxZoomIn','lightboxZoomOut','lightboxZoomReset']) {
  elements[id] = {};
}
const pan=[], zoom=[], gallery=[];
const ctx = {
  Math, Date, lightboxZoom:1, lightboxPanX:0, lightboxPanY:0,
  $:selector=>elements[selector.slice(1)],
  lightboxImage:()=>({}), closeLightbox:()=>{},
  stepLightbox:delta=>gallery.push(delta),
  panLightboxTo:(x,y)=>pan.push({x,y}),
  setLightboxZoom:(value,x,y)=>{ctx.lightboxZoom=Math.max(1,Math.min(5,value));zoom.push({value:ctx.lightboxZoom,x,y})}
};
vm.createContext(ctx);
vm.runInContext(js.slice(start,end),ctx);
const target={tagName:'IMG',closest:selector=>selector==='img'?{}:null};
const touch=(x,y)=>({clientX:x,clientY:y});
const event=(touches,changedTouches=touches)=>({
  touches,changedTouches,target,preventDefault(){this.prevented=true}
});

// Unzoomed horizontal swipe navigates the task gallery.
handlers.lightbox.touchstart(event([touch(240,160)]));
handlers.lightbox.touchend(event([],[touch(110,165)]));
assert.deepEqual(gallery,[1]);

// A pinch enlarges the image rather than navigating the gallery.
handlers.lightbox.touchstart(event([touch(120,160),touch(220,160)]));
const pinchMove=event([touch(70,160),touch(270,160)]);
handlers.lightbox.touchmove(pinchMove);
assert.equal(ctx.lightboxZoom,2);
assert.equal(pinchMove.prevented,true);
handlers.lightbox.touchend(event([], [touch(70,160)]));
assert.deepEqual(gallery,[1],'Pinching must not change the photo');

// When zoomed, dragging pans instead of swiping to another photo.
handlers.lightbox.touchstart(event([touch(120,160)]));
const panMove=event([touch(190,180)]);
handlers.lightbox.touchmove(panMove);
assert.equal(panMove.prevented,true);
assert.equal(pan.at(-1).x,70);
handlers.lightbox.touchend(event([],[touch(190,180)]));
assert.deepEqual(gallery,[1],'Zoomed drag must not advance gallery');

// Double tap toggles zoom back to 100%, then enlarges again.
ctx.lightboxZoom=2;
handlers.lightbox.touchstart(event([touch(150,150)]));
handlers.lightbox.touchend(event([],[touch(150,150)]));
handlers.lightbox.touchstart(event([touch(152,150)]));
handlers.lightbox.touchend(event([],[touch(152,150)]));
assert.equal(ctx.lightboxZoom,1);
handlers.lightboxContent.dblclick({
  target, clientX:150,clientY:150,preventDefault(){}
});
// The synthesized dblclick after touch must not undo the zoom toggle.
assert.equal(ctx.lightboxZoom,1);
elements.lightboxZoomIn.onclick();
assert.equal(ctx.lightboxZoom,1.5);
elements.lightboxZoomReset.onclick();
assert.equal(ctx.lightboxZoom,1);
console.log('Photo pinch, pan, swipe, double-tap, plus and reset gestures: passed');

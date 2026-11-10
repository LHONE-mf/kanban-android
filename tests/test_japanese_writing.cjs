// Fast offline regression checks for both kana handwriting modes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('app/src/main/assets/japanese.html', 'utf8');
const ids = ['writingTrace','writingRecall','writingHira','writingKata','writingReveal','writingUndo','writingClear','writingPrev','writingNext','writeCanvas'];
for (const id of ids) assert(html.includes('id="'+id+'"'), 'Missing writing control: '+id);
const start = html.indexOf('function resetWriting(){');
const end = html.indexOf('\nupdateProgress();renderGroup();', start);
assert(start >= 0 && end > start, 'Writing handlers not found');
const elements = Object.fromEntries(ids.map(id=>[id,{
  hidden:false, textContent:'', classList:{active:false,toggle(name,value){if(name==='active')this.active=value}}
}]));
elements.writingInstructions={textContent:''};
elements.writingToggle={hidden:false,textContent:''};
let renders=0, groupRenders=0;
const context={
  writingMode:'trace',showGuide:true,writingRevealed:false,writingStrokes:[[1]],writeIndex:0,script:'hiragana',
  $:id=>elements[id],drawWriting:()=>renders++,renderGroup:()=>groupRenders++
};
vm.createContext(context);
vm.runInContext(html.slice(start,end),context);
elements.writingUndo.onclick();
assert.equal(context.writingStrokes.length,0,'Undo must remove the latest stroke');
context.writingStrokes=[[1],[2]];
elements.writingUndo.onclick();
assert.equal(context.writingStrokes.length,1,'Undo must preserve earlier strokes');
elements.writingRecall.onclick();
assert.equal(context.writingMode,'recall');
assert.equal(context.showGuide,false);
assert.equal(elements.writingReveal.hidden,false);
assert.equal(elements.writingToggle.hidden,true);
elements.writingReveal.onclick();
assert.equal(context.writingRevealed,true);
elements.writingNext.onclick();
assert.equal(context.writingRevealed,false,'Next character must hide the answer');
assert.equal(context.writingStrokes.length,0,'Next character must clear the canvas');
elements.writingKata.onclick();
assert.equal(context.script,'katakana');
assert.equal(context.writeIndex,0);
assert.equal(groupRenders,1);
elements.writingTrace.onclick();
assert.equal(context.showGuide,true);
assert.equal(elements.writingReveal.hidden,true);
assert(renders>=5);
console.log('Japanese handwriting mode and kana switching: passed');

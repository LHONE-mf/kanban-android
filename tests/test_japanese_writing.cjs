// Fast offline regression checks for both kana handwriting modes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('app/src/main/assets/japanese.html', 'utf8');
const ids = ['writingTrace','writingRecall','writingHira','writingKata','writingReveal','writingUndo','writingClear','writingGrade','writingRetry','writingGood','writingFeedback','writingReference','writingReferenceKana','writingReferenceRoman','writingTryAgain','writingTryAgainRow','writingPrev','writingNext','writingRandom','writingPosition','writeCanvas'];
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
  reviews:{},reviewKey:'test-reviews',localStorage:{setItem(){}},Date,
  allKana:()=>[{items:[{kana:'あ',roman:'a'},{kana:'い',roman:'i'},{kana:'う',roman:'u'}]}],Math:{random:()=>0,floor:Math.floor},
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
assert.equal(elements.writingGrade.hidden,false);
assert.equal(elements.writingReference.hidden,false);
assert.equal(elements.writingReferenceKana.textContent,'あ');
assert.equal(elements.writingReferenceRoman.textContent,'a');
elements.writingRetry.onclick();
assert.equal(context.reviews['あ'].interval,0);
assert.equal(elements.writingGrade.hidden,true);
assert.equal(elements.writingTryAgainRow.hidden,false);
elements.writingTryAgain.onclick();
assert.equal(context.writingRevealed,false,'Retry must hide the answer');
assert.equal(elements.writingReference.hidden,true,'Retry must hide the reference');
assert.equal(context.writeIndex,0,'Retry must keep the same kana');
assert.equal(elements.writingTryAgainRow.hidden,true);
elements.writingNext.onclick();
assert.equal(context.writingRevealed,false,'Next character must hide the answer');
assert.equal(context.writingStrokes.length,0,'Next character must clear the canvas');
elements.writingPrev.onclick();
assert.equal(context.writeIndex,0,'Previous moves back using the current alphabet length');
elements.writingPrev.onclick();
assert.equal(context.writeIndex,2,'Previous wraps at the beginning of the alphabet');
elements.writingRandom.onclick();
assert.equal(context.writeIndex,0,'Random challenge should select a different kana');
assert.equal(context.writingStrokes.length,0,'Random challenge clears the drawing');
elements.writingKata.onclick();
assert.equal(context.script,'katakana');
assert.equal(context.writeIndex,0);
assert.equal(groupRenders,1);
elements.writingTrace.onclick();
assert.equal(context.showGuide,true);
assert.equal(elements.writingReveal.hidden,true);
assert(renders>=5);
console.log('Japanese handwriting mode and kana switching: passed');

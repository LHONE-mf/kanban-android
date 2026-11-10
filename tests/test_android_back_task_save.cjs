// Fast regression for Android Back inside task editor and touch action visibility.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const js = fs.readFileSync('app/src/main/js-src/interactions.js', 'utf8');
const css = fs.readFileSync('app/src/main/assets/kanban.css', 'utf8');
const kotlin = fs.readFileSync('app/src/main/java/com/kanban/offline/MainActivity.kt', 'utf8');
const start = js.indexOf('window.kanbanHandleBack = () => {');
const end = js.indexOf('\n\n  document.addEventListener(\'keydown\'', start);
assert(start >= 0 && end > start, 'Native back callback missing');
let saved = 0, closed = 0, dismissals = 0;
const visible = new Set(['taskModal']);
const dom = Object.fromEntries(['taskModal','lightbox','confirmModal','settingsModal','shortcutsModal']
  .map(id=>[id,{classList:{contains:cls=>cls==='open' && visible.has(id)}}]));
const window = {};
const ctx = {
  window,
  $:selector=>dom[selector.slice(1)],
  saveTaskFromModal:async()=>{saved++},
  closeLightbox:()=>{dismissals++;visible.delete('lightbox')},
  closeModal:id=>{closed++;visible.delete(id)},
  showToast:()=>{},
};
vm.createContext(ctx);
vm.runInContext(js.slice(start,end),ctx);
assert.equal(window.kanbanHandleBack(),true,'Back should be consumed by open task editor');
assert.equal(saved,1,'Back should invoke the existing save routine');
assert.equal(closed,0,'Back must not discard a task before the save completes');
assert(visible.has('taskModal'),'Modal remains until successful save closes it');
visible.add('lightbox');
assert.equal(window.kanbanHandleBack(),true,'Photo viewer takes precedence');
assert.equal(dismissals,1);
assert.equal(saved,1,'Back in lightbox must not save the task underneath');
visible.delete('taskModal');
assert.equal(window.kanbanHandleBack(),false,'Back on board should be available for app exit logic');

// Flex columns must scroll cards, not shrink and clip footers/media.
assert(/\.task-card\s*\{[^}]*flex-shrink:\s*0\s*;/s.test(css),
  'Cards in a scrolling column must not shrink and hide their footer icons');
// Touch devices must not depend on hover for task action visibility.
assert(/@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)/.test(css),
  'Explicit coarse-pointer styling missing');
assert(/\.task-quick-actions\s*\{\s*opacity:\s*1/.test(css),
  'Mobile task actions should be fully visible');
assert(/\.task-quick-btn\s*\{[^}]*color:\s*var\(--text\)/s.test(css),
  'Touch card icons should use a readable text color');
assert(kotlin.includes('window.kanbanHandleBack && window.kanbanHandleBack()'),
  'Native Android Back should consult the web UI first');
console.log('Android task Back-to-save and touch action icon visibility: passed');

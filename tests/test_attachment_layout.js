// C-04: controls should stay usable on narrow Android screens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const css = fs.readFileSync('app/src/main/assets/kanban.css','utf8');
const tasks = fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
function block(selector) {
  const index = css.indexOf(selector+' {');
  assert.ok(index>=0,selector);
  return css.substring(index,css.indexOf('}',index));
}
assert.match(block('.modal-body'),/overflow-y:\s*auto/);
assert.match(block('.modal-body'),/min-height:\s*0/);
assert.match(block('.media-file-actions'),/flex-wrap:\s*wrap/);
assert.match(block('.media-file-name'),/overflow-wrap:\s*anywhere/);
assert.match(block('.media-remove'),/min-height:\s*44px/);
assert.match(block('.media-remove'),/min-width:\s*44px/);
assert.match(block('#taskModal .modal-footer'),/flex-wrap:\s*wrap/);
// Narrow phone: a fixed two-column footer, no flex spacer row, and enough
// scroll room to keep file controls clear of footer actions.
const mobile = css.slice(css.indexOf('/* Keep attachment actions fully scrollable'), css.indexOf('.columns-list {'));
assert.match(mobile, /@media \(max-width:\s*600px\)/);
assert.match(mobile, /#taskModal \.modal-footer\s*\{[^}]*display:\s*grid;/);
assert.match(mobile, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(mobile, /#taskModal \.modal-footer \.spacer\s*\{\s*display:\s*none;/);
assert.match(mobile, /#taskModal \.modal-body\s*\{[^}]*padding-bottom:\s*max\(88px,/);
assert.match(mobile, /scroll-padding-bottom:\s*88px/);
assert.match(mobile, /#taskModal \.modal-footer \.btn\s*\{[^}]*min-height:\s*44px/);

assert.ok(tasks.includes("row.className = 'media-file-row'"));
assert.ok(tasks.includes('class="media-file-actions"'));
assert.ok(tasks.includes('data-open="1"')&&tasks.includes('data-edit="1"')&&tasks.includes('data-rm="1"'));
console.log('Mobile attachment controls regression passed');

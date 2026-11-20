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
assert.ok(tasks.includes("row.className = 'media-file-row'"));
assert.ok(tasks.includes('class="media-file-actions"'));
assert.ok(tasks.includes('data-open="1"')&&tasks.includes('data-edit="1"')&&tasks.includes('data-rm="1"'));
console.log('Mobile attachment controls regression passed');

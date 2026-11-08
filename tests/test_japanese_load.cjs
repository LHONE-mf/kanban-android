// Exercise the actual learned-kana storage initialization against malformed data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('app/src/main/assets/japanese.html', 'utf8');
const start = html.indexOf('let known;try{');
const end = html.indexOf('\nconst quizProgressKey=', start);
assert(start >= 0 && end > start, 'Learned-kana initialization not found');
const source = html.slice(start, end) + '\nglobalThis.loadedKnown = [...known];';
function load(value) {
  const context = {
    storageKey: 'kanban-japanese-hiragana-v1',
    localStorage: { getItem() { if (value instanceof Error) throw value; return value; } }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.loadedKnown;
}
assert.deepEqual(load(null), []);
assert.deepEqual(load('{not-json'), []);
assert.deepEqual(load('{}'), []);
assert.deepEqual(load('"あ"'), []);
assert.deepEqual(load('null'), []);
assert.deepEqual(load('["あ","ア","あ",123,null]'), ['あ','ア']);
assert.deepEqual(load(new Error('Storage access denied')), []);
console.log('Japanese learned-kana initialization with malformed storage: passed');

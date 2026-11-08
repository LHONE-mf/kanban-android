// Execute the real spaced-repetition initialization against malformed saved data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('app/src/main/assets/japanese.html', 'utf8');
const start = html.indexOf("const reviewKey='kanban-japanese-review-v1';");
const end = html.indexOf('\nconst $=id=>', start);
assert(start >= 0 && end > start, 'Review initialization not found');
const source = html.slice(start, end) + '\nglobalThis.loadedReviews = JSON.parse(JSON.stringify(reviews));';
function load(value) {
  const context = { localStorage: { getItem() {
    if (value instanceof Error) throw value;
    return value;
  } } };
  vm.createContext(context);
  vm.runInContext(source, context);
  return JSON.parse(JSON.stringify(context.loadedReviews));
}
assert.deepEqual(load(null), {});
assert.deepEqual(load('invalid json'), {});
assert.deepEqual(load('null'), {});
assert.deepEqual(load('[]'), {});
assert.deepEqual(load('"text"'), {});
assert.deepEqual(load(new Error('Storage blocked')), {});
assert.deepEqual(load(JSON.stringify({
  'あ': { interval: 1, due: 1000 },
  'ア': { interval: 3, due: 3000 },
  'い': { interval: -1, due: 20 },
  'う': { interval: 1, due: 'tomorrow' },
  'え': null,
  'お': { interval: 2, due: null }
})), {
  'あ': { interval: 1, due: 1000 },
  'ア': { interval: 3, due: 3000 }
});
console.log('Japanese review initialization with malformed storage: passed');

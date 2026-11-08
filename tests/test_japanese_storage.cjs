// Exercise the actual Japanese progress handlers with a mocked WebView storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('app/src/main/assets/japanese.html', 'utf8');
function extract(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'Japanese progress handler not found');
  return html.slice(a, b);
}
const persist = extract('function persist(){', 'function updateProgress(){');
const progress = extract('function updateProgress(){', 'function tab(');
const handler = extract("$('markKana').onclick=()=>{", '\nfunction setScript(');
const storage = new Map();
let failWrites = false;
let alerts = 0;
const labels = { progressLabel: { textContent: '' }, progressBar: { style: {} }, markKana: {} };
const context = {
  localStorage: {
    setItem(key, value) {
      if (failWrites) throw new Error('QuotaExceededError');
      storage.set(key, value);
    }
  },
  console: { error() {} },
  alert() { alerts++; },
  storageKey: 'kanban-japanese-hiragana-v1',
  known: new Set(),
  all: [{ kana: 'あ' }],
  kataGroups: [],
  $: id => labels[id],
  allKana: () => [{ items: [{ kana: 'あ' }] }],
  groupIndex: 0,
  detailIndex: 0,
  renderGroup() {},
  showDetail() {}
};
vm.createContext(context);
vm.runInContext(persist + progress + handler, context);
const click = () => vm.runInContext("$('markKana').onclick()", context);
click();
assert.equal(storage.get(context.storageKey), '["あ"]');
assert.equal(labels.progressLabel.textContent, 'Изучено 1 / 1 знаков кана');
failWrites = true;
click(); // Failed attempt to unlearn must restore learned state.
assert.equal(context.known.has('あ'), true);
assert.equal(storage.get(context.storageKey), '["あ"]');
assert.equal(labels.progressLabel.textContent, 'Изучено 1 / 1 знаков кана');
assert.equal(alerts, 1);
failWrites = false;
click();
assert.equal(storage.get(context.storageKey), '[]');
assert.equal(labels.progressLabel.textContent, 'Изучено 0 / 1 знаков кана');
console.log('Japanese progress save, rollback, and retry: passed');

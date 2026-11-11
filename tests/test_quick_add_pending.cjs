const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/android-extras.js', 'utf8');
const start = source.indexOf("  const quickAddInput = $('#quickAdd');");
const end = source.indexOf('  notificationUiReady = true;', start);
assert(start >= 0 && end > start);

function fixture() {
  const input = { value: 'First task', addEventListener(type, fn) { this[type] = fn; } };
  const button = { disabled: false, addEventListener(type, fn) { this[type] = fn; } };
  const writes = [];
  let finish;
  const ctx = { $: id => id === '#quickAdd' ? input : button,
    quickAddTask: text => { writes.push(text); return new Promise(resolve => { finish = resolve; }); } };
  vm.runInNewContext(source.slice(start, end), ctx);
  return { input, button, writes, finish: value => finish(value),
    type(text) { input.value = text; input.input?.(); } };
}

(async () => {
  for (const draft of ['Second task', 'First task']) {
    const f = fixture();
    const saving = f.button.click();
    f.type(draft);
    await f.button.click();
    assert.deepEqual(f.writes, ['First task'], 'Repeated submit must not duplicate the pending write');
    f.finish(true); await saving;
    assert.equal(f.input.value, draft, 'A pending save must preserve a newly typed draft, even with the same title');
    assert.equal(f.button.disabled, false);
  }
  for (const success of [true, false]) {
    const f = fixture(); const saving = f.button.click();
    f.finish(success); await saving;
    assert.equal(f.input.value, success ? '' : 'First task');
    assert.equal(f.button.disabled, false);
  }
  console.log('Quick add: pending draft preservation, duplicate guard, success clear and failed save passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

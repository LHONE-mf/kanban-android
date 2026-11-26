const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const js = fs.readFileSync('app/src/main/js-src/android-extras.js', 'utf8');
const segment = js.slice(js.indexOf('const POMO_LEN'), js.indexOf('// TASK REMINDERS'));
const buttons = new Map(), events = new Map(), requests = [], scheduled = new Map(), notices = [];
const legacy = { mode: 'focus', left: 900, running: false, sessions: 2, day: '2026-11-25' };
let now = 0, serial = 0;
function node(selector) {
  if (!buttons.has(selector)) buttons.set(selector, {});
  return buttons.get(selector);
}
const env = {
  $: node, window: {}, performance: { now: () => now },
  document: { hidden: false, addEventListener: (name, callback) => events.set(name, callback) },
  localStorage: { getItem: () => JSON.stringify(legacy), setItem: () => assert.fail('no parallel WebView writes') },
  KanbanPomo: { postMessage: raw => requests.push(JSON.parse(raw)) },
  generateId: () => 'pomo_' + ++serial, showToast: value => notices.push(value),
  setTimeout: (callback, ms) => {
    const timer = { callback, ms };
    scheduled.set(timer, callback);
    return timer;
  },
  clearTimeout: timer => scheduled.delete(timer)
};
vm.runInNewContext(segment, env);
env.initPomo();
assert.deepEqual(requests[0], { id: 'pomo_1', type: 'read', legacy });
function send(state, id = requests.at(-1).id) {
  env.window.kanbanPomoResult(JSON.stringify({
    id, mode: 'focus', running: false, ms: 900000, sessions: 2,
    notificationsAllowed: false, ...state
  }));
}
send({ sessions: 98 }, 'stale');
assert.equal(node('#pomoToggle').disabled, true);
send({});
assert.equal(node('#pomoTime').textContent, '15:00');
assert.match(node('#pomoStatus').textContent, /выключены/);
node('#pomoToggle').onclick();
node('#pomoToggle').onclick();
assert.deepEqual(requests.slice(1), [{ id: 'pomo_2', type: 'toggle' }]);
send({ running: true, ms: 1500 });
now += 1500;
[...scheduled.values()][0]();
assert.equal(requests.at(-1).type, 'read', 'the UI asks the native timer to settle an expired session');
send({ mode: 'break', completed: 'focus', ms: 300000, sessions: 3 });
assert.deepEqual(notices, ['Сессия завершена — перерыв 5 мин']);
assert.match(node('#pomoMode').textContent, /3/);
assert.equal(scheduled.size, 0, 'paused native timer keeps no WebView ticker');
env.document.hidden = true;
events.get('visibilitychange')();
env.document.hidden = false;
events.get('visibilitychange')();
assert.equal(requests.at(-1).type, 'read');
send({ mode: 'break', sessions: 3 });
assert.equal(notices.length, 1, 'reopening the page does not display another completion');
console.log('Pomodoro: legacy handoff, request serialization, expiry and notification state verified.');

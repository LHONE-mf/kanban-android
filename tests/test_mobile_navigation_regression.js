// Comrade step 04: keyboard/navigation regression with a real event-handler VM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = p => fs.readFileSync(p, 'utf8');
const source = read('app/src/main/js-src/interactions.js');
const html = read('app/src/main/assets/kanban.html');
const kotlin = read('app/src/main/java/com/kanban/offline/MainActivity.kt');
const start = source.indexOf("  document.addEventListener('keydown', async (e) => {");
const end = source.indexOf("  window.addEventListener('online'", start);
assert.ok(start > 0 && end > start, 'keyboard handler must exist');
const handler = source.slice(start, end);
const tabs = [...html.matchAll(/<button class="view-tab[^"]*" data-view="([^"]+)"/g)].map(m => m[1]);
assert.deepEqual(tabs, ['kanban','dashboard','mindmap','calendar']);
assert.match(source, /function bindViewTabs\(\) \{/);
assert.match(source, /  bindViewTabs\(\);/);
assert.match(source, /\$\('#boardSelect'\)\.onchange = \(e\) => switchBoard\(e\.target\.value\)/);
assert.match(kotlin, /if \(handled == "true"\)/, 'Android Back should respect JS consumed state');
assert.match(kotlin, /lastBackGestureAt = 0L/, 'consumed Back resets exit gesture');

async function scenario(key, open = []) {
  const calls = [];
  let callback;
  const nodes = Object.fromEntries(
    ['lightbox','confirmModal','textPromptModal','taskModal','settingsModal',
     'shortcutsModal','headerActions','searchInput','confirmCancel','textPromptCancel']
      .map(id => [id, {
        classList: {contains: c => c === 'open' || c === 'is-open' ? open.includes(id) : false},
        click: () => calls.push(id + '.click'),
        value: 'some query',
        blur: () => calls.push('blur')
      }])
  );
  const document = {
    activeElement: {tagName:'BODY'},
    addEventListener(type, cb) { assert.equal(type, 'keydown'); callback = cb; }
  };
  const sandbox = {
    document,
    $: selector => nodes[selector.slice(1)],
    switchView: view => calls.push('view:' + view),
    openTaskModal: () => calls.push('new-task'),
    closeHeaderMenu: () => {
      if (open.includes('headerActions')) {calls.push('close-menu');return true;}
      return false;
    },
    closeModal: id => calls.push('close:' + id),
    closeLightbox: () => calls.push('close-lightbox'),
    tryCloseTaskModal: async () => calls.push('save-editor'),
    renderBoard: () => calls.push('render'),
    setTimeout: () => 1,
    state: {columns:[{id:'todo'}]},
    searchQuery: '',
    lastFocusBeforeModal: null
  };
  vm.runInNewContext(handler, sandbox);
  let prevented = false;
  await callback({key,preventDefault(){prevented=true},ctrlKey:false,metaKey:false,altKey:false});
  return {calls,prevented};
}
(async () => {
  assert.deepEqual((await scenario('n')).calls, ['new-task'], 'shortcut works without menu');
  assert.deepEqual((await scenario('2')).calls, ['view:dashboard'], 'tab shortcut works normally');
  assert.deepEqual((await scenario('n',['headerActions'])).calls, [],
    'open dropdown must suppress accidental task creation');
  assert.deepEqual((await scenario('2',['headerActions'])).calls, [],
    'open dropdown must suppress tab navigation');
  assert.deepEqual((await scenario('Escape',['headerActions'])).calls, ['close-menu']);
  assert.deepEqual((await scenario('Escape',['textPromptModal','headerActions'])).calls,
    ['textPromptCancel.click'], 'text prompt must close before underlying menu');
  assert.deepEqual((await scenario('Escape',['taskModal','headerActions'])).calls,
    ['save-editor'], 'task editor must save before closing the underlying menu');
  assert.deepEqual((await scenario('Escape',['confirmModal','headerActions'])).calls,
    ['confirmCancel.click'], 'confirmation dialog has priority');
  console.log('Comrade navigation keyboard, menu, dialog priority and Back contracts passed.');
})().catch(e => {console.error(e);process.exitCode=1;});

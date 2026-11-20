// Comrade mobile navigation: real view switching, keyboard tablist and shortcuts.
// Node VM only: no production data, Android device or browser dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = path => fs.readFileSync(path, 'utf8');
const interactions = read('app/src/main/js-src/interactions.js');
const views = read('app/src/main/js-src/views.js');
const html = read('app/src/main/assets/kanban.html');

const tabViews = ['kanban', 'dashboard', 'mindmap', 'calendar'];
for (const view of tabViews) {
  assert.match(html, new RegExp('data-view="' + view + '"[^>]*role="tab"'),
    'navigation tab must remain accessible: ' + view);
}
const tabs = tabViews.map(view => ({
  dataset: {view}, tabIndex: 0, attributes: {}, active: false,
  focusCount: 0, focus() {this.focusCount++;},
  classList: {toggle(name, active) {if (name === 'active') this.owner.active = active;}},
  setAttribute(name, value) {this.attributes[name] = value;}
}));
for (const t of tabs) t.classList.owner = t;
const elements = Object.fromEntries(['kanbanToolbar', 'board', 'dashboard',
  'mindmap', 'calendar'].map(id => ['#' + id, {hidden: false, style: {}}]));
const renderCalls = [];
let saves = 0;
const sandbox = {
  VALID_VIEWS: tabViews,
  currentView: 'kanban',
  $$: selector => {assert.equal(selector, '.view-tab'); return tabs;},
  $: selector => elements[selector],
  renderDashboard() {renderCalls.push('dashboard');},
  renderMindmap() {renderCalls.push('mindmap');},
  renderCalendar() {renderCalls.push('calendar');},
  saveUIState() {saves++;}
};
const switchStart = views.indexOf('function switchView(view) {');
assert.ok(switchStart >= 0, 'switchView source must exist');
const switchCode = views.slice(switchStart);
const bindStart = interactions.indexOf('function bindViewTabs() {');
const bindEnd = interactions.indexOf('\nfunction bindEvents() {', bindStart);
assert.ok(bindStart >= 0 && bindEnd > bindStart,
  'a focused bindViewTabs helper must own tab keyboard bindings');
vm.runInNewContext(switchCode + '\n' + interactions.slice(bindStart, bindEnd) +
  '\nthis.bindTabs = bindViewTabs; this.switchTab = switchView;', sandbox);
sandbox.bindTabs();
sandbox.switchTab('kanban');
assert.equal(tabs.filter(t => t.tabIndex === 0).length, 1,
  'only the selected tab enters normal keyboard Tab order');
assert.equal(tabs[0].attributes['aria-selected'], 'true');
assert.equal(elements['#board'].hidden, false);
assert.equal(elements['#dashboard'].hidden, true);
function key(tab, name) {
  let prevented = 0;
  assert.equal(typeof tab.onkeydown, 'function', 'tab must have keyboard handler');
  tab.onkeydown({key:name, preventDefault() {prevented++;}});
  return prevented;
}
assert.equal(key(tabs[0], 'ArrowRight'), 1, 'right moves to next tab');
assert.equal(tabs[1].attributes['aria-selected'], 'true');
assert.equal(tabs[1].focusCount, 1);
assert.equal(elements['#dashboard'].hidden, false);
assert.equal(elements['#board'].hidden, true);
assert.equal(key(tabs[1], 'End'), 1, 'End selects last tab');
assert.equal(tabs[3].attributes['aria-selected'], 'true');
assert.equal(renderCalls.at(-1), 'calendar');
assert.equal(key(tabs[3], 'ArrowRight'), 1, 'right wraps to first tab');
assert.equal(tabs[0].attributes['aria-selected'], 'true');
assert.equal(key(tabs[0], 'ArrowLeft'), 1, 'left wraps to last tab');
assert.equal(tabs[3].attributes['aria-selected'], 'true');
assert.equal(key(tabs[3], 'Home'), 1, 'Home selects first tab');
assert.equal(tabs[0].attributes['aria-selected'], 'true');
assert.equal(key(tabs[0], 'x'), 0, 'other keys remain available');
assert.equal(tabs[0].attributes['aria-selected'], 'true');
assert.equal(tabs.filter(t => t.tabIndex === 0).length, 1);
assert.ok(saves >= 6, 'view navigation still persists UI view state');
tabs[2].onclick();
assert.equal(tabs[2].attributes['aria-selected'], 'true', 'touch/click still changes tab');
assert.equal(renderCalls.at(-1), 'mindmap');

// Global shortcuts must not open the task editor or switch screens behind
// an expanded menu (focused menu items are BUTTONs, not INPUTs).
const keyStart = interactions.indexOf("  document.addEventListener('keydown', async (e) => {");
const keyEnd = interactions.indexOf("\n  window.addEventListener('online'", keyStart);
assert.ok(keyStart >= 0 && keyEnd > keyStart);
let keyHandler;
let menuOpen = true;
let menuDismissed = 0, shortcutsRun = 0, taskOpens = 0;
const modal = {classList: {contains: () => false}};
const shortcutSandbox = {
  document: {
    activeElement: {tagName:'BUTTON'},
    addEventListener(type, cb) {if (type === 'keydown') keyHandler = cb;}
  },
  $: id => id === '#headerActions'
    ? {classList: {contains: name => name === 'is-open' && menuOpen}}
    : modal,
  closeHeaderMenu(restoreFocus) {if (!menuOpen) return false;
    assert.equal(restoreFocus, true); menuOpen = false; menuDismissed++; return true;},
  state: {columns: [{id:'todo'}]},
  openTaskModal() {taskOpens++;},
  switchView() {shortcutsRun++;},
  setTimeout() {shortcutsRun++;},
  closeModal(){}, closeLightbox(){}, tryCloseTaskModal(){},
  renderBoard(){}, saveTaskFromModal(){}, lastFocusBeforeModal:null,
  trapFocus(){}
};
vm.runInNewContext(interactions.slice(keyStart, keyEnd), shortcutSandbox);
async function shortcut(key) {
  let prevented = 0;
  await keyHandler({key, ctrlKey:false, metaKey:false, altKey:false,
    preventDefault() {prevented++;}});
  return prevented;
}
(async () => {
  for (const k of ['n', '2', '/', '?']) await shortcut(k);
  assert.equal(taskOpens, 0, 'menu blocks new-task shortcut');
  assert.equal(shortcutsRun, 0, 'menu blocks global view shortcuts');
  assert.equal(await shortcut('Escape'), 1, 'Escape dismisses expanded menu');
  assert.equal(menuDismissed, 1);
  assert.equal(await shortcut('n'), 1, 'shortcuts resume once menu closes');
  assert.equal(taskOpens, 1);
  await shortcut('2');
  assert.equal(shortcutsRun, 1, 'view shortcut resumes when menu is closed');
  console.log('Mobile navigation and keyboard regression checks passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });

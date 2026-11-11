// Executable regression: keyboard navigation AND the phone-breaking $$/$ selector.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const views = fs.readFileSync('app/src/main/js-src/views.js', 'utf8');
const interactions = fs.readFileSync('app/src/main/js-src/interactions.js', 'utf8');
const html = fs.readFileSync('app/src/main/assets/kanban.html', 'utf8');
const orderedViews = ['kanban', 'search', 'dashboard', 'mindmap', 'calendar'];
let focused = null;
let saved = 0;
const tabs = orderedViews.map(view => ({
  dataset: { view }, tabIndex: 0, attributes: {},
  classList: { toggle() {} },
  setAttribute(name, value) { this.attributes[name] = value; },
  focus() { focused = view; },
  closest(selector) { return selector === '.view-tab' ? this : null; }
}));
const panels = Object.fromEntries(
  ['#kanbanToolbar', '#board', '#dashboard', '#mindmap', '#calendar', '#globalSearch']
    .map(id => [id, { hidden: false, style: {} }])
);
const ctx = {
  VALID_VIEWS: orderedViews,
  $$: selector => {
    assert.equal(selector, '.view-tab');
    return tabs;
  },
  $: selector => {
    assert(panels[selector], 'Unknown panel: ' + selector);
    return panels[selector];
  },
  renderDashboard() {}, renderMindmap() {}, renderCalendar() {},
  renderGlobalSearch() {}, saveUIState() { saved++; }
};
vm.createContext(ctx);
vm.runInContext(views.slice(views.lastIndexOf('// VIEW SWITCH')), ctx);

// Replacing the working multi-element click binding with $().forEach crashed
// bindEvents(), leaving every button inert on the Android production WebView.
const clickLoop = "  $" + "$('.view-tab').forEach(tab => tab.onclick = () => switchView(tab.dataset.view));";
assert(interactions.includes(clickLoop), 'Keep working multi-tab click binding, not $().forEach');
assert(views.includes("const tabs = $" + "$('.view-tab');"),
  'Arrow navigation must also query ALL tabs');
const listener = "  $('.view-tabs').addEventListener('keydown', handleViewTabsKeydown);";
assert(interactions.includes(listener), 'Keyboard binding must be on tab bar');
let onKeydown = null;
const nav = { addEventListener(type, handler) {
  assert.equal(type, 'keydown');
  onKeydown = handler;
}};
vm.runInNewContext(listener, {
  $: selector => {
    assert.equal(selector, '.view-tabs');
    return nav;
  },
  handleViewTabsKeydown: ctx.handleViewTabsKeydown
});
assert.equal(typeof onKeydown, 'function');
const navHtml = html.slice(html.indexOf('<nav class="view-tabs"'), html.indexOf('</nav>'));
assert.equal((navHtml.match(/role="tab"/g) || []).length, 5);
ctx.switchView('kanban');
assert.deepEqual(tabs.map(t => t.tabIndex), [0, -1, -1, -1, -1]);
function key(index, key, modifiers = {}) {
  let prevented = false;
  onKeydown({ key, target: tabs[index], ...modifiers,
    preventDefault() { prevented = true; } });
  return prevented;
}
assert(key(0, 'ArrowRight'));
assert.equal(focused, 'search');
assert.equal(panels['#globalSearch'].hidden, false);
assert.deepEqual(tabs.map(t => t.tabIndex), [-1, 0, -1, -1, -1]);
assert.equal(tabs[1].attributes['aria-selected'], 'true');
assert(key(1, 'End'));
assert.equal(focused, 'calendar');
assert(key(4, 'ArrowRight'));
assert.equal(focused, 'kanban', 'ArrowRight wraps');
assert(key(0, 'ArrowLeft'));
assert.equal(focused, 'calendar', 'ArrowLeft wraps');
assert(key(4, 'Home'));
assert.equal(focused, 'kanban');
assert(!key(0, 'ArrowRight', { altKey: true }));
assert(!key(0, 'Enter'), 'Native button activation remains available');
assert(saved >= 6);
console.log('Tab keyboard navigation and Android startup selector regression passed');

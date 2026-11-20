// Responsive-header regression: breakpoint, long board names, safe areas, rotation.
// No browser dependencies; Chromium layout was also checked on a local fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = name => fs.readFileSync(name, 'utf8');
const css = read('app/src/main/assets/kanban.css');
const html = read('app/src/main/assets/kanban.html');
const js = read('app/src/main/js-src/interactions.js');
const kotlin = read('app/src/main/java/com/kanban/offline/MainActivity.kt');

const first = css.indexOf('/* Keep the phone header compact across landscape widths.');
const last = css.indexOf('/* Checkboxes and manual ordering', first);
assert.ok(first >= 0 && last > first);
const responsive = css.slice(first, last);

// The 721–960px landscape range used to revert to a multi-row desktop header.
// Only the header extends to 960px; task columns/toolbars retain their 720px rules.
assert.match(responsive, /@media\s*\(max-width:\s*960px\)\s*\{/);
const toolbarMedia = responsive.indexOf('@media (max-width: 720px)');
assert.ok(toolbarMedia > 0, 'separate 720px breakpoint for Kanban workspace');
const headerRules = responsive.slice(0, toolbarMedia);
const workspaceRules = responsive.slice(toolbarMedia);
for (const selector of ['.header', '.header-left', '.board-select',
                       '.header-menu-toggle', '.header-actions']) {
  assert.ok(headerRules.includes(selector), 'compact header selector: ' + selector);
}
assert.ok(!headerRules.includes('.toolbar {'), 'toolbar must keep original breakpoint');
assert.ok(!headerRules.includes('.column {'), 'board layout must keep original breakpoint');
assert.match(workspaceRules, /\.toolbar\s*\{/);
assert.match(workspaceRules, /\.board\s*\{/);

assert.match(headerRules, /\.header-left\s*\{[^}]*min-width:\s*0/s,
  'long board name cannot force the header to overflow');
assert.match(headerRules, /\.board-select\s*\{[^}]*min-width:\s*0/s);
assert.match(headerRules, /\.board-select\s*\{[^}]*text-overflow:\s*ellipsis/s);
assert.match(headerRules, /\.board-select\s*\{[^}]*overflow:\s*hidden/s);
assert.match(headerRules, /\.board-select\s*\{[^}]*white-space:\s*nowrap/s);
assert.match(headerRules, /\.header-menu-toggle\s*\{[^}]*width:\s*44px/s);
assert.match(headerRules, /padding:\s*calc\(6px\s*\+\s*var\(--safe-top\)\)/);
assert.match(headerRules, /right:\s*calc\(10px\s*\+\s*var\(--safe-right\)\)/);
assert.match(headerRules, /max-height:\s*min\(65dvh,\s*460px\)/);
assert.ok(html.includes('viewport-fit=cover'));
assert.ok(kotlin.includes('WindowInsetsCompat.Type.statusBars()'));
assert.ok(kotlin.includes('WindowInsetsCompat.Type.displayCutout()'));
assert.ok(kotlin.includes('view.setPadding(bars.left, bars.top, bars.right, bars.bottom)'));

// The rotation listener must use the same breakpoint as CSS, so the menu
// cannot be closed just because a phone rotates from 390px to 792px.
const match = js.match(/window\.addEventListener\('resize',\s*\(\)\s*=>\s*\{\s*if\s*\(window\.innerWidth\s*>\s*(\d+)\)\s*closeHeaderMenu\(\);\s*\}\);/);
assert.ok(match, 'resize handler closes the dropdown only on desktop');
assert.equal(Number(match[1]), 960);
let callback;
let closes = 0;
const sandbox = {
  window: {innerWidth: 320, addEventListener(name, fn) {
    assert.equal(name, 'resize'); callback = fn;
  }},
  closeHeaderMenu: () => { closes++; }
};
vm.runInNewContext(match[0], sandbox);
for (const width of [320, 360, 390, 480, 720, 721, 792, 896, 960]) {
  sandbox.window.innerWidth = width;
  callback();
  assert.equal(closes, 0, 'menu remains available on phone width ' + width);
}
sandbox.window.innerWidth = 961;
callback();
assert.equal(closes, 1, 'desktop transition safely dismisses the menu');
console.log('Mobile header responsive breakpoint, safe insets and rotation checks passed.');

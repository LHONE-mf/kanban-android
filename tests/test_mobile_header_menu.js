// Mobile Comrade header menu: DOM contract, keyboard/Android Back and data safety.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = p => fs.readFileSync(p, 'utf8');
const html = read('app/src/main/assets/kanban.html');
const css = read('app/src/main/assets/kanban.css');
const js = read('app/src/main/js-src/interactions.js');
const androidExtras = read('app/src/main/js-src/android-extras.js');

// All original actions must remain single DOM nodes with their original IDs.
// Moving their elements into the menu must not duplicate the handlers.
for (const id of ['boardSelect', 'addBoardBtn', 'focusBtn', 'themeBtn',
                  'exportBtn', 'importBtn', 'importFile', 'settingsBtn', 'clearBtn']) {
  assert.equal((html.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1,
    'original unique control must remain: ' + id);
}
assert.match(html, /id="headerMenuBtn"[^>]*aria-expanded="false"/);
assert.match(html, /id="headerActions"/);
assert.match(html, /aria-controls="headerActions"/);
const header = html.slice(html.indexOf('<header class="header">'), html.indexOf('</header>'));
assert.ok(header.indexOf('id="addBoardBtn"') > header.indexOf('id="headerActions"'),
  'new board action belongs in menu, not the always-visible board selector');
for (const id of ['addBoardBtn', 'focusBtn', 'themeBtn', 'exportBtn',
                  'importBtn', 'settingsBtn', 'clearBtn']) {
  assert.ok(header.indexOf('id="' + id + '"') > header.indexOf('id="headerActions"'),
    'menu must contain action: ' + id);
}
assert.match(css, /\.header-menu-toggle\s*\{\s*display:\s*none/);
assert.match(css, /@media\s*\(max-width:\s*720px\)/);
assert.match(css, /\.header-actions\.is-open\s*\{\s*display:\s*flex/);
assert.match(css, /\.header-actions\s+\.btn\s*\{[^}]*min-height:\s*44px/s);
assert.match(css, /padding:\s*calc\(6px\s*\+\s*var\(--safe-top\)\)/,
  'mobile header must respect Android display cutouts');

// Existing commands and persistence routines must still be attached to the same IDs.
for (const id of ['themeBtn', 'exportBtn', 'importBtn', 'settingsBtn',
                  'clearBtn', 'boardSelect', 'addBoardBtn']) {
  assert.ok(js.includes("$('#" + id + "').on"), 'original JS binding: ' + id);
}
assert.ok(androidExtras.includes("$('#focusBtn').onclick"));
assert.ok(js.includes("$('#headerMenuBtn').onclick = toggleHeaderMenu;"));
assert.match(js, /if\s*\(closeHeaderMenu\(true\)\)\s*return true;/,
  'Android Back consumes an open menu before it exits the app');
assert.match(js, /if\s*\(closeHeaderMenu\(true\)\)\s*\{\s*e\.preventDefault\(\);\s*return;/,
  'Escape must dismiss the menu');

// Exercise state transitions without a real Android device or new dependencies.
const start = js.indexOf('function closeHeaderMenu(');
const end = js.indexOf('function bindEvents()', start);
assert.ok(start >= 0 && end > start, 'menu helpers must be present');
const tokens = new Set();
const menu = {
  classList: {
    contains: name => tokens.has(name),
    add: name => tokens.add(name),
    remove: name => tokens.delete(name)
  },
  querySelector: () => firstAction
};
const trigger = {
  attributes: {},
  focusCount: 0,
  setAttribute(k, v) { this.attributes[k] = v; },
  focus() { this.focusCount++; }
};
const firstAction = {focusCount: 0, focus() { this.focusCount++; }};
const sandbox = {
  $: selector => ({'#headerActions': menu, '#headerMenuBtn': trigger})[selector]
};
vm.runInNewContext(js.slice(start, end) +
  '\nthis.toggle = toggleHeaderMenu; this.close = closeHeaderMenu;', sandbox);

assert.equal(sandbox.close(), false, 'closed menu cannot consume Back');
sandbox.toggle();
assert.ok(tokens.has('is-open'));
assert.equal(trigger.attributes['aria-expanded'], 'true');
assert.equal(firstAction.focusCount, 1);
sandbox.toggle();
assert.ok(!tokens.has('is-open'));
assert.equal(trigger.attributes['aria-expanded'], 'false');
assert.equal(trigger.focusCount, 1, 'closing with toggle returns focus');
sandbox.toggle();
assert.equal(sandbox.close(true), true, 'Back/Escape closes open menu');
assert.equal(trigger.attributes['aria-expanded'], 'false');
assert.equal(trigger.focusCount, 2);
console.log('Mobile header menu interactions and safety checks passed.');

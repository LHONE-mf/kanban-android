// Android Back and exact-image regression (offline, no third-party dependencies).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const read = p => fs.readFileSync(p, 'utf8');
const source = read('app/src/main/js-src/interactions.js');
const kotlin = read('app/src/main/java/com/kanban/offline/MainActivity.kt');
const begin = source.indexOf('function comradeHandleAndroidBack() {');
const end = source.indexOf('\nwindow.comradeHandleAndroidBack = comradeHandleAndroidBack;', begin);
assert.ok(begin >= 0 && end > begin);
assert.ok(kotlin.includes('window.comradeHandleAndroidBack()'));
assert.ok(kotlin.includes('if (handled == "true")'));
assert.ok(kotlin.includes('lastBackGestureAt = 0L'));
assert.ok(kotlin.includes('webView.loadUrl("$appOrigin/assets/kanban.html")'));
const handler = source.slice(begin, end);
function scenario(open = []) {
  const calls = {save: 0,lightbox: 0,cancel: 0,closed: []};
  const dom = {};
  for (const id of ['lightbox','confirmModal','textPromptModal','taskModal','settingsModal','shortcutsModal']) {
    dom[id] = {classList: {contains: cls => cls === 'open' && open.includes(id)}};
  }
  dom.confirmCancel = {click: () => calls.cancel++};
  dom.textPromptCancel = {click: () => calls.cancel++};
  dom.dayPlanPanel = {hidden: !open.includes('dayPlanPanel')};
  dom.pomo = {hidden: !open.includes('pomo')};
  const sandbox = {
    $: id => dom[id.slice(1)],
    saveTaskFromModal: () => {calls.save++; return Promise.resolve();},
    closeLightbox: () => {calls.lightbox++;},
    closeModal: id => {calls.closed.push(id);}
  };
  vm.runInNewContext(handler + '\nthis.back = comradeHandleAndroidBack;', sandbox);
  return {handled: sandbox.back(), calls, dom};
}
assert.equal(scenario(['taskModal']).calls.save, 1, 'Back must save edited task');
assert.equal(scenario(['taskModal']).handled, true, 'editor consumes Back');
assert.equal(scenario(['taskModal','lightbox']).calls.save, 0, 'topmost lightbox goes first');
assert.equal(scenario(['taskModal','lightbox']).calls.lightbox, 1);
assert.equal(scenario(['taskModal','confirmModal']).calls.cancel, 1);
assert.equal(scenario(['taskModal','confirmModal']).calls.save, 0);
const day = scenario(['dayPlanPanel']);
assert.equal(day.handled,true); assert.equal(day.dom.dayPlanPanel.hidden,true);
assert.equal(scenario([]).handled,false, 'exit only when no overlay');
assert.ok(read('app/src/main/js-src/tasks.js').includes('await dbPutTask(candidate)'));
const originals = {
  'app/src/main/res/drawable-nodpi/ic_launcher_foreground.png':'af46ebfbae9c0f901fa095758ba9921f6c15075b',
  'app/src/main/res/mipmap-mdpi/ic_launcher.png':'71702b8560838d320ec0a40b7a30cfeb290336ad',
  'app/src/main/res/mipmap-hdpi/ic_launcher.png':'c5f96b0d699cf1d497c5f9301a7be4ae50fb6531',
  'app/src/main/res/mipmap-xhdpi/ic_launcher.png':'7112d6d7d9adcc5e8fd7068ed8e04f6cf1bdff2e',
  'app/src/main/res/mipmap-xxhdpi/ic_launcher.png':'dc5eb3e281eb9f3ae852b4bc8f559cdb0e409a44',
  'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png':'647339856d9db4120b49c92baea347223291c391',
  'app/src/main/assets/comrade-icon.png':'647339856d9db4120b49c92baea347223291c391'
};
for (const [path, sha] of Object.entries(originals)) {
  const bytes = fs.readFileSync(path);
  const actual = crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  assert.equal(actual, sha, 'exact original icon bytes: ' + path);
}
assert.ok(!fs.existsSync('app/src/main/res/drawable/ic_launcher_foreground.xml'));
assert.ok(!fs.existsSync('app/src/main/assets/comrade-icon.svg'));
assert.ok(read('app/src/main/assets/kanban.html').includes('comrade-icon.png'));
console.log('Android Back and original Comrade image regression passed.');

// Integration regression: mobile menu, drag safety and attachment gallery coexist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const root = 'app/src/main/';
const html = fs.readFileSync(root+'assets/kanban.html','utf8');
const css = fs.readFileSync(root+'assets/kanban.css','utf8');
const ui = fs.readFileSync(root+'js-src/interactions.js','utf8');
const tasks = fs.readFileSync(root+'js-src/tasks.js','utf8');
const media = fs.readFileSync(root+'js-src/media-dialogs.js','utf8');
const native = fs.readFileSync(root+'java/com/kanban/offline/MainActivity.kt','utf8');
for (const id of ['headerMenuBtn','headerActions','boardSelect','lightboxClose',
                  'lightboxPrev','lightboxNext','lightboxZoomIn','lightboxZoomOut',
                  'lightboxContent','taskFile','importFile']) {
  assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1,'unique '+id);
}
for (const marker of ["$('#headerMenuBtn').onclick = toggleHeaderMenu",
                      "function stageSelectedFiles(files)",
                      "function getDropListAt(x, y)",
                      "viewer.addEventListener('pointerdown', lightboxPointerDown)",
                      "if (closeHeaderMenu(true)) return true;"]) {
  assert.ok(ui.includes(marker),'mobile and media interaction: '+marker);
}
assert.match(css,/\.header-actions\.is-open\s*\{\s*display:\s*flex/);
assert.match(css,/\.lightbox-stage\s*\{/);
assert.ok(tasks.includes('let activeFileOpen = null;'));
assert.ok(media.includes('const lightboxGallery = {'));
assert.ok(native.includes('KanbanAttachmentOpener'));
const bundle=fs.readFileSync(root+'assets/kanban.js','utf8');
const parts=['core','views','tasks','media-dialogs','data-transfer',
             'interactions','daily-plan','android-extras'];
assert.equal(bundle,parts.map(p=>fs.readFileSync(root+'js-src/'+p+'.js','utf8')).join(''),
  'WebView bundle combines all features in the required module order');
console.log('Combined mobile navigation, drag, attachment gallery and native bridge passed.');

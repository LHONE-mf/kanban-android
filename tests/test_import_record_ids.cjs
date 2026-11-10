// Imported record IDs must remain ordinary data, including Object property names.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = fs.readFileSync('app/src/main/js-src/core.js', 'utf8');
const transfer = fs.readFileSync('app/src/main/js-src/data-transfer.js', 'utf8');
const section = (start, end) => {
  const from = transfer.indexOf(start), to = transfer.indexOf(end, from);
  assert(from >= 0 && to > from);
  return transfer.slice(from, to);
};
let download;
const ctx = {
  Blob, atob, console,
  window: { addEventListener() {}, KanbanBackup: { postMessage() {} } },
  localStorage: { getItem: () => null },
  saveBackupViaAndroid: async blob => { download = blob; return true; },
  location: { origin: 'https://appassets.androidplatform.net' },
  showToast() {}, inputMedia: Object.create(null),
  blobToBase64: async blob => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`
};
vm.createContext(ctx);
vm.runInContext(core +
  section('const JAPANESE_BACKUP_KEYS =', '// Android saves through SAF') +
  section('async function exportData()', 'function blobToBase64(') +
  section('function base64ToBlob(', 'async function handleImport(') +
  '\nmediaGet = async id => globalThis.inputMedia[id];' +
  '\nObject.assign(globalThis, { buildImportPlan, rebucket, exportData, getState: () => state });\n})();', ctx);

(async () => {
  const ids = ['__proto__', 'constructor', 'toString'];
  const backup = {
    version: 4, activeBoardId: '__proto__',
    boards: ids.map(id => ({ id, name: 'Board ' + id, columns: [{ id: 'todo', title: 'To Do' }] })),
    tasks: ids.map((id, index) => ({
      id: 'task-' + index, boardId: id, columnId: 'todo', title: 'Task ' + index,
      files: [{ id, name: id + '.txt', type: 'text/plain' }]
    })),
    media: Object.fromEntries(ids.map(id => [id, {
      type: 'text/plain', data: 'data:text/plain;base64,' + Buffer.from('Attachment ' + id).toString('base64')
    }]))
  };
  const plan = await ctx.buildImportPlan(JSON.parse(JSON.stringify(backup)));
  ctx.rebucket(plan.tasks, plan.boards, plan.activeBoardId);
  const state = ctx.getState();
  assert.deepEqual(Object.keys(state._tasksByBoard).sort(), [...ids].sort(),
    'Every imported board must be enumerable for backups and reminder rescheduling');
  assert.equal(Object.values(state._tasksByBoard).flat().length, 3, 'No imported task may disappear');
  assert.equal(state.activeBoardId, '__proto__');
  assert.deepEqual(Object.keys(plan.media).sort(), [...ids].sort(),
    'Import must retain attachments whose IDs match Object property names');
  for (const task of plan.tasks) {
    assert.equal(task.files[0].id, task.boardId, 'First attachment reference must keep its stable ID');
    assert.equal(await plan.media[task.files[0].id].full.text(), 'Attachment ' + task.boardId);
  }
  ctx.inputMedia = plan.media;
  await ctx.exportData();
  const exported = JSON.parse(await download.text());
  assert.equal(exported.tasks.length, 3, 'A subsequent backup must include all imported boards');
  assert.deepEqual(Object.keys(exported.media).sort(), [...ids].sort());
  const roundTrip = await ctx.buildImportPlan(exported);
  assert.equal(roundTrip.tasks.length, 3);
  assert.equal(Object.keys(roundTrip.media).length, 3);
  assert.equal(roundTrip.report.brokenMedia, 0);

  // Missing board IDs must not accidentally resolve to inherited properties.
  const ordinary = [{ id: 'normal', name: 'Normal', columns: [{ id: 'todo' }] }];
  ctx.rebucket([{ id: 'orphan', boardId: 'constructor', columnId: 'todo', title: 'Legacy task' }], ordinary, 'normal');
  assert.equal(ctx.getState()._tasksByBoard.normal[0].boardId, 'normal');
  const legacy = await ctx.buildImportPlan([{ id: 'legacy', title: 'Old backup' }]);
  assert.equal(legacy.tasks.length, 1, 'Legacy task-array backups remain supported');
  assert.equal(legacy.report.brokenMedia, 0);
  console.log('Import IDs: special board/media keys, stable references, complete backup round-trip and legacy fallback passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

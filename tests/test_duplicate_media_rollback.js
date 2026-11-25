// Duplicate task failures must not leave unreferenced copies or delete originals.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const src = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
const start = src.indexOf('async function duplicateTask(');
const end = src.indexOf('// FOCUS TRAP', start);
assert.ok(start >= 0 && end > start, 'test the actual duplicateTask implementation');

async function scenario(failAt, withAttachments = true) {
  const original = {
    id: 'task-original', boardId: 'board-a', columnId: 'todo', title: 'Original',
    files: withAttachments ? [
      {id: 'original-1', name: 'one.png', type: 'image/png'},
      {id: 'original-2', name: 'two.png', type: 'image/png'}
    ] : [],
    tags: ['important'], checklist: [], order: 0,
    results:[{id:'r',text:'Original result',createdAt:1,updatedAt:1}]
  };
  const state = {activeBoardId: 'board-a', tasks: [original]};
  const stored = new Set(original.files.map(f => f.id));
  const deleted = [], saved = [], toasts = [], events = [];
  let idSequence = 0;
  const ctx = {
    state, Date,
    generateId: () => 'new-' + ++idSequence,
    mediaGet: async id => stored.has(id) ? {full: new Blob(['bytes']), thumb: null, type: 'image/png'} : null,
    mediaPut: async id => {
      if (failAt === 'media' && id === 'm_new-2') throw new Error('storage full');
      stored.add(id);
    },
    mediaDelete: async id => {
      // Ensure callers WAIT for asynchronous cleanup rather than fire-and-forget.
      await new Promise(resolve => setImmediate(resolve));
      stored.delete(id);
      deleted.push(id);
      events.push('removed:' + id);
    },
    dbPutTask: async item => {
      if (failAt === 'database') throw new Error('task database full');
      saved.push(item);
    },
    showToast: message => {toasts.push(message); events.push('toast');},
    closeModal: () => {}, notifyOtherTabs: () => {}, renderBoard: () => {},
    renderTaskCollectionChange: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nthis.duplicate = duplicateTask;', ctx);
  await ctx.duplicate('task-original');
  return {state, stored, deleted, saved, toasts, events};
}

(async () => {
  for (const failure of ['media', 'database']) {
    const r = await scenario(failure);
    assert.equal(r.state.tasks.length, 1, failure + ': original task remains sole task');
    assert.equal(r.saved.length, 0, failure + ': no new task committed');
    assert.deepEqual([...r.stored].sort(), ['original-1', 'original-2'],
      failure + ': all copied blobs must be removed before duplication resolves');
    assert.equal(r.deleted.length, failure === 'media' ? 1 : 2,
      failure + ': clean up only successfully copied media');
    assert.ok(r.deleted.every(id => id.startsWith('m_new-')),
      failure + ': never remove the original attachments');
    assert.ok(r.toasts.some(s => s.includes('Не удалось')),
      failure + ': show a visible error');
    assert.equal(r.events.at(-1), 'toast',
      failure + ': cleanup must finish before reporting the failure');
  }
  const ok = await scenario(null);
  assert.equal(ok.state.tasks.length, 2, 'normal duplication adds one task');
  assert.equal(ok.saved.length, 1, 'normal duplication saves one new task');
  assert.equal(ok.stored.size, 4, 'normal duplication keeps both original and copied blobs');
  assert.equal(ok.deleted.length, 0, 'normal duplication does not clean up successful copies');
  assert.equal(ok.state.tasks[1].files.length, 2, 'new task references its copied files');
  assert.equal(ok.state.tasks[1].results.length,0,'copy starts with no prior execution results');
  assert.equal(ok.state.tasks[0].results[0].text,'Original result');
  const empty = await scenario(null, false);
  assert.equal(empty.state.tasks.length, 2, 'no-attachment duplication still works');
  assert.equal(empty.stored.size, 0);
  console.log('Duplicate media rollback: async cleanup, original data and success verified.');
})().catch(error => {console.error(error); process.exitCode = 1;});

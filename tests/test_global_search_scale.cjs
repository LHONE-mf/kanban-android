// A deterministic work budget guards filter responsiveness on long descriptions.
// Wall-clock timing varies too much between developer machines and CI runners.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/views.js', 'utf8');
const state = { boards: [], _tasksByBoard: {} };
for (let b = 0; b < 10; b++) {
  const board = { id: 'board' + b, name: 'Quality-' + b,
    columns: [{ id: 'todo', isDone: false }, { id: 'done', isDone: true }] };
  state.boards.push(board);
  state._tasksByBoard[board.id] = Array.from({ length: 1000 }, (_, i) => ({
    id: b + '-' + i, boardId: board.id, title: 'Inspection ' + i,
    desc: '検査 measurement follow-up '.repeat(150), tags: ['qc', '工場'],
    checklist: [{ text: 'Measure voltage' }],
    columnId: i % 4 === 0 ? 'done' : 'todo',
    parentId: i % 5 === 0 ? b + '-0' : '',
    priority: 'high', deadline: '2026-11-11', updatedAt: i
  }));
}
const ctx = { state, dayDiff: () => 0 };
vm.createContext(ctx);
const end = source.indexOf('function updateGlobalSearchBoardFilter()');
assert(end > 0);
vm.runInContext(source.slice(0, end), ctx);
vm.runInContext(`
  function measuredSearch(query, limit, filters) {
    const normalize = String.prototype.normalize;
    let normalizedCharacters = 0;
    String.prototype.normalize = function(...args) {
      normalizedCharacters += this.length;
      return normalize.apply(this, args);
    };
    try {
      const result = searchAllBoards(query, limit, filters);
      return { result, normalizedCharacters };
    }
    finally { String.prototype.normalize = normalize; }
  }
`, ctx);

for (const [filters, total, firstId] of [
  [{ status: 'active' }, 7500, '0-999'],
  [{ boardId: 'board4', status: 'active', priority: 'high', tag: 'ＱＣ' }, 750, '4-999'],
  [{ status: 'active', deadline: 'attention' }, 7500, '0-999'],
  [{ status: 'done' }, 2500, '0-996']
]) {
  const measured = ctx.measuredSearch(' \u3000 ', 100, filters);
  assert.equal(measured.result.total, total, 'Filter totals include nested tasks across boards');
  assert.equal(measured.result.items.length, 100, 'Large filtered results retain pagination');
  assert.equal(measured.result.items[0].task.id, firstId, 'Filtered ordering remains stable');
  assert(measured.normalizedCharacters < 1000000,
    'Filter-only search must avoid normalizing megabytes of unrelated task text: ' + measured.normalizedCharacters);
}
const firstPage = ctx.searchAllBoards('', 100, { status: 'active' });
const expanded = ctx.searchAllBoards('', 200, { status: 'active' });
assert.deepEqual(Array.from(expanded.items.slice(0, 100), x => x.task.id),
  Array.from(firstPage.items, x => x.task.id), 'Expanding a filtered search preserves the first page');
assert.equal(new Set(expanded.items.map(x => x.task.id)).size, 200, 'Pages contain unique tasks');
assert.equal(ctx.searchAllBoards('検査 voltage', 100, { status: 'active' }).total, 7500,
  'Text search still examines descriptions and checklists');
assert.equal(ctx.searchAllBoards('Quality-4', 100, { status: 'active' }).total, 750,
  'Board names remain searchable');
assert.equal(ctx.searchAllBoards(''), undefined, 'No query or filters retains initial guidance');
assert.equal(Object.values(state._tasksByBoard).flat().length, 10000, 'Search preserves every source task');
console.log('Global search scale: 10,000 tasks, bounded normalization, filters, pagination and Unicode passed');

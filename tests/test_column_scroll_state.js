// Step 05: scroll position belongs to the active board, not to shared column IDs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/views.js', 'utf8');
const start = source.indexOf('function renderBoard() {');
const end = source.indexOf('\nfunction createTaskCard(', start);
assert.ok(start >= 0 && end > start, 'renderBoard source section exists');

function element() {
  return {
    dataset: {}, children: [], scrollTop: 0, className: '', style: {},
    _innerHTML: '',
    set innerHTML(s) { this._innerHTML = s; this.children = []; },
    get innerHTML() { return this._innerHTML; },
    appendChild(child) { this.children.push(child); return child; }
  };
}
const board = element();
board.scrollLeft = 0;
const state = {
  activeBoardId: 'board_one',
  columns: [
    {id:'col_todo',title:'To Do',color:'#aaa',isDone:false,wipLimit:0},
    {id:'col_done',title:'Done',color:'#0a0',isDone:true,wipLimit:0}
  ],
  tasks: []
};
const context = {
  state, currentView:'kanban', document:{createElement:()=>element()},
  $:selector=>{assert.equal(selector,'#board');return board;},
  $$:(selector,root)=>{
    assert.equal(selector,'.task-list');
    return root.children.flatMap(col=>col.children.filter(child=>child.className==='task-list'));
  },
  updateTagFilter(){},getVisibleTasks(){return[];},
  sortTasks(tasks){return tasks;},
  escapeHtml:s=>String(s), updateStorageInfo(){},
  openTaskModal(){}, renderDashboard(){},renderMindmap(){},renderCalendar(){}
};
vm.runInNewContext(source.slice(start,end),context);
const list = id => board.children.find(col=>col.dataset.columnId===id).children
  .find(child=>child.className==='task-list');
context.renderBoard();
assert.equal(board.dataset.boardId,'board_one', 'new render stamps board identity');
board.scrollLeft=182;
list('col_todo').scrollTop=77;
list('col_done').scrollTop=24;
context.renderBoard();
assert.equal(board.scrollLeft,182, 'same-board rerender preserves horizontal scroll');
assert.equal(list('col_todo').scrollTop,77, 'same-board rerender preserves todo list position');
assert.equal(list('col_done').scrollTop,24, 'same-board rerender preserves done list position');

// Different boards reuse the same default column IDs. Their scroll positions must
// never inherit those of the previous board.
state.activeBoardId='board_two';
context.renderBoard();
assert.equal(board.dataset.boardId,'board_two');
assert.equal(board.scrollLeft,0, 'board switch starts at the first column');
assert.equal(list('col_todo').scrollTop,0, 'board switch starts at the top of todo');
assert.equal(list('col_done').scrollTop,0, 'board switch starts at the top of done');
board.scrollLeft=98;
list('col_todo').scrollTop=44;
context.renderBoard();
assert.equal(board.scrollLeft,98,'new board retains its own position on rerender');
assert.equal(list('col_todo').scrollTop,44);
state.activeBoardId='board_one';
context.renderBoard();
assert.equal(board.scrollLeft,0,'returning to board starts at first column');
assert.equal(list('col_todo').scrollTop,0);

// Scroll is native and per-axis; don't replace it with JavaScript gesture hacks.
const css = fs.readFileSync('app/src/main/assets/kanban.css','utf8');
assert.match(css, /\.board\s*\{[^}]*overflow-x:\s*auto;\s*overflow-y:\s*hidden/s);
assert.match(css, /\.task-list\s*\{[^}]*overflow-y:\s*auto/s);
assert.match(css, /\.task-card\s*\{[^}]*touch-action:\s*manipulation/s);
console.log('Column scroll restoration, board isolation and native panning checks passed.');

// P16.1: a stable edit refreshes only one card, with safe full-render fallbacks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const views = fs.readFileSync('app/src/main/js-src/views.js', 'utf8');
const tasks = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
const from = views.indexOf('function renderSavedTaskCard(');
const to = views.indexOf('\nfunction createTaskCard(', from);
assert.ok(from >= 0 && to > from, 'targeted update function exists');

function card(id) {
  return {
    dataset: { taskId: id }, classList: { contains: c => c === 'task-card' },
    contains(el) { return el === this; },
    replaceWith(replacement) {
      const index = list.children.indexOf(this);
      assert.notEqual(index, -1);
      list.children[index] = replacement;
    },
    focus(opts) { this.focusOptions = opts; }
  };
}
const original = card('t1');
const untouched = card('t2');
const list = {dataset:{columnId:'todo'},children:[original,untouched]};
const board = {dataset:{boardId:'b'}};
let fullRenders = 0, changedCards = 0, tagsUpdated = 0, storageUpdated = 0;
const context = {
  sortMode:'manual', currentView:'kanban', searchQuery:'',
  filterTag:'',filterPriority:'',filterDeadline:'',
  state:{activeBoardId:'b',columns:[{id:'todo',title:'To Do'}]},
  document:{activeElement:original},
  $:sel=>{assert.equal(sel,'#board');return board;},
  $$:(sel,root)=>{assert.equal(sel,'.task-list');assert.equal(root,board);return [list];},
  createTaskCard:(task,col)=>{
    changedCards++;
    assert.equal(col.id,'todo');
    return card(task.id);
  },
  renderBoard:()=>fullRenders++,
  updateTagFilter:()=>tagsUpdated++,
  updateStorageInfo:()=>storageUpdated++
};
vm.createContext(context);
vm.runInContext(views.slice(from,to)+'\nthis.update = renderSavedTaskCard;',context);

const before = {id:'t1',parentId:'',boardId:'b',columnId:'todo',order:5,title:'Old'};
const after = {...before,title:'New'};
context.update(before,after);
assert.equal(changedCards,1,'exactly one replacement constructed');
assert.equal(fullRenders,0,'ordinary edit must not rebuild entire board');
assert.equal(list.children[1],untouched,'unrelated card remains same object');
assert.notEqual(list.children[0],original,'edited card was replaced');
assert.equal(list.children[0].dataset.taskId,'t1');
assert.equal(list.children[0].focusOptions.preventScroll,true,'keyboard focus restored without scrolling');
assert.equal(tagsUpdated,1);
assert.equal(storageUpdated,1);

function fallback(oldTask,newTask,overrides={}) {
  Object.assign(context,overrides);
  const oldFull=fullRenders,oldChanged=changedCards;
  context.update(oldTask,newTask);
  assert.equal(fullRenders,oldFull+1,'unsafe edit triggers full render');
  assert.equal(changedCards,oldChanged,'no partial replacement on fallback');
  Object.assign(context,{sortMode:'manual',currentView:'kanban',searchQuery:'',
    filterTag:'',filterPriority:'',filterDeadline:''});
}
fallback(null,after); // new task
fallback({...before,parentId:'p'},after); // nested task
fallback(before,{...after,parentId:'p'}); // moved under parent
fallback(before,{...after,columnId:'done'}); // changed column
fallback(before,{...after,order:4}); // position changed
fallback(before,{...after,boardId:'other'}); // changed board
fallback(before,after,{filterTag:'urgent'}); // tag visibility may change
fallback(before,after,{filterPriority:'high'});
fallback(before,after,{filterDeadline:'today'});
fallback(before,after,{searchQuery:'old'});
fallback(before,after,{sortMode:'updated_desc'}); // timestamp changes position
fallback(before,after,{sortMode:'priority_desc'});
fallback(before,after,{sortMode:'title'});
fallback(before,after,{sortMode:'deadline_asc'});
fallback(before,after,{currentView:'dashboard'});
context.sortMode='created_asc';
context.document.activeElement=null;
const again=list.children[0];
context.update(before,after);
assert.equal(fullRenders,15,'created-time sort permits a stable edit');
assert.equal(changedCards,2);
assert.notEqual(list.children[0],again);

context.sortMode='manual';
list.children=[];
fallback(before,after); // missing card: stale DOM, fall back safely
list.children=[card('t1'),untouched];
board.dataset.boardId='other';
fallback(before,after); // board changed while saving
board.dataset.boardId='b';
assert.ok(tasks.includes("renderSavedTaskCard(existing, candidate)"),
  'only task editor save uses partial update');
assert.ok(tasks.includes("closeModal('taskModal'); notifyOtherTabs(); renderSavedTaskCard(existing, candidate)"));
assert.ok(tasks.includes("closeModal('taskModal'); notifyOtherTabs(); renderBoard();"),
  'duplicate-task handling stays full render');
console.log('P16.1 stable card update, focus, untouched cards, and all fallback paths passed.');

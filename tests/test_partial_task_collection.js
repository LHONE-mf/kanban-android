// P16.2: collection mutations change only the affected cards and column header.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const views = fs.readFileSync('app/src/main/js-src/views.js', 'utf8');
const tasks = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
const interactions = fs.readFileSync('app/src/main/js-src/interactions.js', 'utf8');
const start = views.indexOf('function taskRootForCollection(');
const end = views.indexOf('\nfunction createTaskCard(', start);
assert.ok(start >= 0 && end > start, 'partial collection implementation exists');
const makeClasses = initial => {
  const values = new Set(initial);
  return {
    contains: val => values.has(val),
    toggle: (val, enabled) => enabled ? values.add(val) : values.delete(val)
  };
};
function makeCard(id) {
  return {
    dataset:{taskId:id},classList:makeClasses(['task-card']),focusOpts:null,
    contains(elt) {return elt === this;},
    focus(opts) {this.focusOpts = opts;},
    remove() {const at=this.parent.children.indexOf(this);if(at>=0)this.parent.children.splice(at,1);},
    replaceWith(next) {const at=this.parent.children.indexOf(this);assert.ok(at>=0);next.parent=this.parent;this.parent.children[at]=next;}
  };
}
function makeList(id, initial) {
  const list = {
    dataset:{columnId:id},children:[],scrollTop:123,
    appendChild(el){el.parent=this;this.children.push(el);return el;},
    insertBefore(el,next){el.parent=this;const at=next?this.children.indexOf(next):this.children.length;assert.ok(at>=0);this.children.splice(at,0,el);},
    replaceChildren(...els){this.children=[];els.forEach(el=>this.appendChild(el));}
  };
  initial.forEach(id=>list.appendChild(makeCard(id)));
  return list;
}
function makeColumn(id,cardIds) {
  const list=makeList(id,cardIds), count={textContent:''},header={classList:makeClasses(['column-header']),
    querySelector:sel=>sel==='.column-count'?count:null};
  const element={dataset:{columnId:id},querySelector:sel=>sel==='.task-list'?list:sel==='.column-header'?header:null};
  return {element,list,count,header};
}
const todo=makeColumn('todo',['a','b']), done=makeColumn('done',['z']);
const board={dataset:{boardId:'board'},children:[todo.element,done.element],scrollLeft:156};
const task=(id,columnId,order,parentId='')=>({id,boardId:'board',columnId,order,parentId});
const a=task('a','todo',0),b=task('b','todo',10),z=task('z','done',0);
const state={activeBoardId:'board',columns:[{id:'todo',wipLimit:2},{id:'done',wipLimit:0}],tasks:[a,b,z]};
let renders=0,made=[],tags=0,storage=0;
const context={
  state,sortMode:'manual',currentView:'kanban',searchQuery:'',
  filterTag:'',filterPriority:'',filterDeadline:'',
  document:{activeElement:null,createElement:tag=>({tag,className:'',textContent:'',classList:makeClasses([])})},
  $:sel=>{assert.equal(sel,'#board');return board;},
  getVisibleTasks:()=>state.tasks.filter(t=>!t.parentId),
  sortTasks:ts=>[...ts].sort((x,y)=>x.order-y.order),
  createTaskCard:(t,col)=>{made.push(t.id);assert.equal(col.id,t.columnId);const el=makeCard(t.id);el.nested=state.tasks.filter(x=>x.parentId===t.id).length;return el;},
  renderBoard:()=>renders++,
  updateTagFilter:()=>tags++,
  updateStorageInfo:()=>storage++
};
vm.createContext(context);
vm.runInContext(views.slice(start,end)+'\nthis.rootOf = taskRootForCollection; this.mutate=renderTaskCollectionChange;',context);
const ids=list=>list.children.map(c=>c.dataset?.taskId||'empty');
const oldB=todo.list.children[1],oldDone=done.list.children[0];
const next=task('new','todo',-1);
state.tasks.push(next);
context.mutate(next,false);
assert.deepEqual(ids(todo.list),['new','a','b'],'new root inserted in correct place');
assert.equal(todo.count.textContent,'3/2','WIP header includes limit and actual count');
assert.equal(todo.header.classList.contains('wip-exceeded'),true);
assert.equal(todo.list.children[2],oldB,'other card DOM identity preserved');
assert.equal(done.list.children[0],oldDone,'other column DOM untouched');
assert.equal(todo.list.scrollTop,123);
assert.equal(board.scrollLeft,156);
assert.deepEqual(made,['new']);
assert.equal(renders,0,'not one full board render');

state.tasks=state.tasks.filter(t=>t!==next);
context.mutate(next,true);
assert.deepEqual(ids(todo.list),['a','b']);
assert.equal(todo.count.textContent,'2/2');
assert.equal(todo.header.classList.contains('wip-warning'),true);
assert.equal(todo.header.classList.contains('wip-exceeded'),false);
assert.equal(renders,0);
state.tasks=state.tasks.filter(t=>t!==a);
context.mutate(a,true);
assert.deepEqual(ids(todo.list),['b']);
assert.equal(todo.header.classList.contains('wip-warning'),false);
state.tasks=state.tasks.filter(t=>t!==b);
context.mutate(b,true);
assert.deepEqual(ids(todo.list),['empty'],'last removal displays empty hint');
assert.equal(todo.count.textContent,'0/2');
state.tasks.push(b);
context.mutate(b,false); // Undo after successful restore
assert.deepEqual(ids(todo.list),['b'],'undo replaces empty hint with restored card');
assert.equal(todo.list.scrollTop,123);

state.tasks.push(a);
context.mutate(a,false);
const bCard=todo.list.children.find(el=>el.dataset.taskId==='b');
const parentCard=todo.list.children.find(el=>el.dataset.taskId==='a');
const child=task('child','todo',0,'a');
state.tasks.push(child);
assert.equal(context.rootOf(child),a);
context.mutate(child,false);
const updatedParent=todo.list.children.find(el=>el.dataset.taskId==='a');
assert.notEqual(updatedParent,parentCard,'parent footer updated for nested insertion');
assert.equal(updatedParent.nested,1);
assert.equal(todo.list.children.find(el=>el.dataset.taskId==='b'),bCard);
assert.equal(todo.count.textContent,'2/2','nested child does not affect WIP');
state.tasks=state.tasks.filter(t=>t!==child);
context.mutate(child,true,a); // Deleted child no longer exists in state
assert.equal(todo.list.children.find(el=>el.dataset.taskId==='a').nested,0);
state.tasks.push(child);
context.mutate(child,false); // Restored child
assert.equal(todo.list.children.find(el=>el.dataset.taskId==='a').nested,1);
assert.equal(done.list.children[0],oldDone);
assert.equal(renders,0);

const fallback=(callback,overrides={})=>{
  const before=renders;
  Object.assign(context,overrides);
  callback();
  assert.equal(renders,before+1,'unsafe operation uses existing full render');
  Object.assign(context,{currentView:'kanban',searchQuery:'',filterTag:'',filterPriority:'',filterDeadline:''});
};
const x=task('x','todo',15);
state.tasks.push(x);
fallback(()=>context.mutate(x,false),{filterTag:'important'});
fallback(()=>context.mutate(x,false),{filterPriority:'high'});
fallback(()=>context.mutate(x,false),{filterDeadline:'today'});
fallback(()=>context.mutate(x,false),{searchQuery:'find'});
fallback(()=>context.mutate(x,false),{currentView:'dashboard'});
board.dataset.boardId='other';
fallback(()=>context.mutate(x,false));
board.dataset.boardId='board';
fallback(()=>context.mutate({...x,boardId:'other'},false));
const orphan=task('orphan','todo',0,'missing-parent');
fallback(()=>context.mutate(orphan,false));
assert.equal(context.rootOf(orphan),null);
const loop=task('loop','todo',0,'loop');
state.tasks.push(loop);
assert.equal(context.rootOf(loop),null,'cyclic hierarchy cannot loop forever');
assert.ok(tags>0&&storage>0,'tag options and storage labels refreshed');
assert.match(tasks,/renderTaskCollectionChange\(root, true, rootBeforeRemoval\)/);
assert.match(tasks,/renderTaskCollectionChange\(root, false\)/);
assert.match(tasks,/else renderTaskCollectionChange\(candidate, false\)/);
assert.match(tasks,/renderTaskCollectionChange\(copy, false\)/);
assert.match(interactions,/renderTaskCollectionChange\(task, false\)/);
console.log('P16.2: targeted add/delete, nested counts, undo, WIP, scroll and fallbacks passed.');

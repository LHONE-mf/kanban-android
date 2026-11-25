// P16.4: real visibility/sorting logic with a tiny in-memory DOM.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const views=fs.readFileSync('app/src/main/js-src/views.js','utf8');
const core=fs.readFileSync('app/src/main/js-src/core.js','utf8');
const interactions=fs.readFileSync('app/src/main/js-src/interactions.js','utf8');
const start=views.indexOf('function renderFilteredBoard(');
const end=views.indexOf('// P16.1:',start);
const coreStart=core.indexOf('function getVisibleTasks('),coreEnd=core.indexOf('function isDragAllowed()',coreStart);
assert.ok(start>=0&&end>start&&coreStart>=0&&coreEnd>coreStart);
function classes(...values){
  const s=new Set(values);
  return {contains:v=>s.has(v),add:v=>s.add(v),remove:v=>s.delete(v),toggle:(v,on)=>on?s.add(v):s.delete(v)};
}
function listNode(){
  return {children:[],scrollTop:42,
    appendChild(el){return this.insertBefore(el,null);},
    insertBefore(el,next){
      if(el.parentElement){const arr=el.parentElement.children;const ix=arr.indexOf(el);if(ix>=0)arr.splice(ix,1);}
      const i=next?this.children.indexOf(next):this.children.length;
      assert.ok(i>=0);this.children.splice(i,0,el);el.parentElement=this;return el;
    }};
}
function item(id=null){
  const isCard=!!id;
  const element={dataset:isCard?{taskId:id}:{},classList:classes(isCard?'task-card':'empty-hint'),
    parentElement:null,className:isCard?'task-card':'empty-hint',
    get nextElementSibling(){if(!this.parentElement)return null;const a=this.parentElement.children;return a[a.indexOf(this)+1]||null;},
    remove(){const a=this.parentElement.children;a.splice(a.indexOf(this),1);this.parentElement=null;}};
  return element;
}
function column(id,ids,wipLimit){
  const list=listNode(),count={textContent:''},header={classList:classes('column-header'),
    querySelector:sel=>sel==='.column-count'?count:null},
    node={dataset:{columnId:id},querySelector:sel=>sel==='.task-list'?list:sel==='.column-header'?header:null};
  ids.forEach(x=>list.appendChild(item(x)));if(!ids.length)list.appendChild(item());
  return {id,node,list,header,count,wipLimit};
}
const a=column('a',['t1','t2'],2),b=column('b',['t3'],0),empty=column('empty',[],0);
const board={dataset:{boardId:'b'},children:[a.node,b.node,empty.node],scrollLeft:93};
const task=(id,col,title,tags,priority,order,deadline='')=>({id,boardId:'b',columnId:col,
  parentId:'',title,desc:'',tags,priority,order,deadline,checklist:[],createdAt:order,updatedAt:order});
const t1=task('t1','a','Alpha',['red'],'high',0),t2=task('t2','a','Bravo',['blue'],'low',1),
      t3=task('t3','b','Charlie',['red'],'medium',0);
const state={activeBoardId:'b',columns:[a,b,empty].map(c=>({id:c.id,wipLimit:c.wipLimit,isDone:false})),tasks:[t1,t2,t3]};
const old1=a.list.children[0],old2=a.list.children[1],old3=b.list.children[0];
let renders=0,made=[],tags=0,storage=0,counts=0;
const context={state,currentView:'kanban',searchQuery:'',sortMode:'manual',
  filterTag:'',filterPriority:'',filterDeadline:'',drag:null,
  PRIORITY_ORDER:{high:3,medium:2,low:1,none:0},dayDiff:()=>0,
  document:{createElement:()=>item()},
  $:sel=>{assert.equal(sel,'#board');return board;},
  updateTagFilter:()=>tags++,updateStorageInfo:()=>storage++,
  createTaskCard:(t,col)=>{assert.equal(t.columnId,col.id);made.push(t.id);return item(t.id);},
  countVisibleDescendants:(tasks,roots)=>{counts++;return new Map(roots.map(x=>[x.id,0]));},
  renderBoard:()=>renders++};
vm.createContext(context);
vm.runInContext(core.slice(coreStart,coreEnd)+'\n'+views.slice(start,end)+'\nthis.filter=renderFilteredBoard;',context);
const ids=l=>l.children.map(el=>el.dataset?.taskId||'hint');
context.filterTag='red';
context.filter();
assert.deepEqual(ids(a.list),['t1']);assert.deepEqual(ids(b.list),['t3']);
assert.equal(a.list.children[0],old1);assert.equal(b.list.children[0],old3);
assert.equal(renders,0);assert.equal(made.length,0,'matched cards reused');
assert.equal(a.count.textContent,'2/2','WIP count remains unfiltered');
assert.equal(a.header.classList.contains('wip-warning'),true);
context.filterTag='';context.searchQuery='bravo';context.filter();
assert.deepEqual(ids(a.list),['t2']);assert.deepEqual(ids(b.list),['hint']);
assert.equal(b.list.children[0].textContent,'Ничего не найдено');
assert.equal(a.list.children[0].dataset.taskId,'t2');
assert.equal(made.filter(id=>id==='t2').length,1);
assert.equal(a.list.scrollTop,42);assert.equal(board.scrollLeft,93);
context.searchQuery='';context.sortMode='title';context.filter();
assert.deepEqual(ids(a.list),['t1','t2']);
const first=a.list.children[0], second=a.list.children[1];
context.sortMode='created_desc';context.filter();
assert.deepEqual(ids(a.list),['t2','t1']);
assert.equal(a.list.children[0],second,'sort reuses card nodes');
assert.equal(a.list.children[1],first,'sort does not re-create media');
context.sortMode='manual';context.filterPriority='high';context.filter();
assert.deepEqual(ids(a.list),['t1']);assert.deepEqual(ids(b.list),['hint']);
context.filterPriority='';context.filterDeadline='today';context.filter();
assert.deepEqual(ids(a.list),['hint'],'tasks without deadlines filtered');
assert.equal(a.list.children[0].textContent,'Ничего не найдено');
context.filterDeadline='';context.filter();
assert.deepEqual(ids(a.list),['t1','t2']);assert.deepEqual(ids(b.list),['t3']);
assert.deepEqual(ids(empty.list),['hint']);
assert.equal(empty.list.children[0].textContent,'Нет задач');
t2.results=[{text:'Итог эксперимента 123'}];
t3.files=[{name:'protocol.pdf',resultId:'r1'}];
context.searchQuery='ЭКСПЕРИМЕНТА';context.filter();
assert.deepEqual(ids(a.list),['t2']);assert.deepEqual(ids(b.list),['hint']);
context.searchQuery='protocol.pdf';context.filter();
assert.deepEqual(ids(a.list),['hint']);assert.deepEqual(ids(b.list),['t3']);
context.searchQuery='';context.filter();
assert.ok(tags>=6&&storage>=6);assert.ok(counts>0);
assert.equal(renders,0,'filter changes never recreate board');
function fallback(callback){
  const n=renders;callback();context.filter();assert.equal(renders,n+1);
}
fallback(()=>{context.currentView='dashboard';});
context.currentView='kanban';
fallback(()=>{board.dataset.boardId='wrong';});
board.dataset.boardId='b';
fallback(()=>{a.list.appendChild(item('missing'));});
assert.match(interactions,/searchQuery = e\.target\.value\.trim\(\); renderFilteredBoard\(\)/);
for(const name of ['filterTag','filterPriority','filterDeadline','sortMode']) {
  assert.ok(interactions.includes(name+" = e.target.value; saveUIState(); renderFilteredBoard();"),name);
}
console.log('P16.4 incremental search, filters, sort, empty state, WIP, focus and fallbacks passed');

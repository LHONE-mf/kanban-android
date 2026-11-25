// P16.3: exercise actual targeted column reconciliation with a small DOM mock.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/src/main/js-src/views.js','utf8');
const start=source.indexOf('function renderMovedTaskColumns(');
const end=source.indexOf('\nfunction createTaskCard(',start);
assert.ok(start>=0&&end>start);
function classes(...values){
  const s=new Set(values);
  return {contains:v=>s.has(v),add:v=>s.add(v),remove:v=>s.delete(v),
    toggle:(v,on)=>on?s.add(v):s.delete(v)};
}
function listNode(id){
  const list={dataset:{columnId:id},children:[],scrollTop:75,classList:classes('task-list','drag-over'),
    appendChild(el){return this.insertBefore(el,null);},
    insertBefore(el,next){
      if(el.parentElement){const arr=el.parentElement.children;const ix=arr.indexOf(el);if(ix>=0)arr.splice(ix,1);}
      const i=next?this.children.indexOf(next):this.children.length;
      assert.ok(i>=0);this.children.splice(i,0,el);el.parentElement=this;return el;
    }};
  return list;
}
function card(id){
  return {dataset:{taskId:id},classList:classes('task-card'),parentElement:null,
    contains(el){return el===this;},focus(opts){this.focused=opts;},
    get nextElementSibling(){
      if(!this.parentElement)return null;
      const arr=this.parentElement.children;return arr[arr.indexOf(this)+1]||null;
    },
    remove(){const arr=this.parentElement.children;arr.splice(arr.indexOf(this),1);this.parentElement=null;},
    replaceWith(node){const p=this.parentElement,i=p.children.indexOf(this);p.children[i]=node;node.parentElement=p;this.parentElement=null;}};
}
function placeholder(){return {classList:classes('empty-hint'),parentElement:null,
  remove(){const a=this.parentElement.children;a.splice(a.indexOf(this),1);this.parentElement=null;}};}
function column(id,taskIds,wipLimit){
  const list=listNode(id), count={textContent:''},header={classList:classes('column-header'),
    querySelector:sel=>sel==='.column-count'?count:null},
    node={dataset:{columnId:id},querySelector:sel=>sel==='.task-list'?list:sel==='.column-header'?header:null};
  taskIds.forEach(name=>list.appendChild(card(name)));
  if(!taskIds.length)list.appendChild(placeholder());
  return {id,node,list,count,header,wipLimit};
}
const a=column('a',['t1','t2'],2),b=column('b',['t3'],1),c=column('c',['t4'],0);
const board={dataset:{boardId:'test'},children:[a.node,b.node,c.node],scrollLeft:120};
const task=(id,columnId,order,parentId='')=>({id,boardId:'test',columnId,order,parentId});
const t1=task('t1','a',0),t2=task('t2','a',1),t3=task('t3','b',0),t4=task('t4','c',0),child=task('child','a',0,'t1');
const state={activeBoardId:'test',columns:[a,b,c].map(col=>({id:col.id,wipLimit:col.wipLimit})),tasks:[t1,t2,t3,t4,child]};
let full=0,tags=0,storage=0,made=[];
const context={state,currentView:'kanban',searchQuery:'',filterTag:'',filterPriority:'',filterDeadline:'',
  document:{activeElement:null,createElement(){const p=placeholder();p.textContent='';p.className='empty-hint';return p;}},
  $:sel=>{assert.equal(sel,'#board');return board;},
  getVisibleTasks:()=>state.tasks.filter(t=>!t.parentId),
  sortTasks:ts=>[...ts].sort((x,y)=>x.order-y.order),
  createTaskCard:(t,col)=>{assert.equal(t.columnId,col.id);made.push(t.id);return card(t.id);},
  renderBoard:()=>{full++;},updateTagFilter:()=>{tags++;},updateStorageInfo:()=>{storage++;}};
vm.createContext(context);
vm.runInContext(source.slice(start,end)+'\nthis.reconcile=renderMovedTaskColumns;',context);
const ids=list=>list.children.map(x=>x.dataset?.taskId||'empty');
const original2=a.list.children[1],original3=b.list.children[0],original4=c.list.children[0];
const scroll=a.list.scrollTop, boardScroll=board.scrollLeft;
// Move t1 from a to b by quick action; only t1 card should be rebuilt.
state.tasks[0]={...t1,columnId:'b',order:-1};
context.document.activeElement=a.list.children[0];
context.reconcile(['a','b'],['t1']);
assert.deepEqual(ids(a.list),['t2']);
assert.deepEqual(ids(b.list),['t1','t3']);
assert.equal(b.list.children[1],original3,'unrelated target card stays same');
assert.equal(a.list.children[0],original2,'unrelated source card stays same');
assert.equal(c.list.children[0],original4,'untouched column stays same');
assert.equal(made.length,1);assert.equal(made[0],'t1');
assert.equal(b.list.children[0].focused.preventScroll,true,'keyboard focus restored');
assert.equal(a.count.textContent,'1/2');assert.equal(b.count.textContent,'2/1');
assert.equal(b.header.classList.contains('wip-exceeded'),true);
assert.equal(a.list.scrollTop,scroll);assert.equal(board.scrollLeft,boardScroll);
assert.equal(full,0);
assert.equal(a.list.classList.contains('drag-over'),false,'source highlight cleared');
assert.equal(b.list.classList.contains('drag-over'),false,'target highlight cleared');
// Cancelled tablet drag after DOM reparenting must restore original state/order.
state.tasks[0]=t1;
const dragged=b.list.children[0];a.list.insertBefore(dragged,null);
context.reconcile(['a','b']);
assert.deepEqual(ids(a.list),['t1','t2']);
assert.deepEqual(ids(b.list),['t3']);
assert.equal(a.list.children[0],dragged,'cancel reuses existing card DOM');
assert.equal(full,0);
// Same-column reorder reuses all card elements; no new card creation.
const oldT1=a.list.children[0],oldT2=a.list.children[1];
state.tasks[0]={...t1,order:5};
context.reconcile(['a']);
assert.deepEqual(ids(a.list),['t2','t1']);
assert.equal(a.list.children[0],oldT2);assert.equal(a.list.children[1],oldT1);
assert.equal(made.length,1);
// If a column empties, maintain one placeholder without rebuilding board.
state.tasks[0]={...t1,columnId:'b',order:0};
state.tasks[1]={...t2,columnId:'b',order:1};
context.reconcile(['a','b'],['t1','t2']);
assert.deepEqual(ids(a.list),['empty']);assert.equal(a.list.children[0].textContent,'Нет задач');
assert.equal(a.count.textContent,'0/2');assert.equal(full,0);
const fallback=(change,ids=['a','b'])=>{const n=full;change();context.reconcile(ids);assert.equal(full,n+1);};
fallback(()=>{context.filterTag='urgent';});
context.filterTag='';
fallback(()=>{board.dataset.boardId='other';});
board.dataset.boardId='test';
fallback(()=>{a.list.appendChild(card('stale'));});
assert.ok(tags>=4 && storage>=4);
assert.match(fs.readFileSync('app/src/main/js-src/interactions.js','utf8'),/renderMovedTaskColumns\(touched,/);
assert.match(fs.readFileSync('app/src/main/js-src/tasks.js','utf8'),/renderMovedTaskColumns\(\[existing\.columnId, candidate\.columnId\]/);
console.log('P16.3 touched-column move, drag cancellation, WIP, focus and stale-DOM fallbacks passed');

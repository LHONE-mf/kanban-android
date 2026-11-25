// P17.2: renderBoard groups columns in one scan while preserving counts/empty states.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const views=fs.readFileSync('app/src/main/js-src/views.js','utf8');
const start=views.indexOf('function renderBoard()');
const end=views.indexOf('\nfunction renderFilteredBoard(',start);
assert.ok(start>=0&&end>start);
function el(){
  const node={dataset:{},className:'',children:[],scrollLeft:0,scrollTop:0,
    appendChild(child){this.children.push(child);child.parentElement=this;return child;}};
  let html='';
  Object.defineProperty(node,'innerHTML',{get(){return html;},set(v){html=String(v);this.children=[];}});
  return node;
}
const board=el();board.dataset.boardId='board';board.scrollLeft=84;
const cols=[
  {id:'todo',title:'To Do',wipLimit:1,color:'#888'},
  {id:'doing',title:'Doing',wipLimit:1,color:'#777'},
  {id:'done',title:'Done',wipLimit:0,color:'#666'}];
const tasks=[
  {id:'a',parentId:'',columnId:'todo'},
  {id:'b',parentId:'',columnId:'todo'},
  {id:'child',parentId:'a',columnId:'todo'},
  {id:'c',parentId:'',columnId:'doing'},
  {id:'orphan',parentId:'missing',columnId:'done'}];
tasks.filter=()=>{throw Error('Repeated state.tasks.filter() scans must not be used');};
const state={activeBoardId:'board',columns:cols,tasks};
for(const col of cols){
  const node=el(),list=el();
  node.dataset.columnId=col.id;list.className='task-list';list.dataset.columnId=col.id;
  list.scrollTop=col.id==='todo'?47:col.id==='doing'?19:0;
  node.appendChild(list);board.appendChild(node);
}
const listFor=col=>col.children.find(x=>x.className==='task-list');
const oldLists=board.children.map(listFor);
const recorded={sort:[],cards:[],descendants:0,tags:0,storage:0};
const ctx={state,currentView:'kanban',escapeHtml:v=>String(v),
  $:selector=>{assert.equal(selector,'#board');return board;},
  $$:(selector,node)=>{
    assert.equal(selector,'.task-list');assert.equal(node,board);
    return node.children.map(listFor).filter(Boolean);
  },
  document:{createElement:el},
  getVisibleTasks:()=>[tasks[0],tasks[3]], // one visible root in each of first two columns
  countVisibleDescendants:(items,roots)=>{
    recorded.descendants++;
    assert.equal(items,tasks);
    assert.equal(roots.length,2);
    return new Map([['a',1],['c',0]]);
  },
  sortTasks:items=>{recorded.sort.push(Array.from(items,x=>x.id));return items;},
  createTaskCard:(task,col,counts)=>{
    recorded.cards.push({id:task.id,col:col.id,descendants:counts.get(task.id)});
    const card=el();card.className='task-card';card.dataset.taskId=task.id;return card;
  },
  updateTagFilter:()=>recorded.tags++,
  updateStorageInfo:()=>recorded.storage++
};
vm.createContext(ctx);
vm.runInContext(views.slice(start,end)+'\nthis.render=renderBoard;',ctx);
ctx.render();
assert.equal(board.children.length,3,'all columns remain');
const [a,b,c]=board.children;
assert.deepEqual(recorded.sort,[['a'],['c'],[]],'visible buckets sent to respective columns');
assert.deepEqual(recorded.cards,[{id:'a',col:'todo',descendants:1},{id:'c',col:'doing',descendants:0}]);
assert.match(a.children[0].innerHTML,/column-count">2\/1/,'WIP count includes hidden roots');
assert.match(a.children[0].className,/wip-exceeded/);
assert.match(b.children[0].innerHTML,/column-count">1\/1/);
assert.match(b.children[0].className,/wip-warning/);
assert.equal(c.children[1].children[0].textContent,'Нет задач','orphan does not make top-level count');
assert.equal(board.scrollLeft,84);
assert.equal(listFor(a).scrollTop,47);
assert.equal(listFor(b).scrollTop,19);
assert.equal(recorded.descendants,1);
assert.equal(recorded.tags,1);assert.equal(recorded.storage,1);
console.log('P17.2 single-pass columns: hidden roots, WIP, empty states and scroll passed.');

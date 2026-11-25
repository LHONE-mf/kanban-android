'use strict';
/* P17.1 Node performance baseline. Synthetic DOM, no real application data. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const os=require('node:os');
const getFile=name=>fs.readFileSync(path.join(__dirname,'../app/src/main/js-src',name),'utf8');
const core=getFile('core.js'),views=getFile('views.js'),interactions=getFile('interactions.js');
function extract(text,begin,end){
  const a=text.indexOf(begin),b=text.indexOf(end,a+begin.length);
  assert.ok(a>=0&&b>a,'Missing source function '+begin);
  return text.slice(a,b);
}
const functions=[
  extract(core,'function getVisibleTasks()','function getAllTags()'),
  extract(views,'function countVisibleDescendants(','function renderFilteredBoard('),
  extract(interactions,'function getAfterElement(','function getDropListAt(')
].join('\n');
const subtree=core.split('\n').find(line=>line.startsWith('function subtree(id)'));
assert.ok(subtree,'Missing subtree implementation');
function element(){
  const el={className:'',dataset:{},children:[],scrollTop:0,scrollLeft:0,
    appendChild(child){this.children.push(child);child.parentElement=this;return child;}};
  let html='';
  Object.defineProperty(el,'innerHTML',{get(){return html;},set(value){html=String(value);el.children=[];}});
  return el;
}
function setup(size){
  const columns=Array.from({length:8},(_,i)=>({
    id:'column-'+i,title:'Column '+i,color:'#777',wipLimit:0,isDone:i===7
  }));
  const tasks=Array.from({length:size},(_,i)=>{
    const parentId=i>5&&i%17===0?'task-5':i>1&&i%5===0?'task-1':'';
    return {
      id:'task-'+i,boardId:'bench',columnId:parentId?'column-1':'column-'+i%8,parentId,
      title:'Task '+i+' review',desc:'Production checklist for batch '+i%31,
      tags:['team-'+i%7],priority:['none','low','medium','high'][i%4],
      deadline:i%3===0?'2026-11-26':'',files:[],
      checklist:[{text:'Check '+i,checked:false}],order:i,createdAt:i,updatedAt:i
    };
  });
  const state={columns,tasks,activeBoardId:'bench'},board=element();
  const dragCards=tasks.filter(t=>!t.parentId&&t.columnId==='column-1')
    .map((t,index)=>({getBoundingClientRect(){return{top:index*56,height:56};}}));
  const dragList={querySelectorAll(sel){
    assert.equal(sel,'.task-card:not(.dragging)');
    return dragCards;
  }};
  const ctx={
    state,currentView:'kanban',searchQuery:'',filterTag:'',filterPriority:'',
    filterDeadline:'',sortMode:'manual',
    PRIORITY_ORDER:{none:0,low:1,medium:2,high:3},
    dayDiff:date=>date==='2026-11-26'?1:20,escapeHtml:v=>String(v),
    $:s=>{assert.equal(s,'#board');return board;},
    $$:(s,root)=>{
      assert.equal(s,'.task-list');assert.equal(root,board);
      return root.children.flatMap(c=>c.children.filter(el=>el.className==='task-list'));
    },
    document:{createElement:element},
    createTaskCard:task=>{const el=element();el.className='task-card';el.dataset.taskId=task.id;return el;},
    updateTagFilter(){},updateStorageInfo(){},
    renderDashboard(){throw Error('Unexpected dashboard view');},
    renderCalendar(){throw Error('Unexpected calendar view');},
    renderMindmap(){throw Error('Unexpected mindmap view');}
  };
  vm.createContext(ctx);
  vm.runInContext(functions+'\n'+subtree+
    '\nthis.ops={renderBoard,getVisibleTasks,sortTasks,subtree,countVisibleDescendants,getAfterElement};',ctx);
  const roots=tasks.filter(t=>!t.parentId);
  assert.equal(ctx.ops.getVisibleTasks().length,roots.length);
  assert.ok(ctx.ops.subtree('task-1').length>0);
  assert.equal(ctx.ops.countVisibleDescendants(tasks,roots).size,roots.length);
  assert.ok(dragCards.length>0);
  return{ctx,state,board,dragList,dragCards,roots,ops:ctx.ops};
}
function quantile(values,p){
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];
}
function time(fn,check){
  for(let i=0;i<4;i++)fn();
  if(check)return{medianMs:null,p95Ms:null};
  const start=performance.now();fn();
  const estimate=Math.max(.05,performance.now()-start);
  const repetitions=Math.max(1,Math.min(120,Math.ceil(20/estimate)));
  const samples=[];
  for(let i=0;i<7;i++){
    const t=performance.now();
    for(let n=0;n<repetitions;n++)fn();
    samples.push((performance.now()-t)/repetitions);
  }
  return{medianMs:+quantile(samples,.5).toFixed(3),p95Ms:+quantile(samples,.95).toFixed(3)};
}
function run(size,check){
  const {ctx,state,board,dragList,dragCards,roots,ops}=setup(size);
  const results={};
  results.full_board_scaffold=time(()=>ops.renderBoard(),check);
  assert.equal(board.children.length,8);
  const rendered=board.children.reduce((total,col)=>{
    const list=col.children.find(el=>el.className==='task-list');
    assert.ok(list);return total+list.children.filter(el=>el.className==='task-card').length;
  },0);
  assert.equal(rendered,roots.length,'One DOM card per root');
  ctx.searchQuery='task 1';
  results.search_text=time(()=>ops.getVisibleTasks(),check);
  ctx.searchQuery='';
  ctx.filterPriority='high';ctx.filterDeadline='week';
  results.filter_priority_deadline=time(()=>ops.getVisibleTasks(),check);
  ctx.filterPriority='';ctx.filterDeadline='';
  ctx.sortMode='title';
  results.sort_by_title=time(()=>ops.sortTasks(roots),check);
  ctx.sortMode='manual';
  results.descendant_counts=time(()=>ops.countVisibleDescendants(state.tasks,roots),check);
  results.subtree=time(()=>ops.subtree('task-1'),check);
  results.drag_hit_test=time(()=>ops.getAfterElement(dragList,500),check);
  return{size,rootCount:roots.length,dragCards:dragCards.length,results};
}
const check=process.argv.includes('--check'),json=process.argv.includes('--json');
const records=(check?[100]:[100,500,1000,3000]).map(size=>run(size,check));
if(json){
  console.log(JSON.stringify({type:'P17.1 synthetic Node baseline',
    node:process.version,platform:process.platform,architecture:os.arch(),
    caveat:'Synthetic DOM; no real WebView, HTML rendering, media, GPU or IndexedDB',
    records},null,2));
}else if(check){
  console.log('P17.1 checks passed (100 tasks, 7 scenarios)');
}else{
  console.log('P17.1 baseline: '+process.version+' / synthetic DOM / median ms per operation');
  console.log('tasks\troots\trender scaffold\tsearch\tfilter\tsort\tdescendants\tsubtree\tdrag');
  for(const x of records){
    const d=x.results;
    console.log([x.size,x.rootCount,d.full_board_scaffold.medianMs,d.search_text.medianMs,
      d.filter_priority_deadline.medianMs,d.sort_by_title.medianMs,
      d.descendant_counts.medianMs,d.subtree.medianMs,d.drag_hit_test.medianMs].join('\t'));
  }
  console.log('Median of seven runs; not Android frame times.');
}

// Step 06: exercise the actual pointer handlers with a minimal, dependency-free DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/interactions.js', 'utf8');
const begin = source.indexOf('function setupDragAndDrop() {');
const end = source.indexOf('// ============================================================\n// EVENT BINDINGS', begin);
assert.ok(begin >= 0 && end > begin);

function scenario() {
  const timers = [];
  const writes = [];
  let renders = 0;
  let prevented = 0;
  const makeClassList = (...initial) => {
    const names = new Set(initial);
    return {
      add: name => names.add(name),
      remove: name => names.delete(name),
      contains: name => names.has(name)
    };
  };
  const card = {dataset:{taskId:'task1'},classList:makeClassList('task-card'),parentElement:null};
  const list = id => ({
    dataset: {columnId:id}, children:[], classList:makeClassList('task-list'),
    get lastElementChild() {return this.children.at(-1) || null;},
    querySelectorAll(sel) {
      if (sel === '.task-card:not(.dragging)') {
        return this.children.filter(el => !el.classList.contains('dragging'));
      }
      return this.children;
    },
    getBoundingClientRect(){return{top:0,bottom:500};},
    appendChild(el) {
      if(el.parentElement) el.parentElement.children=el.parentElement.children.filter(x=>x!==el);
      this.children.push(el); el.parentElement=this;
    },
    insertBefore(el,other) {
      if(el.parentElement) el.parentElement.children=el.parentElement.children.filter(x=>x!==el);
      const index=this.children.indexOf(other);
      this.children.splice(index,0,el);el.parentElement=this;
    }
  });
  const first=list('col_a'),second=list('col_b');
  first.appendChild(card);
  const board = {
    classList:makeClassList('board'),scrollLeft:0,scrollWidth:500,clientWidth:500,
    getBoundingClientRect(){return{left:0,right:500,top:0,bottom:500};},
    addEventListener(){}
  };
  const target = (x,y) => {
    if(x<0||x>500||y<0||y>500)return null;
    const inList=x<250?first:second;
    return {closest:selector=>selector==='.task-list'?inList:null};
  };
  const document={
    body:{style:{userSelect:''}},
    elementFromPoint:target,
    addEventListener(){},removeEventListener(){}
  };
  const window={addEventListener(){},removeEventListener(){}};
  const t={id:'task1',columnId:'col_a',order:0};
  const sandbox={
    drag:null,autoScrollInterval:null,autoScrollDir:{x:0,y:0},
    lastPointer:{x:0,y:0},lastDragEndTime:0,
    window,document,navigator:{},state:{tasks:[t]},
    isDragAllowed:()=>true,
    $:sel=>{assert.equal(sel,'#board');return board;},
    $$:(sel,root)=>sel==='.task-card'?root.children:
      sel==='.task-list.drag-over'?[first,second].filter(el=>el.classList.contains('drag-over')):[],
    setTimeout:fn=>{const id={fn,cancelled:false};timers.push(id);return id;},
    clearTimeout:id=>{if(id)id.cancelled=true;},
    setInterval:()=>{throw Error('unexpected auto-scroll');},
    clearInterval(){},
    applyColumnChange:(task,colId)=>({...task,columnId:colId}),
    dbPutTasks:async candidates=>{writes.push(candidates.map(x=>({...x})));},
    syncKids:async()=>{},notifyOtherTabs(){},
    renderBoard:()=>{renders++;},
    showToast:msg=>{throw Error(msg);}
  };
  vm.runInNewContext(source.slice(begin,end),sandbox);
  const down = (pointerId=1) => sandbox.onPointerDown({
    button:0,pointerId,pointerType:'touch',clientX:110,clientY:150,
    target:{closest:selector=>selector==='.task-card'?card:null}
  });
  const move = (x,y,pointerId=1)=>sandbox.onPointerMove({
    pointerId,clientX:x,clientY:y,cancelable:true,preventDefault(){prevented++;}
  });
  const activate = ()=>{const timer=timers.at(-1);assert.ok(timer&&!timer.cancelled);timer.fn();};
  const up = async(x,y,pointerId=1)=>sandbox.onPointerUp({pointerId,clientX:x,clientY:y});
  const cancel = pointerId=>sandbox.onPointerCancel({pointerId});
  return {sandbox,board,card,first,second,writes,down,move,activate,up,cancel,
    get renders(){return renders;},get prevented(){return prevented;},timers};
}

(async()=>{
  let s=scenario();
  s.down();
  s.move(140,175); // finger moves before the 300 ms long-press: native scroll
  assert.equal(s.sandbox.drag,null,'native scroll cancels pending drag');
  assert.equal(s.prevented,0,'ordinary touch pan must not be prevented');
  assert.equal(s.writes.length,0);
  assert.equal(s.renders,0,'native scrolling must not trigger a rerender');

  s=scenario();
  s.down();s.down(2);
  assert.equal(s.sandbox.drag.pointerId,1,'second finger must not replace active pointer');
  s.activate();s.move(370,150);
  assert.equal(s.card.parentElement,s.second,'long press can move card across columns');
  s.cancel(2);
  assert.ok(s.sandbox.drag?.active,'unrelated pointercancel must not cancel the drag');
  s.cancel(1);
  assert.equal(s.sandbox.drag,null);
  assert.equal(s.renders,1,'cancelled active drag rerenders original order');
  assert.equal(s.writes.length,0,'cancelled drag must never write to storage');

  s=scenario();
  s.down();s.activate();s.move(370,150);
  await s.up(650,150); // released outside the board after hovering over col_b
  assert.equal(s.writes.length,0,'dropping outside board must not commit a prior hover');
  assert.equal(s.renders,1,'invalid drop restores the actual stored order');

  s=scenario();
  s.down();s.activate();s.move(370,150);
  await s.up(370,150);
  assert.equal(s.writes.length,1,'valid cross-column drop persists');
  assert.equal(s.writes[0].length,1);
  assert.equal(s.writes[0][0].columnId,'col_b');
  assert.equal(s.sandbox.state.tasks[0].columnId,'col_b');
  assert.equal(s.renders,1);

  s=scenario();
  s.down();await s.up(110,150);
  assert.equal(s.writes.length,0,'a simple tap never changes task order');
  assert.equal(s.renders,0);

  const css=fs.readFileSync('app/src/main/assets/kanban.css','utf8');
  assert.match(css,/\.board\s*\{[^}]*overflow-x:\s*auto;\s*overflow-y:\s*hidden/s);
  assert.match(css,/\.task-list\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css,/\.task-card\s*\{[^}]*touch-action:\s*manipulation/s);
  console.log('Touch pan, long-press drag, cross-column drop, cancellation and storage guards passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

// Step 06: exercise the actual pointer handlers with a minimal, dependency-free DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/interactions.js', 'utf8');
const begin = source.indexOf('function setupDragAndDrop() {');
const end = source.indexOf('// ============================================================\n// EVENT BINDINGS', begin);
assert.ok(begin >= 0 && end > begin);

function scenario({withDescendants = false, failWrite = false, allowScroll = false} = {}) {
  const timers = [];
  const frames = new Map(), intervals = new Map();
  let nextFrame = 0, nextInterval = 0;
  const writes = [];
  const toasts = [];
  const hover = {adds:0, removes:0, hits:0};
  let renders = 0, partialMoves = [];
  let prevented = 0, downPrevented = 0, captured = null;
  const makeClassList = (...initial) => {
    const names = new Set(initial);
    return {
      add: name => {if(name==='drag-over')hover.adds++;names.add(name);},
      remove: name => {if(name==='drag-over')hover.removes++;names.delete(name);},
      contains: name => names.has(name)
    };
  };
  const card = {dataset:{taskId:'task1'},classList:makeClassList('task-card'),parentElement:null};
  const list = id => ({
    dataset: {columnId:id}, children:[], classList:makeClassList('task-list'),
    scrollTop:0, scrollHeight:allowScroll?1000:500, clientHeight:500,
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
    classList:makeClassList('board'),scrollLeft:0,scrollWidth:allowScroll?1000:500,clientWidth:500,
    getBoundingClientRect(){return{left:0,right:500,top:0,bottom:500};},
    setPointerCapture(id){captured=id;},
    addEventListener(){}
  };
  const target = (x,y) => {
    if(x<0||x>500||y<0||y>500)return null;
    const inList=x<250?first:second;
    return {closest:selector=>selector==='.task-list'?inList:null};
  };
  const document={
    body:{style:{userSelect:''}},
    elementFromPoint:(x,y)=>{hover.hits++;return target(x,y);},
    addEventListener(){},removeEventListener(){}
  };
  const window={addEventListener(){},removeEventListener(){}};
  const t={id:'task1',parentId:'',columnId:'col_a',order:0};
  const descendants = withDescendants ? [
    {id:'child',parentId:'task1',columnId:'col_a',order:0},
    {id:'grandchild',parentId:'child',columnId:'col_a',order:0},
    {id:'unrelated',parentId:'',columnId:'col_a',order:1}
  ] : [];
  const sandbox={
    drag:null,autoScrollInterval:null,autoScrollDir:{x:0,y:0},
    lastPointer:{x:0,y:0},lastDragEndTime:0,
    window,document,navigator:{},state:{tasks:[t,...descendants]},
    isDragAllowed:()=>true,
    $:sel=>{assert.equal(sel,'#board');return board;},
    $$:(sel,root)=>sel==='.task-card'?root.children:
      sel==='.task-list.drag-over'?[first,second].filter(el=>el.classList.contains('drag-over')):[],
    setTimeout:fn=>{const id={fn,cancelled:false};timers.push(id);return id;},
    clearTimeout:id=>{if(id)id.cancelled=true;},
    requestAnimationFrame:fn=>{const id=nextFrame++;frames.set(id,fn);return id;},
    cancelAnimationFrame:id=>frames.delete(id),
    setInterval:fn=>{
      if(!allowScroll)throw Error('unexpected auto-scroll');
      const id=++nextInterval;intervals.set(id,fn);return id;
    },
    clearInterval:id=>intervals.delete(id),
    applyColumnChange:(task,colId)=>({...task,columnId:colId}),
    dbPutTasks:async candidates=>{
      writes.push(candidates.map(x=>({...x})));
      if(failWrite) throw Error('disk full');
    },
    subtree:id=>{
      const children=[];
      const visit=parent=>{
        for(const task of sandbox.state.tasks) {
          if(task.parentId===parent){children.push(task);visit(task.id);}
        }
      };
      visit(id);
      return children;
    },
    notifyOtherTabs(){},
    renderBoard:()=>{renders++;},
    renderMovedTaskColumns:(ids,refresh=[])=>partialMoves.push({ids:Array.from(ids),refresh:Array.from(refresh)}),
    showToast:msg=>{toasts.push(msg);}
  };
  vm.runInNewContext(source.slice(begin,end),sandbox);
  const down = (pointerId=1, grip=false) => sandbox.onPointerDown({
    button:0,pointerId,pointerType:'touch',clientX:110,clientY:150,cancelable:true,
    preventDefault(){downPrevented++;},
    target:{closest:selector=>selector==='.task-card'?card:
      grip && (selector==='[data-drag-handle]' || selector.includes('button')) ? {dragGrip:true}:null}
  });
  const rawMove = (x,y,pointerId=1)=>sandbox.onPointerMove({
    pointerId,clientX:x,clientY:y,cancelable:true,preventDefault(){prevented++;}
  });
  const flush = ()=>{
    for(const [id,fn] of [...frames]){
      if(frames.delete(id))fn(16);
    }
  };
  const move = (...args)=>{rawMove(...args);flush();};
  const tick = ()=>{for(const fn of [...intervals.values()])fn();};
  const activate = ()=>{const timer=timers.at(-1);assert.ok(timer&&!timer.cancelled);timer.fn();};
  const up = async(x,y,pointerId=1)=>sandbox.onPointerUp({pointerId,clientX:x,clientY:y});
  const cancel = pointerId=>sandbox.onPointerCancel({pointerId});
  return {sandbox,board,card,first,second,writes,toasts,hover,down,move,rawMove,flush,tick,frames,intervals,activate,up,cancel,
    get renders(){return renders;},get partialMoves(){return partialMoves;},get prevented(){return prevented;},
    get downPrevented(){return downPrevented;},get captured(){return captured;},timers};
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
  assert.equal(s.renders,0,'cancelled drag must not rebuild entire board');
  assert.equal(s.partialMoves.length,1,'cancelled drag reconciles touched columns');
  assert.equal(s.writes.length,0,'cancelled drag must never write to storage');

  s=scenario();
  s.down();s.activate();s.move(370,150);
  await s.up(650,150); // released outside the board after hovering over col_b
  assert.equal(s.writes.length,0,'dropping outside board must not commit a prior hover');
  assert.equal(s.renders,0,'invalid drop does not rebuild entire board');
  assert.equal(s.partialMoves.length,1,'invalid drop reconciles the touched columns');

  s=scenario();
  s.down();s.activate();s.move(370,150);
  await s.up(370,150);
  assert.equal(s.writes.length,1,'valid cross-column drop persists');
  assert.equal(s.writes[0].length,1);
  assert.equal(s.writes[0][0].columnId,'col_b');
  assert.equal(s.sandbox.state.tasks[0].columnId,'col_b');
  assert.equal(s.renders,0);
  assert.equal(s.partialMoves.length,1);

  s=scenario({withDescendants:true});
  s.down();s.activate();s.move(370,150);
  await s.up(370,150);
  assert.equal(s.writes.length,1,'parent and descendants need one transaction');
  assert.deepEqual(Array.from(s.writes[0],t=>t.id).sort(),['child','grandchild','task1'],
    'the single transaction contains the parent and both descendants');
  assert.ok(s.sandbox.state.tasks.filter(t=>t.id!=='unrelated')
    .every(t=>t.columnId==='col_b'),'descendants follow the parent');
  assert.equal(s.sandbox.state.tasks.find(t=>t.id==='unrelated').columnId,'col_a');

  s=scenario({withDescendants:true,failWrite:true});
  s.down();s.activate();s.move(370,150);
  await s.up(370,150);
  assert.equal(s.writes.length,1,'failed move still uses only one transaction');
  assert.ok(s.sandbox.state.tasks.every(t=>t.columnId==='col_a'),
    'failed transaction leaves parent and children unchanged in memory');
  assert.ok(s.toasts.some(message=>message.includes('disk full')),
    'failed transaction reports an error');
  assert.equal(s.renders,0,'failed drop only reconciles touched columns');
  assert.equal(s.partialMoves.length,1);

  s=scenario({withDescendants:true});
  s.down();s.activate();s.move(370,150);s.cancel(1);
  assert.equal(s.writes.length,0,'cancelled parent drag must never write');
  assert.ok(s.sandbox.state.tasks.every(t=>t.columnId==='col_a'),
    'cancelled drag keeps descendants unchanged');

  s=scenario();
  s.down();await s.up(110,150);
  assert.equal(s.writes.length,0,'a simple tap never changes task order');
  assert.equal(s.renders,0);

  // Tablet scenario: touch-action:none on a dedicated grip makes horizontal
  // finger drag deterministic without disabling ordinary touch scrolling.
  s=scenario();
  s.down(1,true);
  assert.equal(s.sandbox.drag.fromGrip,true,'grip recognised even though it is a button');
  assert.equal(s.downPrevented,1,'grip prevents native touch gesture');
  assert.equal(s.captured,1,'stable board captures touch across DOM reparenting');
  assert.equal(s.timers.length,0,'grip does not wait for a long-press timer');
  s.move(112,152);
  assert.equal(s.sandbox.drag.active,false,'small movement is not an accidental drag');
  s.move(370,150);
  assert.equal(s.sandbox.drag.active,true,'grip starts drag on first substantial motion');
  await s.up(370,150);
  assert.equal(s.writes.length,1,'tablet grip drop persists movement');
  assert.equal(s.sandbox.state.tasks[0].columnId,'col_b');
  assert.equal(s.renders,0);
  assert.equal(s.partialMoves.length,1);

  s=scenario();
  s.down(1,true);
  await s.up(110,150);
  assert.equal(s.renders,0,'tapping the grip does not flash/rebuild the board');
  assert.equal(s.writes.length,0,'tapping the grip does not move or save');

  // P17.3: unchanged hover is read-only; activation and release hit-test once
  // for placement (activation also needs the independent auto-scroll hit-test).
  s=scenario();
  s.down(1,true);
  s.move(370,150);
  assert.equal(s.hover.hits,2,'one placement and one auto-scroll hit-test');
  assert.equal(s.hover.adds,1);
  for(let i=0;i<20;i++)s.move(370,150+i);
  assert.equal(s.hover.adds,1,'same-column hover never reapplies its class');
  assert.equal(s.hover.removes,0,'same-column hover never removes its class');
  s.move(110,150);
  assert.equal(s.hover.adds,2);
  assert.equal(s.hover.removes,1,'crossing a column clears the old highlight');
  assert.equal(s.first.classList.contains('drag-over'),true);
  assert.equal(s.second.classList.contains('drag-over'),false);
  const beforeRelease=s.hover.hits;
  await s.up(370,150);
  assert.equal(s.hover.hits-beforeRelease,1,'release uses a fresh single hit-test');
  assert.equal(s.writes[0][0].columnId,'col_b','release uses final coordinates, not previous hover');

  s=scenario();
  s.down();s.activate();s.move(370,150);s.move(650,150);
  assert.equal(s.second.classList.contains('drag-over'),false,'outside board removes hover');
  await s.up(650,150);
  assert.equal(s.writes.length,0,'outside board remains a cancelled drop');

  // Real hit-test must preserve strict midpoint, ties, variable card heights
  // and live geometry after scroll (no long-lived rectangle cache).
  const a={getBoundingClientRect:()=>({top:0,height:20})};
  let top=20;
  const b={getBoundingClientRect:()=>({top,height:80})};
  const c={getBoundingClientRect:()=>({top:100,height:20})};
  const container={querySelectorAll:()=>[a,b,c]};
  assert.equal(s.sandbox.getAfterElement(container,9),a);
  assert.equal(s.sandbox.getAfterElement(container,10),b);
  assert.equal(s.sandbox.getAfterElement(container,60),c);
  assert.equal(s.sandbox.getAfterElement(container,110),null);
  top=0;
  assert.equal(s.sandbox.getAfterElement(container,41),c,'changed geometry is read immediately');
  const tie={getBoundingClientRect:()=>({top:0,height:20})};
  assert.equal(s.sandbox.getAfterElement({querySelectorAll:()=>[a,tie]},0),a);
  assert.equal(s.sandbox.getAfterElement({querySelectorAll:()=>[]},0),null);

  // P17.4: bursts share a frame, use the latest pointer, and never save a hover.
  s=scenario();
  s.down();s.activate();
  const initialHits=s.hover.hits, initialPrevented=s.prevented;
  for(let i=0;i<20;i++)s.rawMove(i%2?370:110,150+i);
  assert.equal(s.frames.size,1,'one pending frame, including a valid frame ID of zero');
  assert.equal(s.hover.hits,initialHits,'no hit-tests during the event burst');
  assert.equal(s.prevented-initialPrevented,20,'preventDefault stays synchronous');
  s.flush();
  assert.equal(s.hover.hits-initialHits,2,'one placement and one scroll hit-test');
  assert.equal(s.card.parentElement,s.second,'latest pointer wins');
  assert.equal(s.writes.length,0);
  s.rawMove(110,150);
  const stale=[...s.frames.values()][0];
  await s.up(370,150);
  assert.equal(s.frames.size,0,'release cancels the pending frame');
  assert.equal(s.writes[0][0].columnId,'col_b','release uses its own coordinates');
  const releasedHits=s.hover.hits;
  stale(16);
  assert.equal(s.hover.hits,releasedHits,'obsolete callback cannot mutate the released drag');

  s=scenario();
  s.down();s.activate();s.rawMove(370,150);
  const oldFrame=[...s.frames.values()][0];
  s.cancel(2);
  assert.equal(s.frames.size,1,'unrelated cancellation leaves the frame alone');
  s.cancel(1);
  assert.equal(s.frames.size,0);
  assert.equal(s.writes.length,0);
  s.down();s.activate();s.rawMove(370,150);
  const nextHits=s.hover.hits;
  oldFrame(16);
  assert.equal(s.hover.hits,nextHits,'old callback cannot affect the next gesture');
  s.flush();
  assert.equal(s.card.parentElement,s.second);
  s.cancel(1);

  s=scenario({allowScroll:true});
  s.down(1,true);s.move(480,480);
  assert.equal(s.intervals.size,1,'edge gesture starts scrolling');
  s.tick();s.tick();s.rawMove(470,470);
  assert.equal(s.frames.size,1,'scroll ticks and pointer moves share a frame');
  s.flush();
  assert.equal(s.board.scrollLeft,6,'coalesced scroll advances once');
  assert.equal(s.second.scrollTop,6);
  s.tick();s.rawMove(370,150);s.flush();
  assert.equal(s.board.scrollLeft,6,'leaving the edge cancels stale scroll');
  assert.equal(s.second.scrollTop,6);
  assert.equal(s.intervals.size,0);
  s.move(480,480);s.tick();
  s.cancel(1);
  assert.equal(s.intervals.size,0,'cancel stops scrolling');
  assert.equal(s.frames.size,0,'cancel stops scroll frame');
  s.flush();
  assert.equal(s.writes.length,0);

  // P17.5: a large destination column must not scan the task array per card.
  s=scenario({withDescendants:true});
  const large = s.sandbox.state.tasks;
  for(let i=0;i<500;i++){
    const id='destination-'+i;
    large.push({id,parentId:'',columnId:'col_b',order:i+1});
    s.second.appendChild({
      dataset:{taskId:id},classList:{contains:()=>false},parentElement:null,
      getBoundingClientRect:()=>({top:0,height:20})
    });
  }
  for(let i=0;i<2496;i++)large.push({id:'other-'+i,parentId:'',columnId:'col_a',order:i+2});
  assert.equal(large.length,3000);
  large.find=()=>{throw Error('unexpected per-card find');};
  large.findIndex=()=>{throw Error('unexpected per-update findIndex');};
  const unrelated=large[3];
  s.down();s.activate();s.move(370,150);
  await s.up(370,150);
  assert.equal(s.writes.length,1);
  assert.equal(s.writes[0].length,503,'500 reordered cards, parent and two descendants');
  assert.equal(s.toasts.length,0);
  assert.equal(large[0].order,500);
  assert.ok(large.slice(0,3).every(t=>t.columnId==='col_b'));
  assert.equal(large[3],unrelated,'unrelated task identity preserved');
  assert.ok(large.slice(4,504).every((t,i)=>t.order===i));

  // The committed task is located again by ID after the asynchronous write.
  s=scenario({withDescendants:true});
  let finishWrite;
  const originalWrite=s.sandbox.dbPutTasks;
  s.sandbox.dbPutTasks=async updates=>{
    await originalWrite(updates);
    await new Promise(resolve=>{finishWrite=resolve;});
  };
  s.down();s.activate();s.move(370,150);
  const saving=s.up(370,150);
  await Promise.resolve();
  assert.equal(typeof finishWrite,'function');
  const before=s.sandbox.state.tasks;
  const replacement=[before[3],before[2],before[0]]; // child absent, other positions changed
  replacement.findIndex=()=>{throw Error('unexpected post-write findIndex');};
  s.sandbox.state.tasks=replacement;
  finishWrite();
  await saving;
  assert.equal(s.toasts.length,0);
  assert.equal(s.sandbox.state.tasks,replacement);
  assert.equal(replacement[0],before[3]);
  assert.equal(replacement[1].id,'grandchild');
  assert.equal(replacement[1].columnId,'col_b');
  assert.equal(replacement[2].id,'task1');
  assert.equal(replacement[2].columnId,'col_b');
  assert.equal(replacement.length,3,'missing tasks are not resurrected');

  // P17.6: compare the binary hit-test with the former exhaustive search
  // for ordered, unequal-height cards, subpixels, ties and changing geometry.
  let reads=0, scrollOffset=0, position=0;
  const geometry=Array.from({length:1000},(_,i)=>{
    const height=22+(i%19)*7.25;
    const top=position+(i%3)*2;
    position+=height+6;
    return {top,height};
  });
  const ordered=geometry.map(box=>({
    getBoundingClientRect(){
      reads++;
      return {top:box.top-scrollOffset,height:box.height};
    }
  }));
  const orderedList={querySelectorAll:()=>ordered};
  const reference=y=>{
    let closest=null, best=-Infinity;
    for(let i=0;i<geometry.length;i++){
      const box=geometry[i];
      const offset=y-(box.top-scrollOffset)-box.height/2;
      if(offset<0&&offset>best){best=offset;closest=ordered[i];}
    }
    return closest;
  };
  for(const scroll of [0,5678.25,position-500]){
    scrollOffset=scroll;
    const samples=[-100000,100000,0,150,499.5];
    for(const i of [0,1,17,499,500,998,999]){
      const middle=geometry[i].top-scrollOffset+geometry[i].height/2;
      samples.push(middle-0.125,middle,middle+0.125);
    }
    for(const y of samples){
      reads=0;
      assert.equal(s.sandbox.getAfterElement(orderedList,y),reference(y),
        'binary hit-test matches exhaustive reference');
      assert.ok(reads<=10,'1000 cards require at most ten rectangle reads');
    }
  }
  // Insert/remove/reorder the live card list: no stored rectangles or NodeList.
  const live=[ordered[0],ordered[1],ordered[2]];
  scrollOffset=0;
  const liveList={querySelectorAll:()=>live};
  assert.equal(s.sandbox.getAfterElement(liveList,0),ordered[0]);
  live.shift();
  assert.equal(s.sandbox.getAfterElement(liveList,0),ordered[1]);
  live.unshift(ordered[0]);
  assert.equal(s.sandbox.getAfterElement(liveList,0),ordered[0]);

  const views=fs.readFileSync('app/src/main/js-src/views.js','utf8');
  assert.match(views,/data-drag-handle="1"/,'drag grip exists on every card');
  assert.match(views,/dragHandle\.onkeydown/,'grip has keyboard move support');
  const css=fs.readFileSync('app/src/main/assets/kanban.css','utf8');
  assert.match(css,/\.task-drag-handle\s*\{[^}]*touch-action:\s*none/s,
    'grip takes ownership of tablet pointer gestures');
  assert.match(css,/\.board\s*\{[^}]*overflow-x:\s*auto;\s*overflow-y:\s*hidden/s);
  assert.match(css,/\.task-list\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css,/\.task-card\s*\{[^}]*touch-action:\s*manipulation/s);
  console.log('Touch pan, long-press drag, cross-column drop, cancellation and storage guards passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

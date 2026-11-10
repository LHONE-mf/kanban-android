// Cross-board search: relevance, nested tasks, Unicode, and exact-board navigation.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const views=fs.readFileSync('app/src/main/js-src/views.js','utf8');
const core=fs.readFileSync('app/src/main/js-src/core.js','utf8');
const html=fs.readFileSync('app/src/main/assets/kanban.html','utf8');
const interactions=fs.readFileSync('app/src/main/js-src/interactions.js','utf8');
const start=views.indexOf('// GLOBAL SEARCH');
const end=views.indexOf('// ============================================================\n// RENDER dispatcher',start);
assert(start>=0&&end>start,'Search functions must precede view rendering');
assert(core.includes("'search'"),'Search must be included in saved view options');
for(const id of ['globalSearch','globalSearchInput','globalMyDayBtn','globalSearchBoardFilter','globalSearchStatusFilter','globalSearchDeadlineFilter','globalSearchResults','globalSearchSummary','globalSearchEmpty'])
  assert(html.includes('id="'+id+'"'),'Missing cross-board UI element: '+id);
assert(html.includes('data-view="search"'),'Search tab must be accessible from mobile navigation');
assert(html.includes('id="globalSearchTab"'),'Search tab must have stable navigation identity for Android UI tests');
assert(views.includes("$('#globalSearch').hidden = view !== 'search'"),'Search view must be correctly toggled');
assert(interactions.includes("$('#globalSearchInput').addEventListener('input'"),'Search input must be live');
assert(interactions.includes("$('#globalSearchBoardFilter').addEventListener('change'"),'Board filter must refresh live');
assert(interactions.includes("$('#globalSearchStatusFilter').addEventListener('change'"),'Status filter must refresh live');
assert(interactions.includes("$('#globalSearchDeadlineFilter').addEventListener('change'"),'Deadline filter must refresh live');
assert(interactions.includes("$('#globalMyDayBtn').addEventListener('click', showGlobalMyDay)"),'My Day shortcut must be wired');
assert(!views.slice(start,end).includes('innerHTML = task.'),'Task data must not be inserted into HTML unsafely');

const a={id:'a',boardId:'b1',parentId:'',columnId:'done',title:'Проверка ячейки',desc:'Quality control',tags:['LFP'],checklist:[],deadline:'2026-11-08',updatedAt:1,priority:'high'};
const child={id:'nested',boardId:'b2',parentId:'root',title:'Find hidden thing',desc:'',tags:[],checklist:[{text:'Катод'}],deadline:'2026-11-10',updatedAt:3};
const root={id:'root',boardId:'b2',parentId:'',title:'Parent',desc:'',tags:[],checklist:[],deadline:'2026-11-09',updatedAt:2};
const b={id:'b',boardId:'b2',parentId:'',title:'Results',desc:'Testing electrode coating',tags:['Important'],checklist:[],deadline:'2026-11-14',updatedAt:4};
const weird={id:'unsafe',boardId:'b2',parentId:'',title:'<script>alert(1)</script>',desc:'',tags:[],checklist:[],updatedAt:5};
const state={boards:[
  {id:'b1',name:'Lab',columns:[{id:'todo',title:'To Do',isDone:false},{id:'done',title:'Done',isDone:true}]},
  {id:'b2',name:'Производство',columns:[{id:'doing',title:'В работе'}]}
],activeBoardId:'b1',_tasksByBoard:{b1:[a],b2:[root,child,b,weird]},tasks:[a]};
const entries=[],nodes=[];
function fakeNode(name='div'){
 const n={name,children:[],dataset:{},className:'',textContent:'',hidden:false,style:{},
  appendChild(c){this.children.push(c);return c},
  addEventListener(type,fn){this['on'+type]=fn},
  replaceChildren(...items){this.children=[...items]},
  setAttribute(k,v){this[k]=v}};
 nodes.push(n);return n;
}
const els=Object.fromEntries(['#globalSearchInput','#globalSearchBoardFilter','#globalSearchStatusFilter','#globalSearchDeadlineFilter','#globalSearchResults','#globalSearchSummary','#globalSearchEmpty']
 .map(key=>[key,fakeNode(key)]));
const nav=[],toasts=[];
let failSwitch=false;
const testDayDiff={'2026-11-08':-2,'2026-11-09':-1,'2026-11-10':0,'2026-11-14':4};
const ctx={state,Date,console,dayDiff:date=>testDayDiff[date],document:{createElement:tag=>fakeNode(tag)},
 $:sel=>els[sel],switchView:view=>nav.push(['view',view]),
 switchBoard:async id=>{if(failSwitch)throw Error('blocked');state.activeBoardId=id;state.tasks=state._tasksByBoard[id];nav.push(['board',id])},
 openTaskModal:id=>nav.push(['task',id]),showToast:s=>toasts.push(s)};
vm.createContext(ctx);
vm.runInContext(views.slice(start,end),ctx);
const find=(q,limit=100,filters={})=>ctx.searchAllBoards(q,limit,filters);

assert.equal(find(''),undefined,'Empty search should show guidance rather than all tasks');
assert.equal(find('    '),undefined);
assert.equal(find('',100,{status:'done'}).total,1,'Status-only filtering works');
assert.equal(find('',100,{boardId:'b2'}).total,4,'Board-only filtering works');
assert.equal(find('',100,{deadline:'overdue'}).total,1,'Overdue includes active overdue tasks, not completed ones');
assert.equal(find('',100,{deadline:'attention'}).total,2,'My day includes active overdue and due-today tasks');
assert.equal(find('',100,{deadline:'today'}).items[0].task.id,'nested','Due-today filter includes nested tasks');
assert.equal(find('',100,{deadline:'week'}).total,2,'Next seven days includes today through day six');
assert.equal(find('',100,{deadline:'attention'}).items.map(x=>x.task.id).join(','),'root,nested',
  'My Day lists the most overdue work before due-today work');
assert.equal(find('',100,{deadline:'week'}).items.map(x=>x.task.id).join(','),'nested,b',
  'Upcoming tasks are ordered by deadline, not last edit time');
assert.equal(find('',100,{deadline:'none'}).items[0].task.id,'unsafe','No deadline filter excludes dated tasks');
assert.equal(find('',100,{boardId:'b1',deadline:'overdue'}).total,0,'Completed task is not overdue');
assert.equal(find('',100,{boardId:'b2',status:'active',deadline:'overdue'}).total,1,'Board, status, and deadline compose');
assert.equal(find('electrode',100,{deadline:'overdue'}).total,0,'Text query still applies with deadline');
assert.equal(find('LFP',100,{status:'done'}).total,1,'Done uses each board done column');
assert.equal(find('LFP',100,{status:'active'}).total,0,'Done tasks are not active');
assert.equal(find('hidden',100,{status:'active'}).total,1,'Nested active tasks remain searchable');
assert.equal(find('hidden',100,{status:'done'}).total,0);
assert.equal(find('LFP',100,{boardId:'b2'}).total,0,'Board filter excludes other boards');
assert.equal(find('LFP',100,{boardId:'b1',status:'done'}).total,1,'Filters compose');
assert.equal(find('LFP').total,1,'Tags must be searchable');
assert.equal(find('electrode coating').total,1,'Multi-word matching must search descriptions');
assert.equal(find('катод').total,1,'Checklist inside nested task must be searchable');
assert.equal(find('провЕРКА').total,1,'Cyrillic search is case insensitive');
assert.equal(find('производство').total,4,'Board name should be searchable');
assert.equal(find('hidden').items[0].task.id,'nested','Nested tasks must appear in results');
assert.equal(find('find hidden').total,1,'AND tokens must be matched');
assert.equal(find('quality xyz').total,0);
assert.equal(find('Производство',2).items.length,2,'Search limit affects visible results, not total');
assert.equal(find('Производство',2).total,4);
assert.equal(find('script').items[0].task.id,'unsafe');
els['#globalSearchBoardFilter'].value='';
els['#globalSearchStatusFilter'].value='';
els['#globalSearchDeadlineFilter'].value='';
els['#globalSearchInput'].value='script';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchResults'].children.length,1);
assert.equal(els['#globalSearchResults'].children[0].children[0].textContent,'<script>alert(1)</script>',
  'User titles must render as text, not injected markup');
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 1');
els['#globalSearchBoardFilter'].value='b1';
els['#globalSearchStatusFilter'].value='done';
els['#globalSearchInput'].value='';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 1',
  'Filtered empty query updates the result count');
assert.equal(els['#globalSearchResults'].children[0].children[0].textContent,'Проверка ячейки');
assert.equal(els['#globalSearchBoardFilter'].value,'b1','Selected board survives rendering');
const optionsBefore = els['#globalSearchBoardFilter'].children;
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchBoardFilter'].children,optionsBefore,
  'Search typing must not recreate the Android board dropdown');
state.boards[0].name='Renamed board';
ctx.renderGlobalSearch();
assert.notEqual(els['#globalSearchBoardFilter'].children,optionsBefore,
  'Board rename must refresh search dropdown');
assert.equal(els['#globalSearchBoardFilter'].children[1].textContent,'Renamed board');
assert.equal(els['#globalSearchBoardFilter'].value,'b1','Board selection survives rename');
state.boards[0].name='Lab';

els['#globalSearchStatusFilter'].value='';
els['#globalSearchDeadlineFilter'].value='today';
els['#globalSearchBoardFilter'].value='b2';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 1','Deadline-only search updates results');
assert.equal(els['#globalSearchResults'].children[0].children[0].textContent,'Find hidden thing');
els['#globalSearchDeadlineFilter'].value='';
els['#globalSearchBoardFilter'].value='missing-board';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchBoardFilter'].value,'','Removed boards reset to all boards');
els['#globalSearchStatusFilter'].value='';
els['#globalSearchInput'].value='old query';
els['#globalSearchBoardFilter'].value='b1';
els['#globalSearchStatusFilter'].value='done';
els['#globalSearchDeadlineFilter'].value='none';
ctx.showGlobalMyDay();
assert.equal(els['#globalSearchInput'].value,'','My Day clears stale text');
assert.equal(els['#globalSearchBoardFilter'].value,'','My Day searches all boards');
assert.equal(els['#globalSearchStatusFilter'].value,'active','My Day excludes completed tasks');
assert.equal(els['#globalSearchDeadlineFilter'].value,'attention','My Day uses due and overdue tasks');
assert.deepEqual(nav.at(-1),['view','search'],'My Day navigates to search');
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 2','My Day finds work across boards');
els['#globalSearchStatusFilter'].value='';
els['#globalSearchDeadlineFilter'].value='';
const recurringCopy={...a,id:'a-repeat',title:'Repeat audit',repeatFrom:'a',updatedAt:8};
state._tasksByBoard.b1.push(recurringCopy);
els['#globalSearchInput'].value='Repeat audit';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchResults'].children.length,1);
assert.equal(els['#globalSearchResults'].children[0]['aria-label'],
  'Открыть: Repeat audit (повтор), доска Lab',
  'Search results should identify the next recurring occurrence distinctly for accessibility');
state._tasksByBoard.b1.pop();

const focusedFlow=fs.readFileSync('.maestro/recurring-search.yaml','utf8');
assert(focusedFlow.includes("id: '^Открыть: CI weekly recurring task"),
  'Focused Android test must tap the accessible search result, not invisible nested text');

els['#globalSearchInput'].value='not-found';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchEmpty'].hidden,false,'No-results guidance should display');

(async()=>{
 await ctx.openGlobalSearchResult('b2','nested');
 assert.deepEqual(nav.slice(-3),[['board','b2'],['view','kanban'],['task','nested']],
  'Selecting a nested result must change boards and open its exact task');
 const previous=nav.length;
 await ctx.openGlobalSearchResult('b2','deleted');
 assert.equal(nav.length,previous,'Deleted task must not navigate to a phantom');
 assert(toasts.some(s=>s.includes('не найдена')));
 failSwitch=true;
 await ctx.openGlobalSearchResult('b1','a');
 assert.equal(nav.length,previous,'Failed navigation must not open the wrong task');
 assert(toasts.some(s=>s.includes('blocked')));
 console.log('Global search: cross-board matches, nested tasks, Unicode, safety, limit, empty state and navigation passed');
})().catch(error=>{console.error(error);process.exitCode=1});

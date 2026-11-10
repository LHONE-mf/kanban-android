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
for(const id of ['globalSearch','globalSearchInput','globalMyDayBtn','globalSearchClearBtn','globalSearchBoardFilter','globalSearchStatusFilter','globalSearchDeadlineFilter','globalSearchPriorityFilter','globalSearchTagFilter','globalSearchResults','globalSearchMoreBtn','globalSearchSummary','globalSearchEmpty'])
  assert(html.includes('id="'+id+'"'),'Missing cross-board UI element: '+id);
assert(html.includes('data-view="search"'),'Search tab must be accessible from mobile navigation');
assert(html.includes('id="globalSearchTab"'),'Search tab must have stable navigation identity for Android UI tests');
assert(views.includes("$('#globalSearch').hidden = view !== 'search'"),'Search view must be correctly toggled');
assert(interactions.includes("$('#globalSearchInput').addEventListener('input'"),'Search input must be live');
assert(interactions.includes("$('#globalSearchBoardFilter').addEventListener('change'"),'Board filter must refresh live');
assert(interactions.includes("$('#globalSearchStatusFilter').addEventListener('change'"),'Status filter must refresh live');
assert(interactions.includes("$('#globalSearchDeadlineFilter').addEventListener('change'"),'Deadline filter must refresh live');
assert(interactions.includes("$('#globalSearchPriorityFilter').addEventListener('change'"),'Priority filter must refresh live');
assert(interactions.includes("$('#globalSearchTagFilter').addEventListener('change'"),'Tag filter must refresh live');
assert(interactions.includes("$('#globalMyDayBtn').addEventListener('click', showGlobalMyDay)"),'My Day shortcut must be wired');
assert(interactions.includes("$('#globalSearchClearBtn').addEventListener('click', clearGlobalSearch)"),
  'Clear-search button must reset search filters');
assert(interactions.includes("$('#globalSearchMoreBtn').addEventListener('click', loadMoreGlobalSearchResults)"),
  'Load-more button must be wired to an actual search action');
assert(html.includes('aria-controls="globalSearchResults"'),'Load-more button identifies its result list');
assert(!views.slice(start,end).includes('innerHTML = task.'),'Task data must not be inserted into HTML unsafely');

const a={id:'a',boardId:'b1',parentId:'',columnId:'done',title:'Проверка ячейки',desc:'Quality control',tags:['LFP'],checklist:[],deadline:'2026-11-08',updatedAt:1,priority:'high'};
const child={id:'nested',boardId:'b2',parentId:'root',title:'Find hidden thing',desc:'',tags:['lfp'],checklist:[{text:'Катод'}],deadline:'2026-11-10',updatedAt:3};
const root={id:'root',boardId:'b2',parentId:'',title:'Parent',desc:'',tags:[],checklist:[],deadline:'2026-11-09',updatedAt:2,priority:'medium'};
const b={id:'b',boardId:'b2',parentId:'',title:'Results',desc:'Testing electrode coating',tags:['Important'],checklist:[],deadline:'2026-11-14',updatedAt:4,priority:'high'};
const weird={id:'unsafe',boardId:'b2',parentId:'',title:'<script>alert(1)</script>',desc:'',tags:[],checklist:[],updatedAt:5};
const state={boards:[
  {id:'b1',name:'Lab',columns:[{id:'todo',title:'To Do',isDone:false},{id:'done',title:'Done',isDone:true}]},
  {id:'b2',name:'Производство',columns:[{id:'doing',title:'В работе'}]}
],activeBoardId:'b1',_tasksByBoard:{b1:[a],b2:[root,child,b,weird]},tasks:[a]};
const entries=[],nodes=[];
function fakeNode(name='div'){
 const n={name,value:'',children:[],dataset:{},className:'',textContent:'',hidden:false,style:{},
  appendChild(c){this.children.push(c);return c},
  addEventListener(type,fn){this['on'+type]=fn},
  replaceChildren(...items){this.children=[...items]},
  setAttribute(k,v){this[k]=v}};
 nodes.push(n);return n;
}
const els=Object.fromEntries(['#globalSearchInput','#globalSearchBoardFilter','#globalSearchStatusFilter','#globalSearchDeadlineFilter','#globalSearchPriorityFilter','#globalSearchTagFilter','#globalSearchClearBtn','#globalSearchMoreBtn','#globalSearchResults','#globalSearchSummary','#globalSearchEmpty']
 .map(key=>[key,fakeNode(key)]));
const nav=[],toasts=[];
let failSwitch=false;
const testDayDiff={'2026-11-08':-2,'2026-11-09':-1,'2026-11-10':0,'2026-11-14':4};
const ctx={state,Date,console,PRIORITY_LABELS:{high:'Высокий',medium:'Средний',low:'Низкий',none:'Без'},dayDiff:date=>testDayDiff[date],document:{createElement:tag=>fakeNode(tag)},
 $:sel=>els[sel],switchView:view=>nav.push(['view',view]),
 switchBoard:async id=>{if(failSwitch)throw Error('blocked');state.activeBoardId=id;state.tasks=state._tasksByBoard[id];nav.push(['board',id])},
 openTaskModal:id=>nav.push(['task',id]),showToast:s=>toasts.push(s)};
vm.createContext(ctx);
vm.runInContext(views.slice(start,end),ctx);
const find=(q,limit=100,filters={})=>ctx.searchAllBoards(q,limit,filters);

ctx.renderGlobalSearch();
assert.equal(els['#globalSearchMoreBtn'].hidden,true,'No load-more button before a search');
assert.equal(els['#globalSearchClearBtn'].disabled,true,'Clear search is disabled when there are no filters');
assert.equal(els['#globalSearchSummary'].textContent,'Поиск по всем доскам, включая вложенные задачи',
  'Empty search shows guidance');

assert.equal(find(''),undefined,'Empty search should show guidance rather than all tasks');
assert.equal(find('    '),undefined);
assert.equal(find('',100,{status:'done'}).total,1,'Status-only filtering works');
assert.equal(find('',100,{boardId:'b2'}).total,4,'Board-only filtering works');
assert.equal(find('',100,{tag:'LFP'}).total,2,'Tag-only search includes cross-board nested tasks');
assert.equal(find('',100,{tag:'lfp'}).total,2,'Tag matching is case-insensitive');
assert.equal(find('',100,{tag:'Important'}).items[0].task.id,'b','Exact tag match works');
assert.equal(find('',100,{tag:'nonexistent'}).total,0,'Unknown tag matches nothing');
assert.equal(find('',100,{tag:'lfp',status:'active'}).items[0].task.id,'nested',
  'Tag and status filters combine across boards');
assert.equal(find('',100,{tag:'lfp',priority:'high',status:'done'}).items[0].task.id,'a',
  'Tag, priority and completion filters combine');
assert.equal(find('',100,{tag:'LFP',boardId:'b2',deadline:'today'}).items[0].task.id,'nested',
  'Tag, board and deadline filters combine');
assert.equal(find('coating',100,{tag:'LFP'}).total,0,'Text and tag filter compose');
assert.equal(find('',100,{priority:'high'}).total,2,'High priority finds tasks across boards');
assert.equal(find('',100,{priority:'medium'}).items[0].task.id,'root','Medium priority filter works');
assert.equal(find('',100,{priority:'low'}).total,0,'Low priority with no matches is empty');
assert.equal(find('',100,{priority:'none'}).total,2,'Unspecified priorities count as none');
assert.equal(find('',100,{priority:'high',status:'active'}).items[0].task.id,'b',
  'High priority plus active excludes completed tasks');
assert.equal(find('',100,{priority:'high',status:'done'}).items[0].task.id,'a',
  'High priority plus done includes completed tasks');
assert.equal(find('',100,{priority:'medium',deadline:'overdue'}).items[0].task.id,'root',
  'Priority and deadline filters combine');
assert.equal(find('coating',100,{priority:'medium'}).total,0,
  'Text queries and priority filters compose');
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
assert.equal(find('LFP',100,{status:'active'}).items[0].task.id,'nested',
  'Active tag matches exclude completed tasks while retaining active nested tasks');
assert.equal(find('hidden',100,{status:'active'}).total,1,'Nested active tasks remain searchable');
assert.equal(find('hidden',100,{status:'done'}).total,0);
assert.equal(find('LFP',100,{boardId:'b2'}).items[0].task.id,'nested',
  'Board filter restricts tag matches to the selected board');
assert.equal(find('LFP',100,{boardId:'b1',status:'done'}).total,1,'Filters compose');
assert.equal(find('LFP').total,2,'Text search finds the tag across boards');
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
els['#globalSearchPriorityFilter'].value='';
els['#globalSearchTagFilter'].value='';
els['#globalSearchInput'].value='script';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchResults'].children.length,1);
assert.equal(els['#globalSearchResults'].children[0].children[0].textContent,'<script>alert(1)</script>',
  'User titles must render as text, not injected markup');
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 1');
assert.equal(els['#globalSearchClearBtn'].disabled,false,'Typing enables clear search');
const tagOptions = els['#globalSearchTagFilter'].children;
assert.equal(tagOptions.length,3,'Tags from all boards are listed without case-duplicate entries');
assert(tagOptions.some(option=>option.textContent==='LFP'),'The tag filter displays a source tag');
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchTagFilter'].children,tagOptions,'Live search keeps the native tag selector');
els['#globalSearchTagFilter'].value='lfp';
els['#globalSearchInput'].value='';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 2','Tag-only UI search spans all boards');
assert(els['#globalSearchResults'].children[0].children[1].textContent.includes('🏷'),
  'Search results display tags in metadata');
els['#globalSearchTagFilter'].value='';
els['#globalSearchPriorityFilter'].value='high';
els['#globalSearchInput'].value='';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 2','Priority-only search renders matches');
assert(els['#globalSearchResults'].children[0].children[1].textContent.includes('⚑ Высокий'),
  'Priority is visible in search result metadata');
els['#globalSearchPriorityFilter'].value='';
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
els['#globalSearchPriorityFilter'].value='low';
els['#globalSearchTagFilter'].value='important';
ctx.showGlobalMyDay();
assert.equal(els['#globalSearchInput'].value,'','My Day clears stale text');
assert.equal(els['#globalSearchBoardFilter'].value,'','My Day searches all boards');
assert.equal(els['#globalSearchStatusFilter'].value,'active','My Day excludes completed tasks');
assert.equal(els['#globalSearchDeadlineFilter'].value,'attention','My Day uses due and overdue tasks');
assert.equal(els['#globalSearchPriorityFilter'].value,'','My Day clears stale priority filters');
assert.equal(els['#globalSearchTagFilter'].value,'','My Day clears stale tag filters');
assert.deepEqual(nav.at(-1),['view','search'],'My Day navigates to search');
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchClearBtn'].disabled,false,'My Day preset may be cleared');
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 2','My Day finds work across boards');
els['#globalSearchTagFilter'].value='lfp';
state._tasksByBoard.b1[0].tags=[];
state._tasksByBoard.b2[1].tags=[];
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchTagFilter'].value,'','Removed tags reset the search tag selector');
assert.equal(els['#globalSearchTagFilter'].children.length,2,'Removed tags disappear from dropdown');
state._tasksByBoard.b1[0].tags=['LFP'];
state._tasksByBoard.b2[1].tags=['lfp'];
ctx.renderGlobalSearch();
els['#globalSearchTagFilter'].value='';

els['#globalSearchStatusFilter'].value='';
els['#globalSearchDeadlineFilter'].value='';
els['#globalSearchInput'].value=' electrode ';
els['#globalSearchBoardFilter'].value='b2';
els['#globalSearchStatusFilter'].value='active';
els['#globalSearchDeadlineFilter'].value='week';
els['#globalSearchPriorityFilter'].value='high';
els['#globalSearchTagFilter'].value='important';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchClearBtn'].disabled,false,'Combined filters enable clear search');
const boardOptionsBeforeClear=els['#globalSearchBoardFilter'].children;
const tagOptionsBeforeClear=els['#globalSearchTagFilter'].children;
ctx.clearGlobalSearch();
for (const id of ['globalSearchInput','globalSearchBoardFilter','globalSearchStatusFilter',
  'globalSearchDeadlineFilter','globalSearchPriorityFilter','globalSearchTagFilter']) {
  assert.equal(els['#'+id].value,'','Clearing search resets '+id);
}
assert.equal(els['#globalSearchClearBtn'].disabled,true,'Clear button disables after reset');
assert.equal(els['#globalSearchSummary'].textContent,'Поиск по всем доскам, включая вложенные задачи',
  'Clearing search restores guidance instead of showing all tasks');
assert.equal(els['#globalSearchResults'].children.length,0,'Clear removes outdated results');
assert.equal(els['#globalSearchMoreBtn'].hidden,true,'Clear hides the load-more button');
assert.equal(els['#globalSearchBoardFilter'].children,boardOptionsBeforeClear,'Clear preserves board selector DOM');
assert.equal(els['#globalSearchTagFilter'].children,tagOptionsBeforeClear,'Clear preserves tag selector DOM');

// Pagination: keep a bounded first page, then reveal further matches in order.
const bulkTasks=Array.from({length:215},(_,i)=>({
  id:'batch-'+i,boardId:'b2',columnId:'doing',parentId:'',
  title:'Batch task '+String(i).padStart(3,'0'),desc:'',tags:[],checklist:[],
  updatedAt:1000-i,priority:'none'
}));
state._tasksByBoard.b2.push(...bulkTasks);
els['#globalSearchInput'].value='Batch task';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchResults'].children.length,100,'First page limits DOM results to 100');
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 215 · показаны первые 100',
  'Summary shows the true count and visible count');
assert.equal(els['#globalSearchMoreBtn'].hidden,false,'More results are available');
assert.equal(els['#globalSearchResults'].children[0].children[0].textContent,'Batch task 000',
  'Pagination retains relevance ordering');
ctx.loadMoreGlobalSearchResults();
assert.equal(els['#globalSearchResults'].children.length,200,'Second page reveals 100 more results');
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 215 · показаны первые 200');
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchResults'].children.length,200,
  'Re-render without changing query keeps the expanded result count');
ctx.loadMoreGlobalSearchResults();
assert.equal(els['#globalSearchResults'].children.length,215,'Final page reveals every remaining result');
assert.equal(els['#globalSearchMoreBtn'].hidden,true,'Hide load-more after the final page');
assert.equal(els['#globalSearchResults'].children[214].children[0].textContent,'Batch task 214',
  'Pagination does not skip or duplicate results');
els['#globalSearchStatusFilter'].value='active';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchResults'].children.length,100,
  'Changing any filter restarts at the first page');
assert.equal(els['#globalSearchMoreBtn'].hidden,false,'More results remain after filter change');
els['#globalSearchInput'].value='Batch task 00';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchResults'].children.length,12,
  'Changing terms starts over; substring matching also includes tasks 100 and 200');
assert.equal(els['#globalSearchMoreBtn'].hidden,true,'No more button for short search results');
els['#globalSearchStatusFilter'].value='';
els['#globalSearchInput'].value='';
state._tasksByBoard.b2.splice(-bulkTasks.length);
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchMoreBtn'].hidden,true,'Reset hides pagination again');

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

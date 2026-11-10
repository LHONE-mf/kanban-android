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
for(const id of ['globalSearch','globalSearchInput','globalSearchResults','globalSearchSummary','globalSearchEmpty'])
  assert(html.includes('id="'+id+'"'),'Missing cross-board UI element: '+id);
assert(html.includes('data-view="search"'),'Search tab must be accessible from mobile navigation');
assert(views.includes("$('#globalSearch').hidden = view !== 'search'"),'Search view must be correctly toggled');
assert(interactions.includes("$('#globalSearchInput').addEventListener('input'"),'Search input must be live');
assert(!views.slice(start,end).includes('innerHTML = task.'),'Task data must not be inserted into HTML unsafely');

const a={id:'a',boardId:'b1',parentId:'',title:'Проверка ячейки',desc:'Quality control',tags:['LFP'],checklist:[],updatedAt:1,priority:'high'};
const child={id:'nested',boardId:'b2',parentId:'root',title:'Find hidden thing',desc:'',tags:[],checklist:[{text:'Катод'}],updatedAt:3};
const root={id:'root',boardId:'b2',parentId:'',title:'Parent',desc:'',tags:[],checklist:[],updatedAt:2};
const b={id:'b',boardId:'b2',parentId:'',title:'Results',desc:'Testing electrode coating',tags:['Important'],checklist:[],updatedAt:4};
const weird={id:'unsafe',boardId:'b2',parentId:'',title:'<script>alert(1)</script>',desc:'',tags:[],checklist:[],updatedAt:5};
const state={boards:[
  {id:'b1',name:'Lab',columns:[{id:'todo',title:'To Do'}]},
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
const els=Object.fromEntries(['#globalSearchInput','#globalSearchResults','#globalSearchSummary','#globalSearchEmpty']
 .map(key=>[key,fakeNode(key)]));
const nav=[],toasts=[];
let failSwitch=false;
const ctx={state,Date,console,document:{createElement:tag=>fakeNode(tag)},
 $:sel=>els[sel],switchView:view=>nav.push(['view',view]),
 switchBoard:async id=>{if(failSwitch)throw Error('blocked');state.activeBoardId=id;state.tasks=state._tasksByBoard[id];nav.push(['board',id])},
 openTaskModal:id=>nav.push(['task',id]),showToast:s=>toasts.push(s)};
vm.createContext(ctx);
vm.runInContext(views.slice(start,end),ctx);
const find=(q,limit=100)=>ctx.searchAllBoards(q,limit);

assert.equal(find(''),undefined,'Empty search should show guidance rather than all tasks');
assert.equal(find('    '),undefined);
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
els['#globalSearchInput'].value='script';
ctx.renderGlobalSearch();
assert.equal(els['#globalSearchResults'].children.length,1);
assert.equal(els['#globalSearchResults'].children[0].children[0].textContent,'<script>alert(1)</script>',
  'User titles must render as text, not injected markup');
assert.equal(els['#globalSearchSummary'].textContent,'Найдено задач: 1');
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

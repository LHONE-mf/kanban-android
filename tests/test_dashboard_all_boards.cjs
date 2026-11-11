// Dashboard includes all boards, not just the active board or nested subtasks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const views = fs.readFileSync('app/src/main/js-src/views.js', 'utf8');
const html = fs.readFileSync('app/src/main/assets/kanban.html', 'utf8');
const start = views.indexOf('function summarizeAllBoards(');
const end = views.indexOf('\nfunction renderDashboard()', start);
assert(start >= 0 && end > start, 'Missing all-boards counting function');
for (const id of ['allBoardsTitle','allBoardsCaption','allBoardsKpiGrid']) {
  assert(html.includes('id="' + id + '"'), 'Missing all-boards dashboard element: ' + id);
}
assert(html.includes('aria-labelledby="allBoardsTitle"'));
assert(views.includes('summarizeAllBoards(state.boards, state._tasksByBoard)'));
assert(views.includes("$('#allBoardsKpiGrid').innerHTML ="));
const count = vm.runInNewContext(views.slice(start,end) + '\nsummarizeAllBoards;', {
  dayDiff: date => ({past:-1, today:0, future:5})[date] || 0
});
const boards=[
  {id:'a',columns:[{id:'todo'},{id:'done-a',isDone:true}]},
  {id:'b',columns:[{id:'done-b',isDone:true},{id:'doing'}]},
  {id:'empty',columns:[{id:'todo'}]}
];
const byBoard={
  a:[
    {id:'a1',columnId:'todo',deadline:'past'},
    {id:'a2',columnId:'done-a',deadline:'past'},
    {id:'nested',parentId:'a1',columnId:'todo',deadline:'past'}
  ],
  b:[
    {id:'b1',columnId:'done-b'},
    {id:'b2',columnId:'doing',deadline:'today'},
    {id:'b3',columnId:'doing',deadline:'future'}
  ]
};
const plain=value=>JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(count(boards,byBoard)),{total:5,active:3,done:2,overdue:1});
assert.deepEqual(plain(count([],byBoard)),{total:0,active:0,done:0,overdue:0});
assert.deepEqual(plain(count([{id:'missing',columns:[]}],byBoard)),{total:0,active:0,done:0,overdue:0});
console.log('All-boards dashboard counts and empty states passed');

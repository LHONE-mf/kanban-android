// P14: descendant counts for large boards must be indexed once, not scanned per card.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const views = fs.readFileSync('app/src/main/js-src/views.js', 'utf8');
const start = views.indexOf('function countVisibleDescendants(');
const end = views.indexOf('function renderBoard()', start);
assert.ok(start >= 0 && end > start);
const ctx = { Map, Set };
vm.createContext(ctx);
vm.runInContext(views.slice(start, end) + '\nthis.count = countVisibleDescendants;', ctx);

const sample = [
  {id:'root-a',parentId:''},{id:'one',parentId:'root-a'},
  {id:'two',parentId:'root-a'},{id:'three',parentId:'one'},
  {id:'root-b',parentId:''},{id:'orphan',parentId:'missing'},
  {id:'root-c',parentId:''},{id:'four',parentId:'root-c'}
];
const visible = sample.filter(t=>['root-a','root-b'].includes(t.id));
const result = ctx.count(sample, visible);
assert.equal(result.get('root-a'),3,'nested children counted');
assert.equal(result.get('root-b'),0,'empty root has no children');
assert.equal(result.has('root-c'),false,'filtered root not included');
assert.equal(result.has('orphan'),false,'orphan not assigned to visible root');
assert.equal(visible.length,2);
assert.equal(sample.length,8);

const cycle = [{id:'a',parentId:''},{id:'b',parentId:'a'},{id:'c',parentId:'b'},
  {id:'c',parentId:'c'}];
assert.equal(ctx.count(cycle,[cycle[0]]).get('a'),2,'malformed cycle cannot lock the render');

const many = [];
let parentReads=0;
function item(id,parentId) {
  return {id,get parentId(){parentReads++;return parentId;}};
}
for(let i=0;i<2000;i++)many.push(item('r'+i,''));
for(let i=0;i<900;i++)many.push(item('c'+i,'r'+i));
for(let i=0;i<100;i++)many.push(item('g'+i,'c'+i));
const roots=many.slice(0,2000);
const counts=ctx.count(many,roots);
assert.equal([...counts.values()].reduce((sum,n)=>sum+n,0),1000);
assert.equal(counts.get('r0'),2);
assert.equal(counts.get('r800'),1);
assert.equal(counts.get('r1500'),0);
assert.ok(parentReads<=many.length+2,
  'parent links should be read once per render; per-card scans regress to O(N^2)');
assert.ok(views.includes('countVisibleDescendants(state.tasks, visible)'));
assert.ok(views.includes('createTaskCard(task, col, descendantCounts)'));
assert.ok(views.includes('descendantCounts.get(task.id)'),
  'card rendering must use precomputed counts');
assert.ok(views.includes('subtree(task.id).length'),
  'direct createTaskCard calls retain backward-compatible fallback');
console.log('P14: descendants and 3,000-task indexed render guard passed.');

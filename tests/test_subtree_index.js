// P17.2: exact DFS order, current-state freshness and malformed-tree safety.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const core=fs.readFileSync('app/src/main/js-src/core.js','utf8');
const start=core.indexOf('function subtree(id) {');
const end=core.indexOf('\nfunction normalizeTree(',start);
assert.ok(start>=0&&end>start,'subtree function exists');
const state={tasks:[]};
const context={state};
vm.createContext(context);
vm.runInContext(core.slice(start,end)+'\nthis.walk=subtree;',context);
const task=(id,parentId='',boardId='board')=>({id,parentId,boardId});
const root=task('r'),a=task('a','r'),b=task('b','r'),c=task('c','a'),d=task('d','c'),e=task('e','b');
state.tasks=[root,a,b,c,d,e,task('unrelated'),task('orphan','missing')];
const ids=id=>Array.from(context.walk(id),t=>t.id);
assert.deepEqual(ids('r'),['a','c','d','b','e'],'DFS pre-order respects input sibling order');
assert.deepEqual(ids('a'),['c','d']);
assert.deepEqual(ids('unrelated'),[]);
assert.deepEqual(ids('missing'),['orphan'],'children of missing root remain traversable');
assert.equal(state.tasks[0],root,'read-only traversal preserves object identity');
assert.equal(state.tasks[1],a,'read-only traversal preserves descendant identity');
assert.equal(state.tasks[3].parentId,'a','no parent mutation');
// New local array = board switch. Changes must be visible immediately, with no cache invalidation protocol.
state.tasks=[task('other-root'),task('other-child','other-root')];
assert.deepEqual(ids('r'),[],'no stale children from previous board');
assert.deepEqual(ids('other-root'),['other-child']);
// A successful add/restore becomes visible; a delete and reparent disappear instantly.
state.tasks.push(task('new','other-root'));
assert.deepEqual(ids('other-root'),['other-child','new']);
state.tasks[1]={...state.tasks[1],parentId:'new'};
assert.deepEqual(ids('other-root'),['new','other-child'],'reparented tasks reflect latest state');
state.tasks=state.tasks.filter(t=>t.id!=='new');
assert.deepEqual(ids('other-root'),[],'deleted parent does not leave cached descendants');
state.tasks.push(task('new','other-root'));
assert.deepEqual(ids('other-root'),['new','other-child'],'undo restore observes live state');
// Deep nested data should not overflow the JS call stack.
const deep=[task('top')];
for(let i=0;i<3500;i++)deep.push(task('deep'+i,i===0?'top':'deep'+(i-1)));
state.tasks=deep;
const chain=ids('top');
assert.equal(chain.length,3500);
assert.equal(chain[0],'deep0');assert.equal(chain.at(-1),'deep3499');
// Cost: parentId read at most once per task even with a broad subtree.
let parentReads=0;
state.tasks=deep.map(t=>({
  id:t.id,get parentId(){parentReads++;return t.parentId;}
}));
assert.equal(ids('top').length,3500);
assert.ok(parentReads<=state.tasks.length,'parent links are indexed only once');
// Cycles and unrelated orphans must terminate without including the root itself.
state.tasks=[task('a','c'),task('b','a'),task('c','b'),task('isolated','missing')];
assert.deepEqual(ids('a'),['b','c'],'cycle traversal terminates without returning root');
assert.deepEqual(ids('isolated'),[]);
assert.deepEqual(ids('missing'),['isolated']);
console.log('P17.2 DFS order, live writes/undo, board switch, 3500-deep tree and cycles passed.');

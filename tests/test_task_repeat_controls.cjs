// Recurrence on mobile must be directly selectable, never dependent on a
// native WebView select popup that may tap the other reminder-repeat field.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('app/src/main/assets/kanban.html','utf8');
const tasks=fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
const interactions=fs.readFileSync('app/src/main/js-src/interactions.js','utf8');
const choices=['none','daily','weekly','monthly'];
assert(html.includes('id="taskRepeatChoices"'), 'Recurrence must expose a direct button group');
assert(html.includes('id="taskRepeat"'), 'Retain task-repeat value for persisted task editing');
for(const value of choices) {
  assert(html.includes('data-task-repeat="'+value+'"'), 'Missing direct recurrence choice '+value);
}
assert(interactions.includes('setTaskRepeat(button.dataset.taskRepeat)'),
  'Recurrence choices must be bound in the real task editor');
assert(tasks.includes("setTaskRepeat(task.taskRepeat || 'none')"),
  'Existing recurrence must be visibly restored');
assert(tasks.includes("setTaskRepeat('none')"),
  'New tasks must start without recurrence');

const select={value:'none'};
const buttons=choices.map(value=>{
  const attributes={};
  const classes=new Set();
  return {dataset:{taskRepeat:value},attributes,
    classList:{toggle(name,enabled){if(enabled)classes.add(name);else classes.delete(name)},
      contains(name){return classes.has(name)}},
    setAttribute(name,value){attributes[name]=value}};
});
const start=tasks.indexOf('function setTaskRepeat(');
const end=tasks.indexOf('function openTaskModal(',start);
assert(start>=0&&end>start,'Task recurrence button state helper missing');
const context={
  $:selector=>selector==='#taskRepeat'?select:null,
  $$:selector=>selector==='#taskRepeatChoices [data-task-repeat]'?buttons:[]
};
vm.createContext(context);
vm.runInContext(tasks.slice(start,end),context);
for(const value of choices) {
  assert.equal(context.setTaskRepeat(value),true);
  assert.equal(select.value,value,'Selected recurrence must be stored in task editor');
  assert.equal(buttons.filter(b=>b.classList.contains('active')).length,1);
  assert.equal(buttons.find(b=>b.dataset.taskRepeat===value).attributes['aria-pressed'],'true');
  for(const b of buttons.filter(b=>b.dataset.taskRepeat!==value))
    assert.equal(b.attributes['aria-pressed'],'false');
}
assert.equal(context.setTaskRepeat('unrecognized'),false);
assert.equal(select.value,'monthly','Unknown recurrence must not alter saved choice');
console.log('Direct mobile recurrence choices, accessibility state, editor restore, and persistence: passed');

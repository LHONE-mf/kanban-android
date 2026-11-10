// Task editor quick scheduling must preserve local dates and not bypass validation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

process.env.TZ = 'Europe/Berlin';
const js = fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
const events = fs.readFileSync('app/src/main/js-src/interactions.js','utf8');
const html = fs.readFileSync('app/src/main/assets/kanban.html','utf8');
const css = fs.readFileSync('app/src/main/assets/kanban.css','utf8');

const first = js.indexOf('function formatTaskLocalDate(');
const last = js.indexOf('function openTaskModal(', first);
assert(first >= 0 && last > first, 'Missing reusable local date helpers for task presets');
for (const [group, values] of [
  ['deadline', ['today', 'tomorrow', 'week', 'clear']],
  ['reminder', ['hour', 'tomorrow9', 'week', 'clear']]
]) {
  assert(html.includes(`id="task${group==='deadline'?'Deadline':'Reminder'}Presets"`));
  for (const value of values) assert(html.includes(`data-${group}-preset="${value}"`),
    `Missing ${group} preset: ${value}`);
}
assert(css.includes('.task-date-presets'), 'Preset buttons need responsive touch styling');

const inputs = {
  '#taskDeadline':{value:'',dispatchEvent(){}},
  '#taskDeadlineError':{hidden:false},
  '#taskReminder':{value:'',dispatchEvent(){}},
  '#taskReminderError':{hidden:false},
  '#taskReminderRepeat':{value:'weekly'}
};
const listeners={};
for (const id of ['taskDeadlinePresets','taskReminderPresets']) {
  inputs['#'+id]={addEventListener(type,fn){listeners[id+':'+type]=fn}};
}
const ctx={Date,Event:class{constructor(type){this.type=type}},$:key=>inputs[key]};
vm.createContext(ctx);
vm.runInContext(js.slice(first,last),ctx);

const beforeDst = new Date(2027, 2, 27, 17, 25, 30);
const atStartDst = new Date(2027, 2, 28, 0, 30, 0);
assert.equal(ctx.formatTaskLocalDate(beforeDst),'2027-03-27');
assert.equal(ctx.formatTaskLocalDate(beforeDst,true),'2027-03-27T17:25');

ctx.applyTaskDeadlinePreset('today', beforeDst);
assert.equal(inputs['#taskDeadline'].value,'2027-03-27');
ctx.applyTaskDeadlinePreset('tomorrow', beforeDst);
assert.equal(inputs['#taskDeadline'].value,'2027-03-28');
ctx.applyTaskDeadlinePreset('week', beforeDst);
assert.equal(inputs['#taskDeadline'].value,'2027-04-03');
assert.equal(inputs['#taskDeadlineError'].hidden,true);
ctx.applyTaskDeadlinePreset('clear',beforeDst);
assert.equal(inputs['#taskDeadline'].value,'');
assert.equal(ctx.applyTaskDeadlinePreset('invalid',beforeDst),false);

ctx.applyTaskReminderPreset('hour', beforeDst);
assert.equal(inputs['#taskReminder'].value,'2027-03-27T18:25');
ctx.applyTaskReminderPreset('tomorrow9', beforeDst);
assert.equal(inputs['#taskReminder'].value,'2027-03-28T09:00');
ctx.applyTaskReminderPreset('week',beforeDst);
assert.equal(inputs['#taskReminder'].value,'2027-04-03T17:25');
assert.equal(inputs['#taskReminderError'].hidden,true);
// A reminder preset must not override the repeat rule selected by the user.
assert.equal(inputs['#taskReminderRepeat'].value,'weekly');
ctx.applyTaskReminderPreset('hour',atStartDst);
assert.equal(inputs['#taskReminder'].value,'2027-03-28T01:30');
ctx.applyTaskReminderPreset('clear',beforeDst);
assert.equal(inputs['#taskReminder'].value,'');
assert.equal(inputs['#taskReminderRepeat'].value,'none',
  'Clearing a reminder should clear its recurrence rule');
assert.equal(ctx.applyTaskReminderPreset('invalid',beforeDst),false);

// Check actual registered click handlers, including harmless clicks on container.
const bindStart=events.indexOf("  $('#taskDeadlinePresets').addEventListener('click'");
const bindEnd=events.indexOf("  $$('#priorityChips .chip')",bindStart);
assert(bindStart>=0&&bindEnd>bindStart,'Preset click handlers must be registered before other task controls');
vm.runInContext(events.slice(bindStart,bindEnd),ctx);
function click(id,dataName,value) {
  const button={dataset:{[dataName]:value}};
  listeners[id+':click']({target:{closest:()=>button}});
}
click('taskDeadlinePresets','deadlinePreset','tomorrow');
assert(/^\d{4}-\d{2}-\d{2}$/.test(inputs['#taskDeadline'].value));
click('taskReminderPresets','reminderPreset','hour');
assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(inputs['#taskReminder'].value));

console.log('Task deadline and reminder quick presets, local time and DST, reset and click handling: passed');

// Exercise the real task save path invoked by Android Back, not a mocked save callback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const tasks = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
const interactions = fs.readFileSync('app/src/main/js-src/interactions.js', 'utf8');
const saveStart = tasks.indexOf('let savingTask = false;');
const saveEnd = tasks.indexOf('function isModalDirty()', saveStart);
const backStart = interactions.indexOf('window.kanbanHandleBack = () => {');
const backEnd = interactions.indexOf("\n\n  document.addEventListener('keydown'", backStart);
assert(saveStart >= 0 && saveEnd > saveStart && backStart >= 0 && backEnd > backStart);

const originalReminder = '2025-01-10T09:00';
const original = {
  id:'t1',boardId:'b1',columnId:'col',parentId:'',title:'Existing task',
  desc:'',tags:[],checklist:[],files:[],reminder:originalReminder,
  reminderRepeat:'none',priority:'none',order:0,createdAt:1,updatedAt:2,completedAt:null
};
const state = {tasks:[original],activeBoardId:'b1'};
const inputs = Object.fromEntries([
  ['taskTitle','Updated task'], ['taskDeadline',''], ['taskReminder',originalReminder],
  ['taskReminderRepeat','none'],['taskTags',''],['taskParent','col:col'],
  ['taskDesc','Updated description']
].map(([id,value])=>[id,{value,focus(){this.focused=true}}]));
for (const id of ['taskTitleError','taskDeadlineError','taskReminderError']) inputs[id]={hidden:true};
const modal = {open:true,classList:{contains(name){return name==='open'&&modal.open}}};
for (const id of ['lightbox','confirmModal','settingsModal','shortcutsModal'])
  inputs[id]={classList:{contains:()=>false}};
inputs.taskModal = modal;
const toasts=[],saved=[];
let rejectWrites = false;
const context={
  window:{},Date,Math,console,
  $:selector=>inputs[selector.slice(1)],
  state,editingTaskId:'t1',newFiles:[],tempFiles:[],tempChecklist:[],editingPriority:'none',
  rec:{mr:null},isValidISODate:value=>!value||/^\d{4}-\d{2}-\d{2}$/.test(value),
  computeCompletedAt:()=>null,
  dbPutTask:async task=>{if(rejectWrites)throw new Error('No storage space');saved.push(task)},
  syncNativeReminder:()=>{},syncKids:async()=>{},notifyOtherTabs:()=>{},renderBoard:()=>{},
  closeModal:id=>{if(id==='taskModal')modal.open=false},
  closeLightbox:()=>{},showToast:message=>toasts.push(message),
  storeFile:async()=>{throw new Error('Unexpected file')}, mediaDelete:async()=>{},
  confirmDialog:async()=>false
};
vm.createContext(context);
vm.runInContext(tasks.slice(saveStart,saveEnd)+ '\n'+ interactions.slice(backStart,backEnd),context);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  // Existing reminders that have already passed should not prevent saving unrelated edits.
  assert.equal(context.window.kanbanHandleBack(),true);
  await tick();
  assert.equal(saved.length,1,'Back should persist edits despite an unchanged expired reminder');
  assert.equal(saved[0].title,'Updated task');
  assert.equal(modal.open,false,'Back must close editor only after the save succeeds');

  // A newly-entered past reminder is invalid and must keep the editor open with feedback.
  modal.open=true;
  inputs.taskReminder.value='2020-01-01T09:00';
  inputs.taskTitle.value='Edited again';
  assert.equal(context.window.kanbanHandleBack(),true);
  await tick();
  assert.equal(saved.length,1,'Back must not save invalid newly selected reminder');
  assert.equal(modal.open,true);
  assert.equal(inputs.taskReminderError.hidden,false);
  assert(toasts.some(text=>text.includes('напоминан')), 'Blocked Back save needs a visible explanation');

  // Empty title also must explain why a save was blocked.
  inputs.taskTitle.value='';
  assert.equal(context.window.kanbanHandleBack(),true);
  await tick();
  assert.equal(modal.open,true);
  assert(toasts.some(text=>text.includes('назван')), 'Missing task title needs a visible explanation');

  // Persistence errors should be shown and never dismiss the editor.
  rejectWrites=true;
  inputs.taskTitle.value='Valid title';inputs.taskReminder.value='';
  assert.equal(context.window.kanbanHandleBack(),true);
  await tick();
  assert.equal(modal.open,true);
  assert(toasts.some(text=>text.includes('No storage space')));
  assert.equal(saved.length,1);

  modal.open=false;
  assert.equal(context.window.kanbanHandleBack(),false,'Back on board should reach app exit logic');
  console.log('Android Back: real save, expired unchanged reminder, new invalid reminder, empty title and failed write passed');
})().catch(error=>{console.error(error);process.exitCode=1});

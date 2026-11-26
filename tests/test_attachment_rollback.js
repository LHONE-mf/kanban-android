// C-06: failed multi-file saves wait for every staged blob to be discarded.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('app/src/main/js-src/tasks.js','utf8');
const a=src.indexOf('async function _saveTask()');
const b=src.indexOf('\nfunction isModalDirty()',a);
assert.ok(a>0&&b>a);
const selected=[{name:'one.txt',size:10},{name:'two.txt',size:10}];
const state={tasks:[],activeBoardId:'b'};
const fields={taskTitle:'Multi file',taskParent:'col:todo',taskDeadline:'',taskDesc:'',taskTags:''};
const deleted=[];let storageFailure='file',saveAttempts=0;
const context={
  $:q=>({value:fields[q.slice(1)]||'',hidden:false,focus(){}}),
  state,editingTaskId:null,editingPriority:'none',tempFiles:[],newFiles:selected,tempChecklist:[],tempResults:[],
  rec:{mr:null},isValidISODate:()=>true,Date,generateId:()=> 'new-task',
  subtree:()=>[],computeCompletedAt:()=>null,showToast:()=>{},
  storeFile:async f=>{
    if(storageFailure==='file'&&f===selected[1])throw Error('full disk');
    return {id:'m-'+f.name,name:f.name,type:'text/plain',size:f.size};
  },
  mediaDeleteUnreferenced:async ids=>{await new Promise(resolve=>setImmediate(resolve));deleted.push(...ids);},
  dbPutTasks:async()=>{saveAttempts++;if(storageFailure==='database')throw Error('disk');},
  closeModal:()=>{},notifyOtherTabs:()=>{},renderBoard:()=>{},scheduleMediaDelete:()=>{}
};
vm.createContext(context);
vm.runInContext(src.slice(a,b)+'\nthis.save=_saveTask;',context);
(async()=>{
  await context.save();
  assert.equal(saveAttempts,0,'no task should be written when second blob fails');
  assert.deepEqual(deleted,['m-one.txt'],'first staged blob must be deleted before save returns');
  storageFailure='database';deleted.length=0;
  await context.save();
  assert.equal(saveAttempts,1);
  assert.deepEqual(deleted,['m-one.txt','m-two.txt'],'both staged blobs must be deleted on DB failure');
  assert.equal(state.tasks.length,0,'no partial task was committed');
  console.log('C-06 staged attachment rollback regression passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

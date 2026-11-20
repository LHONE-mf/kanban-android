// C-06: selections from separate Android picker visits accumulate safely.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/interactions.js', 'utf8');
const begin = source.indexOf('function stageSelectedFiles(files)');
const end = source.indexOf('// ============================================================\n// QUICK ADD', begin);
assert.ok(begin >= 0 && end > begin);
const alerts = [], renders = [];
const env = {
  MAX_VIDEO_SIZE: 50 * 1024 * 1024,
  isAudio: file => file.type.startsWith('audio/'),
  prepAudio: async () => ({dur: 1}),
  $: () => ({classList:{contains:()=>true}}),
  showToast: message => alerts.push(message),
  renderFiles: () => renders.push(1),
  Number, console,
};
vm.createContext(env);
vm.runInContext('let savingTask = false; let newFiles = [];\n' +
  source.slice(begin,end) +
  '\nthis.stage=stageSelectedFiles; this.files=()=>newFiles; this.lock=()=>{savingTask=true;};', env);
const one = {name:'a.jpg',type:'image/jpeg',size:500};
const two = {name:'b.pdf',type:'application/pdf',size:1000};
const huge = {name:'huge.mov',type:'video/quicktime',size:51*1024*1024};
assert.equal(env.stage([one,huge]),1);
assert.equal(env.stage([two]),1);
assert.equal(env.files().length,2,'second picker selection must not replace first');
assert.equal(env.files()[0],one);
assert.equal(env.files()[1],two);
assert.equal(alerts.length,1,'oversized file is explicitly reported');
assert.equal(renders.length,2);
env.lock();
assert.equal(env.stage([{name:'late.jpg',type:'image/jpeg',size:10}]),0);
assert.equal(env.files().length,2,'selection cannot mutate an ongoing save');
const html=fs.readFileSync('app/src/main/assets/kanban.html','utf8');
assert.match(html,/<input type="file" id="taskFile" multiple/);
const kt=fs.readFileSync('app/src/main/java/com/kanban/offline/MainActivity.kt','utf8');
assert.match(kt,/MODE_OPEN_MULTIPLE/);
assert.match(kt,/Intent\.EXTRA_ALLOW_MULTIPLE/);
assert.match(kt,/result\.data\?\.clipData/);
assert.match(kt,/LinkedHashSet<Uri>/);
console.log('C-06 multi-file selection regression passed.');

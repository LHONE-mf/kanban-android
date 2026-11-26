const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/data-transfer.js', 'utf8');
const core = fs.readFileSync('app/src/main/js-src/core.js', 'utf8');
const files = [
  { id: 'shared', mime: 'image/png', path: 'media/000000.bin', size: 4 },
  { id: 'voice', mime: 'audio/mp4', path: 'media/000001.bin', size: 5 }
];
const task = (id, parentId = '') => ({
  id, parentId, title: id, boardId: 'board', columnId: 'todo', deadline: '2026-12-05', reminderTime: '10:00',
  order: id === 'parent' ? 1 : 2,
  files: [{ ...files[0], type: 'image/png' }], checklist: [{ id: 'c', text: 'Check', checked: true }],
  results: []
});
const data = {
  version: 1, boards: [{ id: 'board', name: 'Board', columns: [{ id: 'todo', color: '#ffffff' }] }],
  activeBoardId: 'board', tasks: [task('parent'), task('child', 'parent')], media: files,
  settings: { theme: 'dark', comrade_day_plan_v1: { date: '2026-12-05', ids: ['parent'] } },
  web: { kanban_theme: 'dark' }, nativeJapanese: null,
  pomo: { mode: 'focus', remaining: 1500000, day: '2026-12-05', sessions: 1, running: false, end: 0 }
};
data.tasks[0].results.push({ id: 'r', text: '', createdAt: 22, updatedAt: 23 });
data.tasks[0].files.push({ ...files[1], type: 'audio/mp4', resultId: 'r' });
const paths = ['state.json', ...files.map(f => f.path)];
const events = [], warnings = [];
const staging = new Map();
let archiveState = data, errorAt = null;
const env = {
  MAX_VIDEO_SIZE: 50 * 1024 * 1024, PRIORITY_LABELS: { none: true }, COLOR_RE: /^#/, DONE_TITLE_RE: /Done/,
  isValidISODate: x => /^\d{4}-\d{2}-\d{2}$/.test(x), generateId: () => 'generated',
  crypto: { randomUUID: () => 'session' }, KanbanMedia: { postMessage() {} },
  mediaCommand: (id, type) => events.push(type),
  mediaStep: async (id, type, send) => { send(); return { entries: paths, tasks: 2, media: 2 }; },
  sendMediaChunks: async () => {}, confirmDialog: async () => true, taskEditorBlocksImport: () => false,
  alert: text => warnings.push(text),
  fetch: async path => ({
    ok: !path.endsWith(errorAt),
    json: async () => archiveState,
    blob: async () => new Blob([path.endsWith('000000.bin') ? 'test' : 'voice'])
  }),
  mediaPut: async (key, full) => staging.set(JSON.stringify(key), full),
  mediaDeleteBatch: async keys => keys.forEach(key => staging.delete(JSON.stringify(key))),
  dbReplaceAll: async plan => {
    events.push('commit');
    assert.equal(staging.get(JSON.stringify(['session', 'shared'])).type, 'image/png');
    assert.deepEqual(Array.from(plan.stagedMedia.ids), ['shared', 'voice']);
    assert.equal(plan.tasks[0].files[1].resultId, 'r');
  },
  localStorage: { length: 0, setItem: () => events.push('web-theme') },
  location: { reload: () => events.push('reload') }
};
const zip = source.slice(source.indexOf("const ZIP_PROJECTION"), source.indexOf('async function exportData'));
const japanese = source.slice(source.indexOf('const JAPANESE_BACKUP_KEYS'), source.indexOf('let pendingNativeJapanese'));
const nativeJapanese = source.slice(source.indexOf('function validateNativeJapaneseBackup'), source.indexOf('function nativeJapaneseCommand'));
const model = core.slice(core.indexOf('function sanitizeTask'), core.indexOf('// COMPLETED-AT'));
vm.createContext(env);
vm.runInContext(japanese + nativeJapanese + model + zip, env);
const verified = env.validateZipState(data, paths);
assert.equal(verified.tasks[0].results[0].id, 'r');
assert.equal(verified.tasks[1].files[0].id, 'shared');
assert.equal(verified.tasks[1].reminderTime, '10:00');
assert.equal(verified.settings.comrade_day_plan_v1.ids[0], 'parent');
const corrupt = update => {
  const copy = structuredClone(data);
  update(copy);
  assert.throws(() => env.validateZipState(copy, paths), /метаданные/);
};
corrupt(copy => { copy.tasks[0].parentId = 'child'; });
corrupt(copy => { copy.tasks[0].files[1].resultId = 'missing'; });
corrupt(copy => { copy.tasks[1].id = 'parent'; });
corrupt(copy => { copy.media[0].path = '../state.json'; });
corrupt(copy => { copy.web.untrusted_key = 'secret'; });
assert.throws(() => env.validateZipState(data, [...paths, 'media/123456.bin']), /метаданные/);
vm.runInContext("pomodoroArchive = async () => ({ mode: 'focus', day: '2026-12-05', remaining: 1500000, sessions: 0, running: false, end: 0 }); this.dbPutSettingsBulk = async () => {};", env);

(async () => {
  errorAt = '000001.bin';
  await env.importZipData({ size: 500 });
  assert.ok(!events.includes('commit'), 'partial media must never change live storage');
  assert.equal(staging.size, 0, 'partial zip staging is cleaned independently');
  assert.match(warnings[0], /Данные сохранены/);
  archiveState = structuredClone(data);
  errorAt = null;
  await env.importZipData({ size: 500 });
  assert.ok(events.indexOf('commit') < events.indexOf('web-theme'));
  assert.ok(events.includes('reload'));
  Object.assign(env, {
    savingTask: false, importInProgress: false, Blob,
    todayISO: () => '2026-12-05', nativeJapaneseCommand: async () => null,
    dbReadZipSnapshot: async () => ({ tasks: data.tasks, settings: { boards: data.boards, activeBoardId: data.activeBoardId },
      records: new Map(files.map(file => [file.id, { full: new Blob([file.id === 'voice' ? 'voice' : 'test']), type: file.mime }])) }),
    showToast: text => warnings.push(text)
  });
  events.length = 0;
  await env.exportZipData(true);
  assert.ok(events.includes('zip-snapshot'), 'SQLite preparation uses the native snapshot command');
  assert.ok(!events.includes('zip-seal') && !events.includes('commit'), 'preparation leaves live data alone');
  console.log('ZIP backup: clean state, legacy shared media, archive bounds and atomic JS publication verified.');
})().catch(error => { console.error(error); process.exitCode = 1; });

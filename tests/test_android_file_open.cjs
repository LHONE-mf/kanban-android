// Exercise the actual task-attachment opener in an isolated WebView-like VM.
// Native messages are acknowledged one at a time: no large JS interface payload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app/src/main/js-src/tasks.js', 'utf8');
const start = source.indexOf('// Android WebView does not execute downloads from blob: anchor links.');
const end = source.indexOf('// ============================================================\n// ATOMIC SAVE', start);
assert(start >= 0 && end > start, 'Missing Android file opener');

const sent = [], toasts = [], viewed = [];
const payload = Buffer.from('Hello, задача あ!\n' + 'data/'.repeat(24000), 'utf8');
let record = { full: new Blob([payload]), type: 'text/plain' };
const context = {
  Blob, Uint8Array, Date, Math, console, MAX_VIDEO_SIZE: 50 * 1024 * 1024,
  location: {origin: 'https://appassets.androidplatform.net'},
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  window: {KanbanFileOpen: {postMessage(raw) {sent.push(JSON.parse(raw));}}},
  mediaGet: async id => id === 'f1' ? record : null,
  openLightbox: (...args) => viewed.push(args),
  showToast: value => toasts.push(value),
};
vm.createContext(context);
vm.runInContext(source.slice(start, end) + '\nglobalThis.testOpenFile = openFile;', context);

const nextMessage = async (offset) => {
  for (let i = 0; i < 200; i++) {
    if (sent.length > offset) return sent[offset];
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for native message');
};
const response = event => context.window.kanbanFileOpenNativeResult(JSON.stringify(event));

(async () => {
  await context.testOpenFile({id:'f1', name:'пример.txt', type:'text/plain'}, 'Task');
  let message = await nextMessage(0);
  assert.equal(message.type, 'start');
  assert.equal(message.name, 'пример.txt');
  assert.equal(message.mime, 'text/plain');
  assert.equal(message.size, payload.length);
  const id = message.id;
  response({id, type:'ready'});

  let cursor = 0, chunkCount = 0;
  while (cursor < payload.length) {
    message = await nextMessage(++chunkCount);
    assert.equal(message.id, id);
    assert.equal(message.type, 'chunk');
    assert.equal(message.index, chunkCount - 1);
    const part = Buffer.from(message.data, 'base64');
    assert(part.length >= 1 && part.length <= 32 * 1024);
    assert.deepEqual(part, payload.subarray(cursor, cursor + part.length));
    cursor += part.length;
    response({id, type:'ack', index:chunkCount});
  }
  message = await nextMessage(++chunkCount);
  assert.equal(message.type, 'finish');
  response({id, type:'opened'});
  assert.equal(toasts.length, 0);
  assert(chunkCount >= 3, 'Should exercise multiple chunks');

  // No installed viewer: native error should be visible to the user.
  let at = sent.length;
  await context.testOpenFile({id:'f1',name:'file.txt',type:'text/plain'}, 'Task');
  message = await nextMessage(at);
  response({id:message.id,type:'error',message:'Нет приложения для открытия'});
  assert(toasts.at(-1).includes('Нет приложения'));

  // Invalid acknowledgment must abort, and not leave the bridge blocked.
  at = sent.length;
  await context.testOpenFile({id:'f1',name:'file.txt',type:'text/plain'}, 'Task');
  message = await nextMessage(at++);
  response({id:message.id,type:'ready'});
  await nextMessage(at++);
  response({id:message.id,type:'ack',index:500});
  message = await nextMessage(at);
  assert.equal(message.type, 'abort');
  assert(toasts.at(-1).includes('подтверждение'));

  // Missing media and oversize files must report errors without sending data.
  at = sent.length;
  await context.testOpenFile({id:'not-found',name:'missing.txt',type:'text/plain'}, 'Task');
  assert.equal(sent.length, at);
  assert(toasts.at(-1).includes('Файл не найден'));
  record = { full: new Blob([Buffer.alloc(50 * 1024 * 1024 + 1)]) };
  await context.testOpenFile({id:'f1',name:'large.bin',type:'application/octet-stream'}, 'Task');
  assert.equal(sent.length, at);
  assert(toasts.at(-1).includes('50 МБ'));

  // Images continue to use the existing in-app lightbox.
  await context.testOpenFile({id:'f1',name:'picture.png',type:'image/png'}, 'Task');
  assert.equal(viewed.length, 1);
  assert.equal(sent.length, at);

  console.log('Android task file open: exact bytes, multi-chunk transfer, native error, bad ack, missing/large media and image fallback passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

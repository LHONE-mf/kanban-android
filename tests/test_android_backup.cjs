// Execute the real Android backup bridge JavaScript: multiple binary chunks,
// acknowledgment ordering, user cancellation, and native write failures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app/src/main/js-src/data-transfer.js', 'utf8');
const start = source.indexOf('let activeAndroidBackup = null;');
const end = source.indexOf('// ============================================================\n// EXPORT JSON', start);
assert(start >= 0 && end > start, 'Android backup bridge not found');

const sent = [];
const context = {
  Blob, Uint8Array, Date, Math,
  btoa: (data) => Buffer.from(data, 'binary').toString('base64'),
  window: {KanbanBackup: {postMessage(raw) {sent.push(JSON.parse(raw));}}},
};
vm.createContext(context);
vm.runInContext(source.slice(start, end) +
  '\nglobalThis.saveBackup = saveBackupViaAndroid;', context);
const result = (event) => context.window.kanbanBackupNativeResult(JSON.stringify(event));
const nextMessage = async (offset) => {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (sent.length > offset) return sent[offset];
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for backup transfer message');
};

(async () => {
  const contents = JSON.stringify({
    boards: [{name: 'Пример'}],
    tasks: [{title: 'Задача あ', files: ['image-1']}],
    media: { 'image-1': {type: 'image/png', data: 'data:image/png;base64,' + 'a'.repeat(180000)} }
  });
  const original = Buffer.from(contents, 'utf8');
  const pending = context.saveBackup(new Blob([contents]), 'kanban-backup-2026-11-08.json');
  let msg = await nextMessage(0);
  assert.equal(msg.type, 'start');
  assert.equal(msg.size, original.length);
  result({type:'ready', id:msg.id});
  let chunkNumber = 0, position = 0;
  while (position < original.length) {
    msg = await nextMessage(++chunkNumber);
    assert.equal(msg.type, 'chunk');
    assert.equal(msg.index, chunkNumber - 1);
    const bytes = Buffer.from(msg.data, 'base64');
    assert(bytes.length > 0 && bytes.length <= 32768);
    assert.deepEqual(bytes, original.subarray(position, position + bytes.length));
    position += bytes.length;
    result({type:'ack', id:msg.id, index:chunkNumber});
  }
  msg = await nextMessage(++chunkNumber);
  assert.equal(msg.type, 'finish');
  result({type:'choosing', id:msg.id});
  result({type:'saved', id:msg.id});
  assert.equal(await pending, true);

  let index = sent.length;
  const cancelled = context.saveBackup(new Blob(['{}']), 'kanban-backup-2026-11-08.json');
  msg = await nextMessage(index++);
  assert.equal(msg.type, 'start');
  result({type:'cancelled', id:msg.id});
  assert.equal(await cancelled, false);

  index = sent.length;
  const failed = context.saveBackup(new Blob(['{}']), 'kanban-backup-2026-11-08.json');
  msg = await nextMessage(index++);
  result({type:'error', id:msg.id, message:'Нет доступа'});
  await assert.rejects(failed, /Нет доступа/);

  index = sent.length;
  const rejectedAck = context.saveBackup(new Blob(['{}']), 'kanban-backup-2026-11-08.json');
  msg = await nextMessage(index++);
  result({type:'ready', id:msg.id});
  await nextMessage(index++);
  result({type:'ack', id:msg.id, index:999});
  await assert.rejects(rejectedAck, /подтверждения/);
  msg = await nextMessage(index++);
  assert.equal(msg.type, 'abort');

  console.log('Android Save As: byte-exact chunks, completion, cancellation, errors and malformed acks passed');
})().catch(error => {console.error(error);process.exitCode = 1;});

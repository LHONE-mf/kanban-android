import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const targets = await (await fetch('http://127.0.0.1:9221/json')).json();
const page = targets.find(target => target.url === 'https://appassets.androidplatform.net/assets/kanban.html');
assert.ok(page, 'COMRADE Kanban WebView not available');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let serial = 0;
const calls = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const call = calls.get(message.id);
  if (!call) return;
  calls.delete(message.id);
  if (message.error || message.result.exceptionDetails) call.reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
  else call.resolve(message.result.result.value);
});
function evaluate(fn) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
      expression: '(' + fn.toString() + ')()', awaitPromise: true, returnByValue: true
    } }));
  });
}
const mode = process.argv[2];
try {
  if (mode === 'seed') {
    await evaluate(async () => {
      const request = indexedDB.open('kanban_db_v2', 1);
      const db = await new Promise((ok, fail) => { request.onsuccess = () => ok(request.result); request.onerror = fail; });
      const tx = db.transaction(['tasks', 'settings', 'media'], 'readwrite');
      const boards = [{ id: 'p19-test-board', name: 'P19 test board', columns: [
        { id: 'todo', title: 'Todo', color: '#7a7a7a', isDone: false },
        { id: 'done', title: 'Done', color: '#339933', isDone: true }
      ] }];
      const common = {
        boardId: boards[0].id, columnId: 'todo', title: '', desc: 'Synthetic P19 integration fixture',
        tags: ['synthetic'], priority: 'normal', deadline: '', order: 0, completedAt: null,
        createdAt: 1733000100000, updatedAt: 1733000200000, checklist: [], results: [], files: []
      };
      const samples = 32000;
      const wav = new ArrayBuffer(44 + 2 * samples);
      const view = new DataView(wav);
      const ascii = (offset, chars) => [...chars].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
      ascii(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); ascii(8,'WAVE'); ascii(12,'fmt ');
      view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
      view.setUint32(24,8000,true); view.setUint32(28,16000,true); view.setUint16(32,2,true);
      view.setUint16(34,16,true); ascii(36,'data'); view.setUint32(40,2*samples,true);
      for (let i = 0; i < samples; i++) view.setInt16(44+2*i, Math.floor(900 * Math.sin(2*Math.PI*400*i/8000)), true);
      const audio = new Blob([wav], { type: 'audio/wav' });
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3f8AAAAASUVORK5CYII=';
      const image = new Blob([Uint8Array.from(atob(png.split(',')[1]), char => char.charCodeAt(0))],{type: 'image/png'});
      tx.objectStore('tasks').put({ ...common, id: 'p19-root', title: 'Upgrade fixture: parent', parentId: '',
        results: [{ id: 'r-old', text: 'P19 existing result', createdAt: 1733000500000, updatedAt: 1733000500000 }],
        files: [
          { id: 'p19-photo', name: 'old.png', type: image.type, size: image.size },
          { id: 'p19-wav', name: 'old.wav', type: audio.type, size: audio.size, resultId: 'r-old', dur: 4, peaks: [10,50,10] }
        ], checklist: [{ id: 'c-old', text: 'P19 checklist', checked: true }]
      });
      tx.objectStore('tasks').put({ ...common, id: 'p19-child', title: 'Upgrade fixture: child', parentId: 'p19-root', order: 1 });
      tx.objectStore('media').put({ full: image, type: image.type, thumb: png }, 'p19-photo');
      tx.objectStore('media').put({ full: audio, type: audio.type, thumb: null }, 'p19-wav');
      tx.objectStore('settings').put({ key: 'boards', value: boards });
      tx.objectStore('settings').put({ key: 'activeBoardId', value: boards[0].id });
      tx.objectStore('settings').put({ key: 'comrade_day_plan_v1', value: { date:'2026-11-25', ids:['p19-root'], updatedAt:1733000050000 } });
      const now = new Date(), pad = number => String(number).padStart(2, '0');
      const day = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
      localStorage.setItem('kanban_pomo', JSON.stringify({ mode: 'focus', left: 300, sessions: 2, running: false, day }));
      localStorage.setItem('kanban-japanese-hiragana-v1', JSON.stringify(['あ']));
      await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onabort = fail; });
      db.close();
      return true;
    });
  } else if (mode === 'snapshot') {
    const result = await evaluate(async () => {
      const db = await new Promise((ok, fail) => {
        const req = indexedDB.open('kanban_db_v2', 1);
        req.onsuccess = () => ok(req.result); req.onerror = fail;
      });
      const tx = db.transaction(['tasks','media','settings'], 'readonly');
      const wait = request => new Promise((ok, fail) => { request.onsuccess = () => ok(request.result); request.onerror = fail; });
      const [tasks, photo, audio, settings] = await Promise.all([
        wait(tx.objectStore('tasks').getAll()), wait(tx.objectStore('media').get('p19-photo')),
        wait(tx.objectStore('media').get('p19-wav')), wait(tx.objectStore('settings').getAll())
      ]);
      db.close();
      const checksum = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      return { tasks, settings: settings.filter(row => ['boards','activeBoardId','comrade_day_plan_v1'].includes(row.key)),
        photo: await checksum(photo.full), audio: await checksum(audio.full), japanese: localStorage.getItem('kanban-japanese-hiragana-v1') };
    });
    if (process.argv[3]) await fs.writeFile(process.argv[3], JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ tasks: result.tasks.length, photo: result.photo, audio: result.audio, japanese: result.japanese }));
  } else if (mode === 'smoke') {
    const result = await evaluate(async () => {
      const native = ['KanbanVoice', 'KanbanMedia', 'KanbanGallery', 'KanbanPomo', 'KanbanTaskReminders'];
      const available = Object.fromEntries(native.map(name => [name, !!globalThis[name]?.postMessage]));
      const root = document.querySelector('[data-task-id="p19-root"]');
      if (!root) throw new Error('Updated app cannot render the old card');
      const player = root.querySelector('.ap-play');
      if (!player) throw new Error('Updated app cannot find the old audio');
      const mediaEvents = [];
      const original = window.kanbanMediaNativeResult;
      window.kanbanMediaNativeResult = raw => { mediaEvents.push(JSON.parse(raw).type); original(raw); };
      player.click();
      for (let i = 0; i < 50 && !mediaEvents.includes('state'); i++) await new Promise(resolve => setTimeout(resolve, 200));
      player.click();
      return { available, pomo: document.querySelector('#pomoTime').textContent,
        sessions: document.querySelector('#pomoMode').textContent, audioEvents: mediaEvents };
    });
    console.log(JSON.stringify(result));
    assert.ok(Object.values(result.available).every(Boolean));
    assert.equal(result.pomo, '05:00');
    assert.match(result.sessions, /2/);
    assert.ok(result.audioEvents.includes('loaded'), 'Legacy WAV not handled by native player');
    assert.ok(result.audioEvents.includes('state'), 'Native player did not report playback');
  } else { throw new Error('Unknown fixture operation'); }
} finally {
  socket.close();
}

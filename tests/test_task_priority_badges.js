// DOM-free regression: task titles appear first, badges stay visible, and
// cards retain their full height inside a scrollable mobile column.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/js-src/views.js','utf8');
const start = source.indexOf('function createTaskCard(');
const end = source.indexOf('\nfunction topOrder(',start);
assert.ok(start >= 0 && end > start);
const context = {
  document: {
    createElement() {
      return {
        dataset:{}, style:{setProperty(){}}, innerHTML:'', tabIndex:0,
        setAttribute(name,val){this[name]=val;},
        querySelector(selector) {
          if (selector === '[data-delete]' ||
              selector === '[data-move-next]' ||
              selector === '[data-move-done]') return {};
          return null;
        },
        querySelectorAll() {return [];},
        addEventListener() {}
      };
    }
  },
  PRIORITY_LABELS:{none:'Без',low:'Низкий',medium:'Средний',high:'Высокий'},
  escapeHtml:s=>String(s),
  truncate:s=>s,
  subtree:()=>[],
  dayDiff:()=>0,
  formatDate:s=>s,
  isAudio:()=>false,
  thumbCache:new Map(),
  console
};
vm.createContext(context);
vm.runInContext(source.slice(start,end),context,{filename:'views.js'});
for(const [priority,label] of [['high','Высокий'],['medium','Средний'],
                                ['low','Низкий'],['none','Без приоритета']]){
  const task={id:'test1234',title:'Испытания аккумуляторов',desc:'Описание задачи',
    tags:[],files:[],checklist:[],priority,deadline:'2026-11-20'};
  const card=context.createTaskCard(task,{color:'#abc',isDone:false});
  const markup=card.innerHTML;
  assert.ok(markup.includes('class="task-priority p-'+priority+'"'),priority);
  assert.ok(markup.includes(label),priority);
  assert.ok(markup.indexOf('class="task-title"')<
    markup.indexOf('class="task-card-meta"'),"title is visible before metadata");
  assert.ok(markup.includes('📅 2026-11-20'),"deadline near priority");
  assert.ok(card['aria-label'].includes('Приоритет: '+label),"accessible");
  const footer=markup.split('class="task-footer"')[1];
  assert.ok(!footer.includes('class="task-priority'),"priority not buried in footer");
}
const unknown=context.createTaskCard(
  {id:'notset',title:'Без оценки',desc:'',tags:[],files:[],checklist:[],priority:'',
    deadline:''},
  {color:'#abc',isDone:false});
assert.ok(unknown.innerHTML.includes('Без приоритета'));
const css = fs.readFileSync('app/src/main/assets/kanban.css', 'utf8');
const cardCss = css.match(/^\.task-card\s*\{([^}]*)\}/m)?.[1] || '';
const listCss = [...css.matchAll(/^\.task-list\s*\{([^}]*)\}/gm)].map(match => match[1]);
const metaCss = css.match(/^\.task-card-meta\s*\{([^}]*)\}/m)?.[1] || '';
assert.match(cardCss, /flex-shrink:\s*0\s*;/, 'task cards never shrink to fit viewport');
assert.ok(listCss.some(rule => /overflow-y:\s*auto\s*;/.test(rule)), 'columns scroll vertically');
assert.doesNotMatch(metaCss, /padding-right:/, 'badges use card width below the title');
console.log('Readable task cards: title-first, 4 priorities, unset case, scrolling layout passed.');

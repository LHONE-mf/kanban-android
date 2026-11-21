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
const longTitle = 'Подготовить подробный отчёт по электродам и аккумуляторам. '.repeat(5).slice(0,200);
const longTask = context.createTaskCard({
  id:'long0001',title:longTitle,desc:'Подробное описание без ограничения высоты',
  tags:[],files:[],checklist:[],priority:'high',deadline:'2026-11-20'
}, {color:'#abc',isDone:false});
assert.ok(longTask.innerHTML.includes(longTitle),'full 200-character title is preserved');

const css = fs.readFileSync('app/src/main/assets/kanban.css', 'utf8');
const cardCss = css.match(/^\.task-card\s*\{([^}]*)\}/m)?.[1] || '';
const listCss = [...css.matchAll(/^\.task-list\s*\{([^}]*)\}/gm)].map(match => match[1]);
const metaCss = css.match(/^\.task-card-meta\s*\{([^}]*)\}/m)?.[1] || '';
assert.match(cardCss, /flex-shrink:\s*0\s*;/, 'task cards never shrink to fit viewport');
assert.ok(listCss.some(rule => /overflow-y:\s*auto\s*;/.test(rule)), 'columns scroll vertically');
assert.doesNotMatch(metaCss, /padding-right:/, 'badges use card width below the title');
const titleCss = css.match(/^\.task-title\s*\{([^}]*)\}/m)?.[1] || '';
assert.match(titleCss,/word-break:\s*break-word/,'long titles can wrap onto new lines');
const actionsCss = css.match(/^\.task-quick-actions\s*\{([^}]*)\}/m)?.[1] || '';
const buttonsCss = css.match(/^\.task-quick-btn\s*\{([^}]*)\}/m)?.[1] || '';
assert.match(actionsCss, /opacity:\s*1\s*;/, 'quick actions stay visible without hover');
assert.doesNotMatch(css, /@media\s*\(hover:\s*none\)[^}]*opacity:\s*0\./,
  'touchscreen buttons must not be faded');
assert.match(buttonsCss, /width:\s*30px;\s*height:\s*30px;/, 'tap targets are enlarged');
assert.match(titleCss,/padding-right:\s*104px;/,'title stays clear of visible actions');
assert.match(context.createTaskCard({
  id:'icons0001',title:'Icons',desc:'',tags:[],files:[],checklist:[],
  priority:'high',deadline:''
},{color:'#abc',isDone:false}).innerHTML,
 /data-move-next="1"[\s\S]*data-move-done="1"[\s\S]*data-delete="1"/,
 'quick actions remain on the card');
assert.doesNotMatch(cardCss,/(?:^|;)\s*(?:height|max-height):/,'card height is content-based');

console.log('Readable task cards: title-first, 4 priorities, unset case, scrolling layout passed.');

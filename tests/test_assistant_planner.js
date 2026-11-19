// Test isolated intent extraction without loading Android, IndexedDB or a real model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app/src/main/js-src/assistant.js', 'utf8');
const sandbox = {
  window: {},
  state: {
    activeBoardId: 'board_prod',
    boards: [
      {id:'board_prod', name:'Производство',
       columns:[{id:'col_todo',title:'To Do',isDone:false},
                {id:'col_done',title:'Done',isDone:true}]},
      {id:'board_lab',name:'Лаборатория',
       columns:[{id:'col_todo',title:'To Do',isDone:false}]}
    ],
    _tasksByBoard: { board_prod: [], board_lab: [] }
  },
  parseQuick: function(input) {
    return {
      title: input.replace(/\s+завтра$/, '').trim(),
      deadline: input.endsWith(' завтра') ? '2026-11-20' : '',
      priority:'none'
    };
  },
  todayISO: () => '2026-11-19',
  document: {},
  console
};
vm.runInNewContext(source, sandbox, {filename:'assistant.js'});
const expression = src => vm.runInNewContext(src, sandbox);

const plan1 = expression("comradeBasic('Добавь задачу проверить электроды завтра')");
assert.equal(plan1.action,'create');
assert.equal(plan1.title,'проверить электроды');
assert.equal(plan1.deadline,'2026-11-20');
assert.equal(plan1.board,'Производство');

const plan2 = expression("comradeBasic('Покажи просроченные задачи')");
assert.equal(plan2.action,'list');
assert.equal(plan2.filter,'overdue');

const plan3 = expression("comradeBasic('Закрой задачу подготовить отчёт')");
assert.equal(plan3.action,'complete');
assert.equal(plan3.task,'подготовить отчёт');

const plan4 = expression("comradeBasic('Как организовать работу команды?')");
assert.equal(plan4,null);
const sub = expression("comradeBasic('Создай подзадачу проверить упаковку к задаче провести аудит')");
assert.equal(sub.action, 'subtask');
assert.equal(sub.task, 'провести аудит');
assert.equal(sub.title, 'проверить упаковку');

const change = expression("comradeBasic('Поставь приоритет задачи подготовить отчёт на высокий')");
assert.equal(change.action, 'update');
assert.equal(change.task, 'подготовить отчёт');
assert.equal(change.priority, 'high');

const rated = expression("comradeBasic('Добавь задачу проверить электроды завтра высокий приоритет')");
assert.equal(rated.action, 'create');
assert.equal(rated.priority, 'high');
assert.equal(rated.deadline, '2026-11-20');

const found = expression("comradeBasic('Найди задачу электроды')");
assert.equal(found.action, 'search');
assert.equal(found.query, 'электроды');

console.log('Comrade command parser: 8 checks passed.');

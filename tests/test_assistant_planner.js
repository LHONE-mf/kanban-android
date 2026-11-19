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
       columns:[{id:'col_todo',title:'To Do',isDone:false}]},
      {id:'board_daily',name:'Текучка',
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
  isValidISODate: s => {
    if (!s) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [year,month,day]=s.split('-').map(Number);
    const date=new Date(year,month-1,day);
    return date.getFullYear()===year && date.getMonth()===month-1 && date.getDate()===day;
  },
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

console.log('Comrade command parser: 8 existing checks passed.');

// Regression: the requested due date must be written into deadline, not the title.
const dueFriday = expression("comradeBasic('Добавь задачу проверить электроды до пятницы, высокий приоритет')");
assert.equal(dueFriday.action,'create');
assert.equal(dueFriday.title,'проверить электроды');
assert.equal(dueFriday.deadline,'2026-11-20');
assert.equal(dueFriday.priority,'high');

const dueNovember = expression("comradeBasic('Создай задачу подготовить отчёт к 25 ноября на доску Производство')");
assert.equal(dueNovember.title,'подготовить отчёт');
assert.equal(dueNovember.deadline,'2026-11-25');
assert.equal(dueNovember.board,'Производство');

const numericDate = expression("comradeBasic('Создай задачу оформить документы до 25.11.2026 с высоким приоритетом')");
assert.equal(numericDate.title,'оформить документы');
assert.equal(numericDate.priority,'high');
assert.equal(numericDate.deadline,'2026-11-25');

const isoDate = expression("comradeBasic('Добавь задачу сдать протокол к 2026-11-23')");
assert.equal(isoDate.title,'сдать протокол');
assert.equal(isoDate.deadline,'2026-11-23');

const nextDay = expression("comradeBasic('Добавь задачу закончить отчёт послезавтра')");
assert.equal(nextDay.title,'закончить отчёт');
assert.equal(nextDay.deadline,'2026-11-21');

const invalidDate = expression("comradeBasic('Добавь задачу срочная проверка к 31 февраля')");
assert.equal(invalidDate.action,'answer');
assert.match(invalidDate.text,/дат[ауе]|срок/i);

const unclearDate = expression("comradeBasic('Создай задачу провести аудит до конца недели')");
assert.equal(unclearDate.action,'answer');
assert.match(unclearDate.text,/дат[ауе]|срок/i);

const noDate = expression("comradeBasic('Создай задачу купить перчатки')");
assert.equal(noDate.title,'купить перчатки');
assert.equal(noDate.deadline,'');
assert.equal(noDate.priority,'none');

console.log('Comrade date and priority regression: 8 checks passed.');


// Screenshot regression: date and board are separate structured task fields.
const discharge = expression("comradeBasic('Добавь задачу обработать результаты разряда на 8С образцов из СИМБЫ, дата 19.11.2026, текучка')");
assert.equal(discharge.action, 'create');
assert.equal(discharge.title, 'обработать результаты разряда на 8С образцов из СИМБЫ');
assert.equal(discharge.deadline, '2026-11-19');
assert.equal(discharge.board, 'Текучка');
assert.equal(discharge.priority, 'none');

const explicitBoard = expression("comradeBasic('Создай задачу проверить электрохимию, на доску Текучка, дата: 21.11.2026')");
assert.equal(explicitBoard.title, 'проверить электрохимию');
assert.equal(explicitBoard.board, 'Текучка');
assert.equal(explicitBoard.deadline, '2026-11-21');

const invalidLabelDate = expression("comradeBasic('Добавь задачу проверить данные, дата 31.02.2026, текучка')");
assert.equal(invalidLabelDate.action, 'answer');

const noModelFields = expression("comradeParseCreate('Добавь задачу подготовить отчёт, дата 23.11.2026, Текучка')");
assert.equal(noModelFields.deadline, '2026-11-23');
assert.equal(noModelFields.title, 'подготовить отчёт');
console.log('Comrade structured input: labelled dates and board names passed.');


// The exact user screenshot: a short-year deadline and a board between clauses.
const screenshotShortYear = expression("comradeBasic('Добавь задачу обработать результаты разряда на 8С от СИМБЫ. Текучка, срок 19.11.26')");
assert.equal(screenshotShortYear.action, 'create');
assert.equal(screenshotShortYear.deadline, '2026-11-19');
assert.equal(screenshotShortYear.board, 'Текучка');
assert.equal(screenshotShortYear.title, 'обработать результаты разряда на 8С от СИМБЫ');

const twoDigitYearEnd = expression("comradeBasic('Добавь задачу проверить результаты, срок 19.11.26, Текучка')");
assert.equal(twoDigitYearEnd.deadline, '2026-11-19');
assert.equal(twoDigitYearEnd.title, 'проверить результаты');
assert.equal(twoDigitYearEnd.board, 'Текучка');

const prepositionShortYear = expression("comradeBasic('Добавь задачу передать отчёт до 21.11.26')");
assert.equal(prepositionShortYear.title, 'передать отчёт');
assert.equal(prepositionShortYear.deadline, '2026-11-21');

const slashShortYear = expression("comradeBasic('Создай задачу провести аудит к 21/11/26')");
assert.equal(slashShortYear.title, 'провести аудит');
assert.equal(slashShortYear.deadline, '2026-11-21');

const invalidShortYear = expression("comradeBasic('Добавь задачу проверка, срок 31.02.26, Текучка')");
assert.equal(invalidShortYear.action, 'answer');
assert.match(invalidShortYear.text, /дат[ауе]|срок/i);

const explicitShortYearPast = expression("comradeBasic('Добавь задачу найти журнал, срок 17.11.25')");
assert.equal(explicitShortYearPast.deadline, '2025-11-17');

console.log('Comrade short-year deadlines and board clauses: six regression cases passed.');


// Natural language requests for the day plan bypass the slow local model.
const allDay = expression("comradeBasic('Составь план на сегодня по всем доскам')");
assert.equal(allDay.action,'plan_day');
const showDay = expression("comradeBasic('Покажи мой день')");
assert.equal(showDay.action,'plan_day');
const openDay = expression("comradeBasic('Открой план на сегодня')");
assert.equal(openDay.action,'plan_day');
const listToday = expression("comradeBasic('Покажи задачи на сегодня')");
assert.equal(listToday.action,'list');
console.log('Comrade daily plan intent: 4 checks passed.');

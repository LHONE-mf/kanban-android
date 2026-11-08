// Exercise the actual newQuestion handler with failed and successful storage writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('app/src/main/assets/japanese.html', 'utf8');
const start = html.indexOf('function newQuestion(){');
const end = html.indexOf('\nfunction answer(button,roman){', start);
assert(start >= 0 && end > start, 'newQuestion handler not found');
const items = [
  {kana:'あ',roman:'a'}, {kana:'い',roman:'i'},
  {kana:'う',roman:'u'}, {kana:'え',roman:'e'}, {kana:'お',roman:'o'}
];
const elements = {
  quizKana: {textContent:''}, feedback: {textContent:'old'},
  nextQuestion: {disabled:false},
  choices: {replaceChildren(...children){this.children=children},children:[]},
  score: {textContent:''}
};
let fail = true, saveCalls = 0;
const context = {
  recentQuestions:['い'], lastQuizScript:'hiragana', script:'hiragana',
  question:items[1], answered:true, quizTurn:4,
  mistakeQueue:[{kana:'あ',due:3}], known:new Set(),
  score:2,total:3,
  allKana:()=>[{items}],
  shuffle:arr=>arr.slice(),
  saveQuizProgress:()=>{saveCalls++;return !fail},
  $:id=>elements[id],
  document:{createElement:()=>({textContent:'',onclick:null})},
};
vm.createContext(context);
vm.runInContext(html.slice(start,end),context);
const run=()=>vm.runInContext('newQuestion()',context);
run();
assert.equal(saveCalls,1);
assert.equal(context.quizTurn,4);
assert.equal(context.question.kana,'い');
assert.equal(context.answered,true);
assert.deepEqual(Array.from(context.recentQuestions),['い']);
assert.deepEqual(JSON.parse(JSON.stringify(context.mistakeQueue)),[{kana:'あ',due:3}]);
assert.equal(elements.quizKana.textContent,'');
assert.equal(elements.feedback.textContent,'old');
fail=false;
run();
assert.equal(saveCalls,2);
assert.equal(context.quizTurn,5);
assert.equal(context.question.kana,'あ');
assert.equal(context.answered,false);
assert.equal(context.mistakeQueue.length,0);
assert.equal(elements.quizKana.textContent,'あ');
assert.equal(elements.choices.children.length,4);
assert.equal(elements.nextQuestion.disabled,true);
console.log('Japanese quiz new-question persistence rollback and retry: passed');

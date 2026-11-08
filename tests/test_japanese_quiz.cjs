// Execute the real quiz answer handler with a failing localStorage mock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('app/src/main/assets/japanese.html', 'utf8');
function extract(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'Quiz handler not found');
  return html.slice(a, b);
}
const source = extract('function saveQuizProgress(){', "\nwindow.addEventListener('pageshow'") +
  extract('function answer(button,roman){', "\n$('nextQuestion').onclick=");
const saved = new Map();
let failWrites = true, alerts = 0;
const elements = {
  feedback: { textContent: '' },
  choices: { children: [] },
  score: { textContent: '' },
  nextQuestion: { disabled: true }
};
const context = {
  quizProgressKey: 'quiz-progress-test',
  score: 0, total: 0, recentQuestions: [], lastQuizScript: 'hiragana',
  quizTurn: 1, mistakeQueue: [], answered: false,
  question: { kana: 'あ', roman: 'a' },
  localStorage: { setItem(k,v) { if (failWrites) throw Error('storage unavailable'); saved.set(k,v); } },
  console: { error() {} }, alert() { alerts++; },
  $: id => elements[id]
};
const correct = { textContent: 'a', disabled: false, classList: { add() {} } };
const wrong = { textContent: 'i', disabled: false, classList: { add() {} } };
elements.choices.children = [correct, wrong];
vm.createContext(context);
vm.runInContext(source, context);
const answer = (button, roman) => { context.button = button; context.roman = roman; vm.runInContext('answer(button,roman)', context); };
answer(wrong, 'i');
assert.equal(context.answered, false);
assert.equal(context.score, 0);
assert.equal(context.total, 0);
assert.equal(context.mistakeQueue.length, 0);
assert.equal(wrong.disabled, false);
assert.equal(elements.nextQuestion.disabled, true);
assert.equal(alerts, 1);
failWrites = false;
answer(correct, 'a');
assert.equal(context.answered, true);
assert.equal(context.score, 1);
assert.equal(context.total, 1);
assert.equal(correct.disabled, true);
assert.equal(elements.nextQuestion.disabled, false);
assert.equal(JSON.parse(saved.get(context.quizProgressKey)).score, 1);
console.log('Japanese quiz answer rollback and retry: passed');

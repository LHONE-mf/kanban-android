// Regression for the actual spaced-repetition grading handler.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('app/src/main/assets/japanese.html', 'utf8');
const start = html.indexOf('function grade(remembered){');
const end = html.indexOf("\n$('again').onclick=", start);
assert(start >= 0 && end > start, 'Review grading implementation not found');
const source = html.slice(start, end);
const storage = new Map();
let failWrites = false;
let alerts = 0;
let advanced = 0;
const context = {
  reviewItem: { kana: 'あ' },
  reviews: {},
  reviewKey: 'kanban-japanese-review-v1',
  Date: { now: () => 1000000 },
  localStorage: { setItem(key, value) {
    if (failWrites) throw new Error('QuotaExceededError');
    storage.set(key, value);
  }},
  console: { error() {} },
  alert() { alerts++; },
  nextReview() { advanced++; }
};
vm.createContext(context);
vm.runInContext(source, context);
const grade = remembered => vm.runInContext('grade(' + remembered + ')', context);
failWrites = true;
grade(true);
assert.equal(Object.hasOwn(context.reviews, 'あ'), false);
assert.equal(advanced, 0);
assert.equal(alerts, 1);
failWrites = false;
grade(true);
assert.equal(context.reviews['あ'].interval, 1);
assert.equal(advanced, 1);
const saved = storage.get(context.reviewKey);
failWrites = true;
grade(false);
assert.equal(context.reviews['あ'].interval, 1);
assert.equal(storage.get(context.reviewKey), saved);
assert.equal(advanced, 1);
assert.equal(alerts, 2);
failWrites = false;
grade(false);
assert.equal(context.reviews['あ'].interval, 0);
assert.equal(advanced, 2);
console.log('Japanese spaced repetition save, rollback, and retry: passed');

// Compile the actual inline Japanese scripts before packaging the Android APK.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('app/src/main/assets/japanese.html', 'utf8');
const scripts = [...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)];
assert(scripts.length >= 2, 'Expected theme initialization and Japanese app scripts');
for (const [index, match] of scripts.entries()) {
  new vm.Script(match[1], { filename: 'japanese.html:inline-script-' + (index + 1) });
}
console.log('Japanese inline JavaScript syntax: passed (' + scripts.length + ' scripts)');

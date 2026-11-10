// Real overflow-menu behavior without emulator: mobile returns from pickers with a closed menu.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app/src/main/js-src/interactions.js','utf8');
const start=source.indexOf('function bindMobileActionsMenu() {');
const end=source.indexOf('function bindEvents() {',start);
assert(start>=0&&end>start,'Mobile action menu binder must exist');
assert(source.includes('function bindEvents() {\n  bindMobileActionsMenu();'),
  'The menu must be initialized during normal app startup');
let mobile=true,handler;
const menu={open:true,addEventListener:(type,cb)=>{assert.equal(type,'click');handler=cb}};
const context={
  window:{matchMedia:()=>({matches:mobile})},
  document:{querySelector:selector=>selector==='.mobile-actions'?menu:null}
};
vm.createContext(context);
vm.runInContext(source.slice(start,end),context);
context.bindMobileActionsMenu();
const click=(selector)=>handler({target:{closest:kind=>kind==='button'&&selector==='button'?{}:null}});
click('summary');
assert.equal(menu.open,true,'Tapping summary should not be intercepted');
click('button');
assert.equal(menu.open,false,'Clicking an action must close the mobile menu');
mobile=false;menu.open=true;click('button');
assert.equal(menu.open,true,'On desktop the header actions must stay accessible');
console.log('Mobile overflow menu closes after action without hiding desktop toolbar: passed');

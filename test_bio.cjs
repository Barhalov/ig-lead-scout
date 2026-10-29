const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/ig-lead-scout/laptop-profile.js', 'utf8');
async function test(label, expectedClick, route = '/test_user/') {
  let clicked = 0;
  const element = {innerText:label, getClientRects:()=>[{}], click(){clicked++;this.innerText='Полное описание Telegram: @test_contact';}};
  const header = {querySelectorAll:()=>[element], contains:()=>true};
  const context = {location:{pathname:route}, document:{querySelector:()=>header,documentElement:{}},
    setTimeout,clearTimeout,MutationObserver:class {observe(){} disconnect(){}}};
  vm.createContext(context); vm.runInContext(source, context);
  await context.laptopExpandBiography('test_user');
  assert.equal(clicked, expectedClick, label);
}
(async()=>{
  await test('ещё',1); await test('... ещё',1); await test('more',1);
  await test('и ещё 2',0); await test('Полный текст',0); await test('ещё',0,'/other_user/');
  console.log('Biography expansion: 6 tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

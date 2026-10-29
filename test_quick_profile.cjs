const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ctx = vm.createContext({URL, console});
vm.runInContext(fs.readFileSync(__dirname + '/ig-lead-scout/laptop-profile.js','utf8'),ctx);
for (const [text,expected] of [['3 017 подписчиков',3017],['13,2 тыс. подписчиков',13200],
 ['163K followers',163000],['1.2M followers',1200000],['3,017',3017],['0 подписчиков',0],['подписчики',null]]) {
  assert.equal(ctx.laptopCount(text),expected,text);
}
const precise = {innerText:'13,2 тыс. подписчиков',querySelector:()=>({getAttribute:()=> '13,245'})};
assert.equal(ctx.laptopHeaderFollowers({querySelectorAll:()=>[precise]}),13245);
assert.equal(ctx.laptopHeaderFollowers({querySelectorAll:()=>[],innerText:'137 публикаций 4 301 подписчиков 200 подписок'}),4301);
console.log('PASS: exact and abbreviated follower counts, title precision, unloaded header');

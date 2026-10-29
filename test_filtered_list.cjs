const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/ig-lead-scout/content.js','utf8');
const checkStart=source.indexOf('  async function afkCheckAll(dialog) {');
const checkEnd=source.indexOf('    const toCheck = [];',checkStart);
const pickStart=source.indexOf('  async function afkPickNext(dialog) {');
const pickEnd=source.indexOf('\n  async function afkPickNextMode',pickStart);
(async()=>{
 for(const value of ['', 'коуч', 'тренер',' ТРЕНЕР ']){
  let picked=0;const context={LAPTOP_MODE:true,afkFindSearchInput:()=>({value}),afkPickNextMode:async()=>{picked++;return {username:'test'};}};
  vm.createContext(context);vm.runInContext(source.slice(checkStart,checkEnd)+"return 'allowed';}\n"+source.slice(pickStart,pickEnd),context);
  const result=await context.afkCheckAll({});await context.afkPickNext({});
  const allowed=value.trim().toLowerCase()==='тренер';assert.equal(result==='allowed',allowed);assert.equal(picked>0,allowed);
 }
 console.log('Filtered candidate guards: 4 tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

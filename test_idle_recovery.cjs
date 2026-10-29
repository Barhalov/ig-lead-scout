const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/ig-lead-scout/content.js', 'utf8');
const start = source.indexOf('  async function afkBanIdleGuard(');
const end = source.indexOf('\n  // «Бесконечный» прогон', start);
(async () => {
  let stopped = false;
  let stored;
  const budget = {deadStreak: 12, idleRests: 2};
  const context = vm.createContext({Date, Number, String, Math,
    IDLE_DEAD_STREAK: 12, BLOCK_FRESH_MS: 1800000,
    afkPhaseKind: 'following',
    bud: () => budget, budSave: async () => {},
    afkIgBlockSignal: () => '', afkRiskLoad: async () => ({}),
    afkOwnerFromUrl: () => 'leokeymove',
    afkStop: async () => {stopped = true;},
    chrome: {storage: {local: {get: async () => ({}), set: async value => {stored = value;}}}}
  });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(await context.afkBanIdleGuard({infinite: true}, 0), '');
  assert.equal(stopped, false);
  assert.equal(budget.deadStreak, 0);
  assert.ok(stored.igx_unavailable_donors['leokeymove:following'] > Date.now());
  console.log('PASS: twelve lists without fresh checks do not pause or stop the stream');
})().catch(error => {console.error(error); process.exitCode = 1;});

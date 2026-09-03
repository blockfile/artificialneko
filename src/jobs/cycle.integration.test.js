'use strict';

// A whole cycle, end to end, against an in-memory MongoDB.
//
// The unit tests cover the pure decisions in isolation; this covers the thing
// that actually matters — that a claim becomes recorded payouts, that the
// amounts add up exactly, and that a dry run needs no network at all.

process.env.DRY_RUN = 'true';
process.env.REWARD_PCT = '65';
process.env.BURN_PCT = '25';
process.env.GAS_PCT = '10';
process.env.TOKEN_ADDRESS = '0x50d0d0da00ffd195d2d1d2448617ad039855ad2b';
process.env.TOKEN_SYMBOL = 'NEKO';
process.env.TOKEN_DECIMALS = '18';
process.env.MIN_HOLD = '100000';
process.env.WALLET_PRIVATE_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let db;
let repo;
let runCycle;
let simvault;
let config;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'artificialneko_cycle_test';
  for (const m of ['../config', '../db/index', '../db/repository', './cycle', '../evm/simvault']) {
    delete require.cache[require.resolve(m)];
  }
  config = require('../config');
  db = require('../db');
  repo = require('../db/repository');
  simvault = require('../evm/simvault');
  ({ runCycle } = require('./cycle'));
  await db.connect();
});

test.after(async () => {
  await db.close();
  await mongod.stop();
});

test('an empty vault completes as skipped, not as a failure', async () => {
  simvault.reset(0);
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'skipped');
  assert.strictEqual(cycle.note, 'nothing claimed');
  assert.strictEqual(cycle.quote_claimed, 0);
});

test('a funded vault claims, splits and airdrops to holders', async () => {
  simvault.reset(10); // 10 NVDA accrued
  const cycle = await runCycle();

  assert.strictEqual(cycle.status, 'complete', cycle.error || '');
  assert.strictEqual(cycle.quote_claimed, 10);
  assert.strictEqual(cycle.quote_distributed, 6.5, '65% goes to holders');
  assert.strictEqual(cycle.quote_burned, 2.5, '25% goes to the buyback');
  assert.strictEqual(cycle.quote_gas, 1, '10% is sold for gas');

  const names = cycle.steps.map((s) => s.name);
  // Gas comes BEFORE the airdrop: the airdrop sends one transaction per holder,
  // so the top-up has to land first or a cycle can run dry mid-payout.
  // reward-swap sits between the gas leg and the airdrop: holders are paid in
  // Artificial Inu, so a cycle must BUY the reward before it can distribute it.
  assert.deepStrictEqual(names, ['sweep', 'claim', 'gas', 'reward-swap', 'airdrop', 'buyback', 'dev']);

  const airdropStep = cycle.steps.find((s) => s.name === 'airdrop');
  assert.strictEqual(airdropStep.status, 'ok');
  assert.ok(airdropStep.detail.sent > 0, 'the simulated holders were paid');
});

test('the buyback buys NEKO with the burn share and destroys it', async () => {
  simvault.reset(10);
  const cycle = await runCycle();

  const buyback = cycle.steps.find((s) => s.name === 'buyback');
  assert.strictEqual(buyback.status, 'ok');
  assert.strictEqual(buyback.detail.quoteSpent, 2.5, '25% of a 10 NVDA claim');
  assert.strictEqual(buyback.detail.bought, true);
  assert.strictEqual(buyback.detail.burned, true);
  assert.ok(buyback.detail.tokensBought > 0);
  assert.ok(cycle.tokens_burned > 0, 'the burned amount is recorded on the cycle');
});

test('the buyback is NOT a holder payout and never reaches the rewards feed', async () => {
  simvault.reset(10);
  const cycle = await runCycle();
  const air = await db.getDb().collection('airdrops').find({ cycle_id: cycle.id }).toArray();
  // Holders are paid the SAME asset the fees arrive in, so the reward share is
  // handed over as-is: no swap, and nothing lost to a fee or slippage on the way.
  const paid = air.reduce((s, r) => s + (r.amount_ui || 0), 0);
  assert.ok(Math.abs(paid - 6.5) < 1e-9, 'holders got the 65%, with the burn and gas shares excluded');
});

test('with BURN_PCT and GAS_PCT at 0, holders take everything', async () => {
  process.env.REWARD_PCT = '100';
  process.env.BURN_PCT = '0';
  process.env.GAS_PCT = '0';
  for (const m of ['../config', '../evm/buyback', '../evm/devpayout', './cycle']) {
    delete require.cache[require.resolve(m)];
  }
  const { runCycle: run } = require('./cycle');

  simvault.reset(10);
  const cycle = await run();
  const buyback = cycle.steps.find((s) => s.name === 'buyback');
  assert.strictEqual(buyback.status, 'skipped');
  assert.strictEqual(cycle.quote_distributed, 10, 'all of it to holders');
  assert.strictEqual(cycle.status, 'complete');

  process.env.REWARD_PCT = '65';
  process.env.BURN_PCT = '25';
  process.env.GAS_PCT = '10';
  for (const m of ['../config', '../evm/buyback', '../evm/devpayout', './cycle']) {
    delete require.cache[require.resolve(m)];
  }
});

test('with no DEV_PAYOUT_ADDRESS the dev cut is skipped, not failed', async () => {
  simvault.reset(10);
  const cycle = await runCycle();
  const dev = cycle.steps.find((s) => s.name === 'dev');
  assert.strictEqual(dev.status, 'skipped');
  assert.match(dev.detail.reason, /not set/);
  assert.strictEqual(cycle.status, 'complete', 'an unconfigured dev payout must not fail the cycle');
});

test('a dev remainder is forwarded, and stays out of the public feed', async () => {
  // A dev cut only exists when the three configured legs fall under 100, so
  // this case needs a split that leaves one — at the default 65/25/10 there is
  // nothing to forward, which the preceding test covers.
  process.env.REWARD_PCT = '60';
  process.env.BURN_PCT = '20';
  process.env.GAS_PCT = '10';
  process.env.DEV_PAYOUT_ADDRESS = '0xC8f686977655879f741f9AA693432081210774EF';
  const RELOAD = ['../config', '../evm/buyback', '../evm/devpayout', './cycle'];
  for (const m of RELOAD) delete require.cache[require.resolve(m)];
  const { runCycle: run } = require('./cycle');

  simvault.reset(10);
  const cycle = await run();

  const dev = cycle.steps.find((s) => s.name === 'dev');
  assert.strictEqual(dev.status, 'ok');
  assert.strictEqual(dev.detail.amount, 1, 'the 10% remainder of a 10 NVDA claim');
  assert.strictEqual(dev.detail.to, '0xc8f686977655879f741f9aa693432081210774ef');

  // The dev cut must never be recorded as a holder payout: it is not a reward,
  // and counting it would inflate totalRewarded and show up in /rewards.
  const air = await db.getDb().collection('airdrops').find({ cycle_id: cycle.id }).toArray();
  assert.ok(
    !air.some((r) => String(r.recipient).toLowerCase() === '0xc8f686977655879f741f9aa693432081210774ef'),
    'the dev address must not appear in the airdrop ledger'
  );
  const paid = air.reduce((s, r) => s + (r.amount_ui || 0), 0);
  assert.ok(Math.abs(paid - 6) < 1e-9, 'holders were paid exactly the 60%');
  assert.strictEqual(cycle.quote_burned, 2, 'and the buyback still took its 20%');
  assert.strictEqual(cycle.quote_gas, 1, 'and the gas leg its 10%');

  process.env.REWARD_PCT = '65';
  process.env.BURN_PCT = '25';
  process.env.GAS_PCT = '10';
  process.env.DEV_PAYOUT_ADDRESS = '';
  for (const m of RELOAD) delete require.cache[require.resolve(m)];
});

test('the gas leg sells its share for ETH before the airdrop spends any', async () => {
  simvault.reset(10);
  const cycle = await runCycle();

  const gas = cycle.steps.find((s) => s.name === 'gas');
  assert.strictEqual(gas.status, 'ok');
  assert.strictEqual(gas.detail.quoteSpent, 1, '10% of a 10 NVDA claim');
  assert.ok(gas.detail.ethReceived > 0, 'it returned ETH');
  assert.ok(cycle.eth_received > 0, 'and the cycle recorded it');

  const names = cycle.steps.map((s) => s.name);
  assert.ok(names.indexOf('gas') < names.indexOf('airdrop'), 'gas must land before the payouts');
});

test('the vault is drained by the claim, so the next cycle finds nothing', async () => {
  simvault.reset(5);
  await runCycle();
  assert.strictEqual(simvault.peek(), 0, 'claiming empties the escrow');
  const next = await runCycle();
  assert.strictEqual(next.status, 'skipped');
});

test('recorded payouts sum EXACTLY to the amount distributed — no dust', async () => {
  simvault.reset(3.7); // deliberately not a round number
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'complete', cycle.error || '');

  const { rows } = await repo.getAirdropPage(500, null);
  const mine = rows.filter((r) => r.cycle_id === cycle.id);
  // DRY_RUN payouts carry a fabricated signature, so they are correctly absent
  // from the public page. Read them straight from the collection instead.
  assert.strictEqual(mine.length, 0, 'simulated payouts must never reach the public feed');

  const all = await db.getDb().collection('airdrops').find({ cycle_id: cycle.id }).toArray();
  assert.ok(all.length > 0, 'the payouts were still recorded for the operator');

  // Allocations must sum to the distributed amount exactly - no dust left
  // behind, and nothing allocated that was never claimed.
  const decimals = config.rewardDecimals;
  const totalRaw = all.reduce((sum, r) => sum + BigInt(r.amount_raw), 0n);
  const expectedRaw = BigInt(Math.round(3.7 * 0.65 * 10 ** 9)) * 10n ** BigInt(decimals - 9);
  assert.strictEqual(totalRaw, expectedRaw, 'allocations must sum to the distributed amount exactly');
});

test('a dry run makes no network call — it completed with no RPC reachable', async () => {
  // The preceding tests all ran with DRY_RUN=true and no RPC available. If any
  // path had reached for the chain (decimals(), balanceOf(), getBalance()) they
  // would have hung or thrown rather than completing.
  assert.strictEqual(config.dryRun, true);
  simvault.reset(1);
  const cycle = await runCycle();
  assert.notStrictEqual(cycle.status, 'failed', cycle.error || '');
});

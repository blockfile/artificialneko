'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { shouldFire } = require('./scheduler');

const GATE = { triggerMode: 'accumulation', claimEveryUsd: 100 };

test('fires once the claimable NVDA is worth the threshold', () => {
  const out = shouldFire({ claimableQuote: 1, priceUsd: 150, ...GATE });
  assert.strictEqual(out.fire, true);
  assert.strictEqual(out.usd, 150);
});

test('fires exactly at the threshold, not just above it', () => {
  assert.strictEqual(shouldFire({ claimableQuote: 2, priceUsd: 50, ...GATE }).fire, true);
});

test('holds below the threshold and says how far short it is', () => {
  const out = shouldFire({ claimableQuote: 0.1, priceUsd: 150, ...GATE });
  assert.strictEqual(out.fire, false);
  assert.match(out.reason, /below/);
  assert.strictEqual(out.usd, 15);
});

test('HOLDS when the price is unavailable — a missing price must not trigger a claim', () => {
  // Firing blind would empty the escrow at an unknown value and pay gas for it.
  // The fees are not lost by waiting: they keep accruing for the next tick.
  const out = shouldFire({ claimableQuote: 100, priceUsd: null, ...GATE });
  assert.strictEqual(out.fire, false);
  assert.match(out.reason, /price/i);
  assert.strictEqual(out.usd, null);
});

test('a zero or nonsense price is treated as unavailable, not as free', () => {
  assert.strictEqual(shouldFire({ claimableQuote: 100, priceUsd: 0, ...GATE }).fire, false);
  assert.strictEqual(shouldFire({ claimableQuote: 100, priceUsd: NaN, ...GATE }).fire, false);
  assert.strictEqual(shouldFire({ claimableQuote: 100, priceUsd: -5, ...GATE }).fire, false);
  assert.strictEqual(shouldFire({ claimableQuote: 100, priceUsd: '150', ...GATE }).fire, false);
});

test('holds when nothing is claimable, whatever the price', () => {
  assert.strictEqual(shouldFire({ claimableQuote: 0, priceUsd: 150, ...GATE }).fire, false);
  assert.strictEqual(shouldFire({ claimableQuote: -1, priceUsd: 150, ...GATE }).fire, false);
});

test('interval mode fires on any positive balance and needs no price at all', () => {
  const out = shouldFire({ claimableQuote: 0.0001, priceUsd: null, triggerMode: 'interval', claimEveryUsd: 100 });
  assert.strictEqual(out.fire, true);
});

test('interval mode still holds when there is nothing to claim', () => {
  const out = shouldFire({ claimableQuote: 0, priceUsd: 150, triggerMode: 'interval', claimEveryUsd: 100 });
  assert.strictEqual(out.fire, false);
});

// ── pollOnce: the gate wired up ────────────────────────────────────────────
// shouldFire being right is not enough — what matters is that a thrown price
// lookup actually stops a cycle rather than escaping as an unhandled rejection
// or falling through to a claim.

const { pollOnce, _resetState } = require('./scheduler');

const deps = (over = {}) => ({
  dryRun: false,
  tokenAddress: '0xtoken',
  triggerMode: 'accumulation',
  claimEveryUsd: 100,
  getLaunch: async () => ({ graduated: true }),
  escrowBalanceQuote: async () => 1,
  sweepableQuote: async () => 0,
  getQuotePrice: async () => ({ priceUsd: 150 }),
  ...over,
});

test('pollOnce runs a cycle once the threshold is met', async () => {
  _resetState();
  let ran = 0;
  const out = await pollOnce('test', deps({ runCycle: async () => { ran += 1; return { id: 1, status: 'complete' }; } }));
  assert.strictEqual(ran, 1);
  assert.strictEqual(out.ran, true);
  assert.strictEqual(out.usd, 150);
});

test('pollOnce does NOT run a cycle when the price lookup throws', async () => {
  _resetState();
  let ran = 0;
  const out = await pollOnce(
    'test',
    deps({
      getQuotePrice: async () => {
        throw new Error('DexScreener down');
      },
      runCycle: async () => {
        ran += 1;
        return { id: 1, status: 'complete' };
      },
    })
  );
  assert.strictEqual(ran, 0, 'a missing price must never result in a claim');
  assert.strictEqual(out.ran, false);
  assert.match(out.reason, /price/i);
});

test('pollOnce does not run a cycle below the threshold', async () => {
  _resetState();
  let ran = 0;
  const out = await pollOnce(
    'test',
    deps({
      escrowBalanceQuote: async () => 0.1, // 0.1 * 150 = $15
      runCycle: async () => { ran += 1; return { id: 1, status: 'complete' }; },
    })
  );
  assert.strictEqual(ran, 0);
  assert.strictEqual(out.ran, false);
  assert.match(out.reason, /below/);
});

test('pollOnce counts unswept fees, not just the escrow balance', async () => {
  // Gating on the escrow alone deadlocks: before the first sweep it is zero
  // while the fees sit on the hook, so the bot would never fire and so never
  // sweep. 0 in escrow + 1 sweepable at $150 must clear a $100 gate.
  _resetState();
  let ran = 0;
  const out = await pollOnce(
    'test',
    deps({
      escrowBalanceQuote: async () => 0,
      sweepableQuote: async () => 1,
      runCycle: async () => { ran += 1; return { id: 1, status: 'complete' }; },
    })
  );
  assert.strictEqual(ran, 1, 'unswept fees must count toward the trigger');
  assert.strictEqual(out.claimable, 1);
});

test('pollOnce refuses to start a second concurrent cycle', async () => {
  _resetState();
  let started = 0;
  let release;
  const blocked = new Promise((r) => {
    release = r;
  });
  const d = deps({
    runCycle: async () => {
      started += 1;
      await blocked;
      return { id: 1, status: 'complete' };
    },
  });

  const first = pollOnce('test', d);
  const second = await pollOnce('test', d); // lands while the first is mid-cycle
  assert.strictEqual(second.ran, false);
  assert.match(second.reason, /already running/);

  release();
  await first;
  assert.strictEqual(started, 1, 'only one cycle may hold the wallet nonce');
});

test('a paused scheduler runs nothing at all', async () => {
  _resetState();
  const { pause, resume } = require('./scheduler');
  pause();
  let ran = 0;
  const out = await pollOnce('test', deps({ runCycle: async () => { ran += 1; return {}; } }));
  assert.strictEqual(ran, 0);
  assert.strictEqual(out.reason, 'paused');
  resume();
});

test('a manual DRY_RUN trigger accrues BEFORE running the cycle', async () => {
  // Without this, POST /run always met an empty vault and stopped at
  // "nothing claimed" — never exercising the airdrop or the buyback, which are
  // the legs an operator actually wants to rehearse.
  //
  // There is no database in this test, so runCycle throws at createCycle and
  // never reaches the claim that would drain the vault. What is left in the
  // vault is therefore exactly what triggerNow accrued.
  _resetState();
  const config = require('../config');
  const simvault = require('../evm/simvault');
  simvault.reset(0);

  const { triggerNow } = require('./scheduler');
  await triggerNow().catch(() => {});

  assert.strictEqual(
    simvault.peek(),
    config.dryRunFeePerPoll,
    'the vault holds one tick of simulated fees, accrued before the cycle ran'
  );
});

test('a live trigger does NOT accrue — the escrow fills from real fees', async () => {
  process.env.DRY_RUN = 'false';
  process.env.WALLET_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
  for (const m of ['../config', '../evm/provider', '../evm/simvault', './cycle', './scheduler']) {
    delete require.cache[require.resolve(m)];
  }
  const simvault = require('../evm/simvault');
  const { triggerNow, _resetState: reset } = require('./scheduler');
  reset();
  simvault.reset(0);

  await triggerNow().catch(() => {});
  assert.strictEqual(simvault.peek(), 0, 'a live run must never invent fees');

  process.env.DRY_RUN = 'true';
  process.env.WALLET_PRIVATE_KEY = '';
  for (const m of ['../config', '../evm/provider', '../evm/simvault', './cycle', './scheduler']) {
    delete require.cache[require.resolve(m)];
  }
});

test('the bar shows what can trigger a payout; locked fees ride alongside it', async () => {
  // The bar answers "how close is the next payout", so it must show what could
  // actually trigger one. Counting locked fees there filled it to 100% while
  // the bot was still waiting on a sweep, and the site announced "BUYING $AI"
  // when nothing was imminent. What is accrued but unreachable is reported
  // separately, so it can be shown honestly rather than hidden or over-claimed.
  const { pollOnce, _resetState } = require('./scheduler');
  _resetState();

  const recorded = [];
  const repo = require('../db/repository');
  const realSet = repo.setDistributionState;
  repo.setDistributionState = async (patch) => { recorded.push(patch); };

  try {
    const res = await pollOnce('test', {
      dryRun: false,
      tokenAddress: '0xtoken',
      getLaunch: async () => ({ graduated: true, poolId: '0xpool', token: '0xtoken' }),
      escrowBalanceQuote: async () => 0,        // nothing claimable
      sweepableQuote: async () => 0,            // locked by the operator
      pendingCreditQuote: async () => 0.340607, // but this much HAS accrued
      getQuotePrice: async () => ({ priceUsd: 141.42 }),
      triggerMode: 'accumulation',
      claimEveryUsd: 100,
      runCycle: async () => { throw new Error('must not fire on unreachable money'); },
    });

    assert.strictEqual(res.ran, false, 'the gate must NOT fire: nothing is claimable');
    const gauge = recorded[recorded.length - 1];
    assert.strictEqual(gauge.collectedQuote, 0, 'the bar shows only what is claimable');
    assert.strictEqual(gauge.collectedUsd, 0);
    assert.ok(gauge.accruedUsd > 47, `the accrual is still reported, got ${gauge.accruedUsd}`);
    assert.ok(gauge.pendingSweepUsd > 47, `and named as awaiting a sweep, got ${gauge.pendingSweepUsd}`);
  } finally {
    repo.setDistributionState = realSet;
    _resetState();
  }
});

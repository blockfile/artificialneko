'use strict';

process.env.DRY_RUN = 'true';
process.env.API_KEY = 'test-key';

const test = require('node:test');
const assert = require('node:assert');
const { buildStatus } = require('./operator');

test('status reports the scheduler gate and the fee-recipient check', () => {
  const out = buildStatus({
    scheduler: { paused: false, isRunning: false, lastClaimable: 2, lastPriceUsd: 150, lastClaimableUsd: 300 },
    feeCheck: { ok: true, expected: '0xabc', actual: '0xabc', at: 'now' },
    walletAddress: '0xabc',
    ethBalance: 0.5,
  });
  assert.strictEqual(out.feeRecipientOk, true);
  assert.strictEqual(out.claimableUsd, 300);
  assert.strictEqual(out.claimableQuote, 2);
  assert.strictEqual(out.wallet.ethBalance, 0.5);
});

test('an unrun bot reports feeRecipientOk as null, not false', () => {
  // null means "no cycle has checked yet"; false means "the launch pays someone
  // else". Collapsing them would turn a cold start into a false alarm.
  const out = buildStatus({ scheduler: {}, feeCheck: null, walletAddress: '0xabc', ethBalance: null });
  assert.strictEqual(out.feeRecipientOk, null);
  assert.strictEqual(out.creatorFeeRecipient, null);
});

test('a mismatched fee recipient is reported as false with the address found', () => {
  const out = buildStatus({
    scheduler: {},
    feeCheck: { ok: false, expected: '0xus', actual: '0xdistributor', at: 'now' },
    walletAddress: '0xus',
    ethBalance: 1,
  });
  assert.strictEqual(out.feeRecipientOk, false);
  assert.strictEqual(out.creatorFeeRecipient, '0xdistributor');
});

test('status reports every share of the split, so they add to 100', () => {
  const out = buildStatus({ scheduler: {}, feeCheck: null, walletAddress: '0xabc', ethBalance: 1 });
  const { rewardPct, burnPct, gasPct, devPct } = out.split;
  for (const [name, v] of Object.entries({ rewardPct, burnPct, gasPct, devPct })) {
    assert.strictEqual(typeof v, 'number', `${name} must be reported`);
  }
  assert.strictEqual(rewardPct + burnPct + gasPct + devPct, 100);
});

test('status surfaces the gas reserve alongside the balance it guards', () => {
  const out = buildStatus({ scheduler: {}, feeCheck: null, walletAddress: '0xabc', ethBalance: 0.001 });
  assert.strictEqual(out.wallet.ethBalance, 0.001);
  assert.ok(typeof out.wallet.gasReserveEth === 'number', 'the threshold must be visible next to the balance');
});

test('an unknown claimable reads as null rather than zero', () => {
  const out = buildStatus({ scheduler: {}, feeCheck: null, walletAddress: '0xabc', ethBalance: null });
  assert.strictEqual(out.claimableQuote, null);
  assert.strictEqual(out.claimableUsd, null);
  assert.strictEqual(out.nvdaPriceUsd, null);
});

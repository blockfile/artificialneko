'use strict';

const test = require('node:test');
const assert = require('node:assert');

// config reads process.env at require time, so each case re-requires it.
//
// The keys below are CLEARED before each case rather than merely overridden.
// Without that, a case asserting a rejected value leaves that value in the
// environment and every later case inherits it — which showed up as three
// unrelated tests failing after a split-validation test was added.
const OWNED = [
  'REWARD_PCT', 'BURN_PCT', 'GAS_PCT', 'TRIGGER_MODE', 'CLAIM_EVERY_USD', 'DEV_PAYOUT_ADDRESS',
  'POLL_SCHEDULE', 'TRIGGER_SCHEDULE',
];

function loadConfig(env = {}) {
  for (const k of OWNED) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve('./config')];
  return require('./config');
}

test('the default 65/25/10 split leaves no dev cut at all', () => {
  const config = loadConfig({ DRY_RUN: 'true' });
  assert.strictEqual(config.rewardPct, 65);
  assert.strictEqual(config.burnPct, 25);
  assert.strictEqual(config.gasPct, 10);
  assert.strictEqual(config.devPct, 0);
});

test('the dev cut is whatever the other three legs leave behind', () => {
  const config = loadConfig({ REWARD_PCT: '60', BURN_PCT: '20', GAS_PCT: '10', DRY_RUN: 'true' });
  assert.strictEqual(config.devPct, 10);
});

test('a fractional split leaves no floating-point dust in the dev cut', () => {
  const config = loadConfig({ REWARD_PCT: '80.1', BURN_PCT: '0', GAS_PCT: '0', DRY_RUN: 'true' });
  assert.strictEqual(config.devPct, 19.9); // not 19.900000000000006
});

test('an out-of-range split is rejected outright', () => {
  assert.throws(() => loadConfig({ REWARD_PCT: '140', BURN_PCT: '0', GAS_PCT: '0', DRY_RUN: 'true' }), /REWARD_PCT/);
  assert.throws(() => loadConfig({ REWARD_PCT: '10', BURN_PCT: '140', GAS_PCT: '0', DRY_RUN: 'true' }), /BURN_PCT/);
});

test('legs that together exceed the claim are refused', () => {
  // Otherwise the bot would try to spend more than it claimed and the dev
  // remainder would silently go negative.
  assert.throws(
    () => loadConfig({ REWARD_PCT: '80', BURN_PCT: '30', GAS_PCT: '0', DRY_RUN: 'true' }),
    /exceeds 100/
  );
  assert.throws(
    () => loadConfig({ REWARD_PCT: '65', BURN_PCT: '25', GAS_PCT: '20', DRY_RUN: 'true' }),
    /exceeds 100/
  );
  assert.throws(
    () => loadConfig({ GAS_PCT: '140', DRY_RUN: 'true' }),
    /GAS_PCT/
  );
});

test('the trigger defaults to a 100 USD accumulation gate', () => {
  // No split overrides here — this case is about the trigger, and pinning a
  // REWARD_PCT that no longer fits the other defaults made it fail on the split.
  const config = loadConfig({ DRY_RUN: 'true' });
  assert.strictEqual(config.triggerMode, 'accumulation');
  assert.strictEqual(config.claimEveryUsd, 100);
});

test('an unknown TRIGGER_MODE falls back to accumulation rather than throwing', () => {
  const config = loadConfig({ TRIGGER_MODE: 'nonsense', DRY_RUN: 'true' });
  assert.strictEqual(config.triggerMode, 'accumulation');
});

test('DRY_RUN generates an ephemeral wallet when no key is set', () => {
  process.env.WALLET_PRIVATE_KEY = '';
  const config = loadConfig({ DRY_RUN: 'true' });
  assert.ok(config.wallet);
  assert.strictEqual(config.walletIsEphemeral, true);
});

test('a live run with no key is refused — on ACCESS, not on require', () => {
  // Requiring config must never throw: server.js requires it and signs
  // nothing, so an eager wallet lookup crash-looped the public API over a key
  // it does not use. The refusal still happens, just at the point of use.
  process.env.WALLET_PRIVATE_KEY = '';
  let config;
  assert.doesNotThrow(() => {
    config = loadConfig({ DRY_RUN: 'false' });
  }, 'requiring config must not need a wallet');
  assert.throws(() => config.wallet, /WALLET_PRIVATE_KEY/);
  process.env.DRY_RUN = 'true';
});

test('the wallet is not enumerable, so serialising config cannot trigger it', () => {
  // A spread or JSON.stringify of config elsewhere must not resolve the wallet
  // — and therefore must not throw — in a process that never wanted one.
  process.env.WALLET_PRIVATE_KEY = '';
  const config = loadConfig({ DRY_RUN: 'false' });
  assert.ok(!Object.keys(config).includes('wallet'));
  assert.doesNotThrow(() => JSON.stringify(config));
  process.env.DRY_RUN = 'true';
});

test('the poll looks every minute while the trigger only fires hourly', () => {
  // Two schedules, because the poll does two jobs: it writes the fee gauge the
  // site reads, and it decides whether to pay. Tying them together means either
  // a frozen gauge or an hourly payout, never both.
  const config = loadConfig({ DRY_RUN: 'true' });
  assert.strictEqual(config.pollSchedule, '* * * * *');
  assert.strictEqual(config.triggerSchedule, '0 * * * *');
});

test('the trigger cadence is an ordinary cron string, so any interval works', () => {
  // "Every 30 minutes" and "every 20 minutes" are the ones actually asked for.
  assert.strictEqual(loadConfig({ TRIGGER_SCHEDULE: '*/30 * * * *', DRY_RUN: 'true' }).triggerSchedule, '*/30 * * * *');
  assert.strictEqual(loadConfig({ TRIGGER_SCHEDULE: '*/20 * * * *', DRY_RUN: 'true' }).triggerSchedule, '*/20 * * * *');
});

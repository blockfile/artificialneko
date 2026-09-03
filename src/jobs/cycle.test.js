'use strict';

process.env.DRY_RUN = 'true';
process.env.REWARD_PCT = '65';
process.env.BURN_PCT = '25';
process.env.GAS_PCT = '10';

const test = require('node:test');
const assert = require('node:assert');
const { splitClaim, summarizeReward, isFeeRecipientOk, feeRecipientWarning } = require('./cycle');

test('65/25/10 leaves no dev cut', () => {
  const { rewardQuote, burnQuote, gasQuote, devQuote } = splitClaim(1);
  assert.strictEqual(rewardQuote, 0.65);
  assert.strictEqual(burnQuote, 0.25);
  assert.strictEqual(gasQuote, 0.1);
  assert.strictEqual(devQuote, 0, 'the dev cut is only what the other three leave');
});

test('the four legs always re-add to the claim', () => {
  for (const claimed of [0.000001, 0.5, 3.7, 1234.56789]) {
    const { rewardQuote, burnQuote, gasQuote, devQuote } = splitClaim(claimed);
    assert.ok(
      Math.abs(rewardQuote + burnQuote + gasQuote + devQuote - claimed) < 1e-9,
      `legs must sum for ${claimed}`
    );
  }
});

test('splitting nothing yields nothing on every leg', () => {
  assert.deepStrictEqual(splitClaim(0), { rewardQuote: 0, burnQuote: 0, gasQuote: 0, devQuote: 0 });
});

test('a dev cut appears only when the three configured legs leave one', () => {
  process.env.REWARD_PCT = '60';
  process.env.BURN_PCT = '20';
  process.env.GAS_PCT = '10';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
  const { splitClaim: split } = require('./cycle');

  const { rewardQuote, burnQuote, gasQuote, devQuote } = split(10);
  assert.strictEqual(rewardQuote, 6);
  assert.strictEqual(burnQuote, 2);
  assert.strictEqual(gasQuote, 1);
  assert.strictEqual(devQuote, 1);

  process.env.REWARD_PCT = '65';
  process.env.BURN_PCT = '25';
  process.env.GAS_PCT = '10';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
});

test('an all-to-holders split leaves nothing to burn or swap', () => {
  process.env.REWARD_PCT = '100';
  process.env.BURN_PCT = '0';
  process.env.GAS_PCT = '0';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
  const { splitClaim: split } = require('./cycle');
  assert.deepStrictEqual(split(5), { rewardQuote: 5, burnQuote: 0, gasQuote: 0, devQuote: 0 });

  process.env.REWARD_PCT = '65';
  process.env.BURN_PCT = '25';
  process.env.GAS_PCT = '10';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
});

test('the fee-recipient check is case-insensitive', () => {
  const launch = { creatorFeeRecipient: '0xABCDEF0000000000000000000000000000000001' };
  assert.strictEqual(isFeeRecipientOk(launch, '0xabcdef0000000000000000000000000000000001'), true);
});

test('a mismatched fee recipient produces a warning naming both addresses', () => {
  const launch = { creatorFeeRecipient: '0x1111111111111111111111111111111111111111' };
  const warning = feeRecipientWarning(launch, '0x2222222222222222222222222222222222222222');
  assert.match(warning, /0x1111111111111111111111111111111111111111/);
  assert.match(warning, /0x2222222222222222222222222222222222222222/);
});

test('the mismatch warning mentions the pons toggle that causes it', () => {
  // The overwhelmingly likely cause is someone switching on pons's
  // holder-fee-sharing, which reassigns creatorFeeRecipient to a distributor.
  // An operator reading this line at 3am should not have to go and find that out.
  const launch = { creatorFeeRecipient: '0x1111111111111111111111111111111111111111' };
  assert.match(feeRecipientWarning(launch, '0x2222222222222222222222222222222222222222'), /distributor|holders/i);
});

test('a matching fee recipient produces no warning at all', () => {
  const launch = { creatorFeeRecipient: '0xabc0000000000000000000000000000000000001' };
  assert.strictEqual(feeRecipientWarning(launch, '0xABC0000000000000000000000000000000000001'), null);
});

test('an unset fee recipient is a mismatch, not a pass', () => {
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: '' }, '0xabc'), false);
  assert.strictEqual(isFeeRecipientOk({}, '0xabc'), false);
  assert.strictEqual(isFeeRecipientOk(null, '0xabc'), false);
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: '0xabc' }, ''), false);
});

test('"nobody was eligible" completes and is not recorded as a failure', () => {
  const out = summarizeReward({ skipped: false, recipients: 0, sent: 0, failed: 0 });
  assert.strictEqual(out.status, 'complete');
  assert.match(out.note, /no eligible holders/);
});

test('"the airdrop reached nobody" is a failure, and says why', () => {
  const out = summarizeReward({ skipped: false, recipients: 40, sent: 0, failed: 40 });
  assert.strictEqual(out.status, 'failed');
  assert.match(out.error, /0 of 40/);
});

test('a partial airdrop completes but records the failures', () => {
  const out = summarizeReward({ skipped: false, recipients: 10, sent: 7, failed: 3 });
  assert.strictEqual(out.status, 'complete');
  assert.match(out.note, /7/);
  assert.match(out.note, /3 failed/);
});

test('a fully delivered airdrop is clean', () => {
  const out = summarizeReward({ skipped: false, recipients: 10, sent: 10, failed: 0 });
  assert.strictEqual(out.status, 'complete');
  assert.strictEqual(out.error, undefined);
});

test('a skipped reward leg completes and carries its reason', () => {
  const out = summarizeReward({ skipped: true, reason: 'reward share of this claim is zero' });
  assert.strictEqual(out.status, 'complete');
  assert.match(out.note, /zero/);
});

test('recording the fee-recipient check makes it readable without a cycle', () => {
  // The flag used to be set only inside runCycle, so between cycles the most
  // important operational signal reported null — on a quiet token, for hours.
  const { recordFeeRecipientCheck, getFeeRecipientCheck } = require('./cycle');

  const warning = recordFeeRecipientCheck(
    { creatorFeeRecipient: '0xAAA0000000000000000000000000000000000001' },
    '0xaaa0000000000000000000000000000000000001'
  );
  assert.strictEqual(warning, null, 'a matching recipient produces no warning');

  const check = getFeeRecipientCheck();
  assert.strictEqual(check.ok, true);
  assert.strictEqual(check.actual, '0xAAA0000000000000000000000000000000000001');
  assert.ok(typeof check.at === 'string');
});

test('a mismatch is recorded as ok:false with the address actually paid', () => {
  const { recordFeeRecipientCheck, getFeeRecipientCheck } = require('./cycle');
  const warning = recordFeeRecipientCheck(
    { creatorFeeRecipient: '0xdistributor' },
    '0xus'
  );
  assert.match(warning, /MISMATCH/);
  const check = getFeeRecipientCheck();
  assert.strictEqual(check.ok, false);
  assert.strictEqual(check.actual, '0xdistributor');
  assert.strictEqual(check.expected, '0xus');
});

test('the dev leg never goes negative on rounding', () => {
  // A live cycle logged "-1e-9 to dev": the remainder absorbs the rounding of
  // the other three legs and can dip below zero. Harmless while the payout is
  // skipped, but parseUnits would throw on it the day DEV_PAYOUT_ADDRESS is set.
  const { splitClaim } = require('./cycle');
  for (const claim of [0.7167010553398622, 1.0221684558296817, 0.7297212717303938, 4.033175952467068]) {
    const s = splitClaim(claim);
    assert.ok(s.devQuote >= 0, `dev leg went negative on ${claim}: ${s.devQuote}`);
    assert.ok(Object.is(s.devQuote, 0) || s.devQuote > 0, 'must not be -0 either');
  }
});

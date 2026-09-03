'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { describeOutcome } = require('./devpayout');

test('no configured address is a clean skip, not a failure', () => {
  const out = describeOutcome({ skipped: true, reason: 'DEV_PAYOUT_ADDRESS not set' });
  assert.match(out, /not set/);
});

test('a zero dev cut is a clean skip', () => {
  const out = describeOutcome({ skipped: true, reason: 'dev cut is zero' });
  assert.match(out, /zero/);
});

test('a sent payout reports the amount and destination', () => {
  const out = describeOutcome({ sent: true, amount: 2.5, to: '0xcold' });
  assert.match(out, /2\.5/);
  assert.match(out, /0xcold/);
});

test('a failed payout says the cut stayed in the wallet', () => {
  // Holders have already been paid by this point. The NVDA is still ours, just
  // in the hot wallet rather than the cold one — that must read as recoverable,
  // not as lost.
  const out = describeOutcome({ sent: false, error: 'insufficient funds' });
  assert.match(out, /insufficient funds/);
  assert.match(out, /wallet/i);
});

// ── config validation ──────────────────────────────────────────────────────

test('a malformed DEV_PAYOUT_ADDRESS is refused at startup, not at send time', () => {
  // Discovering this mid-cycle would mean the escrow was already claimed and
  // the holders already paid. Worse, a valid-looking typo would send the dev
  // cut somewhere unrecoverable on every future cycle.
  process.env.DEV_PAYOUT_ADDRESS = '0xnot-an-address';
  delete require.cache[require.resolve('../config')];
  assert.throws(() => require('../config'), /DEV_PAYOUT_ADDRESS/);

  process.env.DEV_PAYOUT_ADDRESS = '';
  delete require.cache[require.resolve('../config')];
});

test('a valid DEV_PAYOUT_ADDRESS is accepted and lowercased', () => {
  process.env.DEV_PAYOUT_ADDRESS = '0xC8f686977655879f741f9AA693432081210774EF';
  delete require.cache[require.resolve('../config')];
  const config = require('../config');
  assert.strictEqual(config.devPayoutAddress, '0xc8f686977655879f741f9aa693432081210774ef');

  process.env.DEV_PAYOUT_ADDRESS = '';
  delete require.cache[require.resolve('../config')];
});

test('a blank DEV_PAYOUT_ADDRESS is null, and that is a supported state', () => {
  process.env.DEV_PAYOUT_ADDRESS = '';
  delete require.cache[require.resolve('../config')];
  const config = require('../config');
  assert.strictEqual(config.devPayoutAddress, null);
});

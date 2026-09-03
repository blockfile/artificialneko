'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { Interface } = require('ethers');
const { parseClaimedAmount } = require('./escrow');
const { ESCROW_ABI } = require('./abi');

const IFACE = new Interface(ESCROW_ABI);
const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e';
const ME = '0x1111111111111111111111111111111111111111';
const SOMEONE_ELSE = '0x2222222222222222222222222222222222222222';
const NVDA = '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea';
const OTHER_TOKEN = '0x3333333333333333333333333333333333333333';

/** Build a ClaimedToken log the way the chain would emit it. */
function claimedTokenLog({ address = ESCROW, recipient, token, amount }) {
  const encoded = IFACE.encodeEventLog('ClaimedToken', [recipient, token, amount]);
  return { address, topics: encoded.topics, data: encoded.data };
}

test('sums the amount from our own ClaimedToken event', () => {
  const logs = [claimedTokenLog({ recipient: ME, token: NVDA, amount: 1500n })];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, NVDA), 1500n);
});

test('ignores a ClaimedToken for a different recipient', () => {
  const logs = [claimedTokenLog({ recipient: SOMEONE_ELSE, token: NVDA, amount: 999n })];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, NVDA), 0n);
});

test('ignores a ClaimedToken for a different token', () => {
  const logs = [claimedTokenLog({ recipient: ME, token: OTHER_TOKEN, amount: 999n })];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, NVDA), 0n);
});

test('ignores an identical event emitted by another contract', () => {
  const logs = [claimedTokenLog({ address: SOMEONE_ELSE, recipient: ME, token: NVDA, amount: 999n })];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, NVDA), 0n);
});

test('address comparison is case-insensitive', () => {
  const logs = [claimedTokenLog({ recipient: ME, token: NVDA, amount: 7n })];
  assert.strictEqual(
    parseClaimedAmount(logs, ESCROW.toUpperCase(), ME.toUpperCase(), NVDA.toUpperCase()),
    7n
  );
});

test('an unrelated log in the receipt does not break parsing', () => {
  const logs = [
    { address: SOMEONE_ELSE, topics: [`0x${'ff'.repeat(32)}`], data: '0x' },
    claimedTokenLog({ recipient: ME, token: NVDA, amount: 42n }),
  ];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, NVDA), 42n);
});

test('sums multiple ClaimedToken events for us in one receipt', () => {
  // Escrow balances are per-recipient across ALL launches, so one claimToken
  // call can credit us more than once.
  const logs = [
    claimedTokenLog({ recipient: ME, token: NVDA, amount: 10n }),
    claimedTokenLog({ recipient: ME, token: NVDA, amount: 5n }),
  ];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, NVDA), 15n);
});

test('a native Claimed event is not mistaken for a token claim', () => {
  const encoded = IFACE.encodeEventLog('Claimed', [ME, 123n]);
  const logs = [{ address: ESCROW, topics: encoded.topics, data: encoded.data }];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, NVDA), 0n);
});

test('an empty or missing log list is zero, not a crash', () => {
  assert.strictEqual(parseClaimedAmount([], ESCROW, ME, NVDA), 0n);
  assert.strictEqual(parseClaimedAmount(undefined, ESCROW, ME, NVDA), 0n);
});

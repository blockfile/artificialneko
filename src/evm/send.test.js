'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sendTx, isNonceError } = require('./send');

// Shape of the error ethers raises when the RPC reports the built nonce is behind
// the chain (what killed cycle 4's airdrop: "nonce too low: tx 210 state 211").
function nonceErr() {
  const e = new Error('nonce too low: address 0xdF66, tx: 210 state: 211');
  e.code = 'NONCE_EXPIRED';
  return e;
}

test('sendTx returns the tx when the first send succeeds (no retry, no sleep)', async () => {
  let calls = 0;
  let slept = 0;
  const tx = { hash: '0xabc' };
  const res = await sendTx(
    async () => {
      calls += 1;
      return tx;
    },
    { sleepFn: async () => { slept += 1; } }
  );
  assert.strictEqual(res, tx);
  assert.strictEqual(calls, 1);
  assert.strictEqual(slept, 0);
});

test('sendTx retries on NONCE_EXPIRED and succeeds on the resend', async () => {
  let calls = 0;
  let slept = 0;
  const tx = { hash: '0xdef' };
  const res = await sendTx(
    async () => {
      calls += 1;
      if (calls === 1) throw nonceErr(); // stale nonce on first attempt, fresh on retry
      return tx;
    },
    { delayMs: 1, sleepFn: async () => { slept += 1; } }
  );
  assert.strictEqual(res, tx);
  assert.strictEqual(calls, 2);
  assert.strictEqual(slept, 1);
});

test('sendTx does NOT retry a non-nonce error (e.g. a revert)', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      sendTx(
        async () => {
          calls += 1;
          throw new Error('execution reverted');
        },
        { sleepFn: async () => {} }
      ),
    /execution reverted/
  );
  assert.strictEqual(calls, 1);
});

test('sendTx gives up after `retries` nonce failures and throws the last error', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      sendTx(
        async () => {
          calls += 1;
          throw nonceErr();
        },
        { retries: 3, sleepFn: async () => {} }
      ),
    /nonce too low/
  );
  assert.strictEqual(calls, 4); // 1 initial + 3 retries
});

test('isNonceError matches stale-nonce signals only (safe to resend)', () => {
  assert.ok(isNonceError(nonceErr()));
  assert.ok(isNonceError({ message: 'nonce has already been used' }));
  assert.ok(!isNonceError(new Error('execution reverted')));
  assert.ok(!isNonceError(null));
});

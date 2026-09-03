'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
delete require.cache[require.resolve('../config')];

const { creatorShareRaw, isOperatorOnlyError, sweepFees } = require('./sweep');
const simvault = require('./simvault');

const ETH = 10n ** 18n;

test('creator share removes the protocol bps and nothing else', () => {
  // 3000 bps protocol share -> creator keeps 70%
  assert.strictEqual(creatorShareRaw(ETH, 3000), (ETH * 7000n) / 10000n);
});

test('a zero protocol share leaves the whole amount', () => {
  assert.strictEqual(creatorShareRaw(ETH, 0), ETH);
});

test('creator share of nothing is nothing', () => {
  assert.strictEqual(creatorShareRaw(0n, 3000), 0n);
});

test('rounds down rather than inventing wei', () => {
  // 7 wei at 3000bps = 4.9 -> 4
  assert.strictEqual(creatorShareRaw(7n, 3000), 4n);
});

test('recognises the operator-only revert by name', () => {
  assert.strictEqual(isOperatorOnlyError(new Error('execution reverted: InternalSwapRequiresOperator()')), true);
  assert.strictEqual(isOperatorOnlyError(new Error('NotFeeSweepOperator')), true);
  assert.strictEqual(isOperatorOnlyError(new Error('insufficient funds')), false);
});

test('recognises the operator-only revert by selector 0x31cdb504', () => {
  // Regression test for the Critical bug: ethers cannot decode custom errors
  // without ABI declarations, so the selector appears as raw data, not as a name.
  assert.strictEqual(isOperatorOnlyError({ data: '0x31cdb504' }), true);
});

test('recognises the operator-only revert by selector 0x8d42130c', () => {
  assert.strictEqual(isOperatorOnlyError({ data: '0x8d42130c' }), true);
});

test('returns false for unrelated errors and selectors', () => {
  assert.strictEqual(isOperatorOnlyError(new Error('insufficient funds')), false);
  assert.strictEqual(isOperatorOnlyError({ data: '0xdeadbeef' }), false);
  assert.strictEqual(isOperatorOnlyError({ message: 'some other error' }), false);
});

test('does not throw when handed null, undefined, or empty object', () => {
  assert.doesNotThrow(() => isOperatorOnlyError(null));
  assert.doesNotThrow(() => isOperatorOnlyError(undefined));
  assert.doesNotThrow(() => isOperatorOnlyError({}));
  assert.strictEqual(isOperatorOnlyError(null), false);
  assert.strictEqual(isOperatorOnlyError(undefined), false);
  assert.strictEqual(isOperatorOnlyError({}), false);
});

test('sweepFees under DRY_RUN reports a sweep without touching the vault', async () => {
  simvault.reset();
  const before = simvault.peek();

  const result = await sweepFees({ graduated: false });

  assert.strictEqual(result.swept, true);
  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.reason, null);
  assert.strictEqual(typeof result.signature, 'string');

  // The scheduler accrues the simulated vault once per tick. Accruing here too
  // made a dry run claim twice the balance the scheduler had just reported.
  assert.strictEqual(simvault.peek(), before, 'the sweep must not accrue the vault');
});

test('a buyback-enabled launch skips the sweep instead of throwing', async () => {
  // Passing minBuybackTokensOut = 0 reverts MinimumOutputRequired when buyback
  // is on. That is NOT an operator-only error, so it would propagate and fail
  // the cycle BEFORE the claim — losing a whole cycle's collection over fees
  // that were merely unsweepable. It has to degrade to a skip.
  process.env.DRY_RUN = 'false';
  process.env.WALLET_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
  for (const m of ['../config', './provider', './sweep']) delete require.cache[require.resolve(m)];
  const live = require('./sweep');

  const result = await live.sweepFees({ graduated: true, buybackEnabled: true, poolId: '0xpool' });

  assert.strictEqual(result.swept, false);
  assert.strictEqual(result.skipped, true);
  assert.match(result.reason, /buyback is enabled/);
  assert.strictEqual(result.signature, null);

  process.env.DRY_RUN = 'true';
  process.env.WALLET_PRIVATE_KEY = '';
  for (const m of ['../config', './provider', './sweep']) delete require.cache[require.resolve(m)];
});


// ── fees we are not allowed to sweep must not look claimable ──────────────

// A fake hook. Post-graduation the only reads that matter are the pending
// ledgers, keyed [poolId][currency].
function fakeHook({ feeMeme = 0n, taxMeme = 0n, buybackQuote = 0n, feeQuote = 0n, taxQuote = 0n } = {}) {
  const MEME = '0xmeme';
  return {
    launches: async () => ({ registered: true, protocolFeeShareBps: 0n, buybackEnabled: false }),
    pendingFees: async (_p, c) => (c === MEME ? feeMeme : feeQuote),
    pendingCreatorTax: async (_p, c) => (c === MEME ? taxMeme : taxQuote),
    pendingBuyback: async (_p, c) => (c === MEME ? 0n : buybackQuote),
  };
}
const GRADUATED = { graduated: true, poolId: '0xpool', token: '0xmeme', pairToken: '0xquote' };

test('memecoin-denominated fees lock the sweep to the trusted operator', async () => {
  const { sweepBlockedByOperator } = require('./sweep');
  assert.strictEqual(await sweepBlockedByOperator(GRADUATED, fakeHook({ feeMeme: 5n })), true);
  assert.strictEqual(await sweepBlockedByOperator(GRADUATED, fakeHook({ taxMeme: 5n })), true);
  assert.strictEqual(await sweepBlockedByOperator(GRADUATED, fakeHook({ buybackQuote: 5n })), true);
  assert.strictEqual(await sweepBlockedByOperator(GRADUATED, fakeHook()), false);
});

test('a pre-graduation launch is never operator-locked', async () => {
  const { sweepBlockedByOperator } = require('./sweep');
  // Must not even read the hook — the curve has its own rule.
  const explode = new Proxy({}, { get() { throw new Error('the hook must not be read pre-graduation'); } });
  assert.strictEqual(await sweepBlockedByOperator({ graduated: false }, explode), false);
});

test('fees we CANNOT sweep report as 0 sweepable, not as their pending amount', async () => {
  // This is what the accumulation trigger measures. Counting operator-locked
  // fees made the bot fire every single minute on money it could not reach:
  // it swept nothing, claimed 0, and reset the site's gauge to $0 each pass,
  // for cycle after cycle. Sweepable means sweepable BY US.
  process.env.DRY_RUN = 'false';
  process.env.WALLET_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
  for (const m of ['../config', './provider', './sweep']) delete require.cache[require.resolve(m)];
  const live = require('./sweep');

  assert.strictEqual(await live.sweepableRaw(GRADUATED, fakeHook({ feeQuote: 900n, feeMeme: 1n })), 0n);
  // ...and still reports the real amount once nothing is locked.
  assert.strictEqual(await live.sweepableRaw(GRADUATED, fakeHook({ feeQuote: 900n })), 900n);

  process.env.DRY_RUN = 'true';
  process.env.WALLET_PRIVATE_KEY = '';
  for (const m of ['../config', './provider', './sweep']) delete require.cache[require.resolve(m)];
});

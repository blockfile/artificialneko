'use strict';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../config');
const { requireQuotePrice, fetchQuotePrice } = require('./quoteprice');

// A DexScreener payload listing NVDA (config.quoteTokenAddress) on our chain.
// The liquidity is realistic on purpose: NVDA has deep pools here, and pairs
// below MIN_PAIR_LIQUIDITY_USD are now ignored as dust.
const listed = {
  pairs: [{ chainId: config.dexscreenerChainId, baseToken: { address: config.quoteTokenAddress }, priceUsd: '135.4', liquidity: { usd: 250_000 } }],
};
const glitched = { pairs: null };

test('retries a glitched empty DexScreener answer before giving up', async () => {
  const answers = [glitched, listed];
  let calls = 0;
  const fetchFn = async () => { calls += 1; return answers.shift(); };
  const out = await fetchQuotePrice({ fetchFn, sleepFn: async () => {} });
  assert.deepStrictEqual(out, { priceUsd: 135.4 });
  assert.strictEqual(calls, 2);
});

test('throws only after every attempt came back empty', async () => {
  let calls = 0;
  const fetchFn = async () => { calls += 1; return glitched; };
  await assert.rejects(fetchQuotePrice({ fetchFn, sleepFn: async () => {} }), /NVDA/);
  assert.strictEqual(calls, 3);
});

test('passes a listed NVDA price through', () => {
  assert.deepStrictEqual(requireQuotePrice({ priceUsd: 135.4 }), { priceUsd: 135.4 });
});

test('an unlisted NVDA is an upstream glitch, not a real state — it throws', () => {
  assert.throws(() => requireQuotePrice({ priceUsd: null }), /NVDA/);
  assert.throws(() => requireQuotePrice({}), /NVDA/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parsePairs, EMPTY } = require('./marketdata');

const TOKEN = '0xabc0000000000000000000000000000000000001';

const pair = (over = {}) => ({
  chainId: 'robinhood',
  baseToken: { address: TOKEN },
  marketCap: 4_206_900,
  priceUsd: '0.0042',
  liquidity: { usd: 120_000 },
  url: 'https://dexscreener.com/robinhood/x',
  ...over,
});

test('picks the deepest-liquidity pair on our chain', () => {
  const data = {
    pairs: [
      pair({ marketCap: 100, liquidity: { usd: 10 } }),
      pair({ marketCap: 4_206_900, liquidity: { usd: 999_999 } }),
    ],
  };
  assert.strictEqual(parsePairs(data, TOKEN, 'robinhood').marketCap, 4_206_900);
});

test('ignores pairs on other chains and pairs where we are the quote side', () => {
  const data = {
    pairs: [
      pair({ chainId: 'base' }),
      pair({ baseToken: { address: '0xdead000000000000000000000000000000000000' } }),
    ],
  };
  assert.deepStrictEqual(parsePairs(data, TOKEN, 'robinhood'), EMPTY);
});

test('falls back to fdv when marketCap is absent', () => {
  const data = { pairs: [pair({ marketCap: null, fdv: 777 })] };
  assert.strictEqual(parsePairs(data, TOKEN, 'robinhood').marketCap, 777);
});

test('an unlisted token (no pairs) yields nulls, not zeros', () => {
  assert.deepStrictEqual(parsePairs({ pairs: [] }, TOKEN, 'robinhood'), EMPTY);
  assert.deepStrictEqual(parsePairs({}, TOKEN, 'robinhood'), EMPTY);
});

test('a dust pool is ignored rather than used to price the token', () => {
  // NEKO had a NEKO/ETH pair holding $3.32. DexScreener quoted a price and
  // a market cap from it as readily as from a real market, and the site showed
  // $6.35K while the token actually traded at $34.13K on its bonding curve.
  // Returning nothing lets the caller fall back to the curve price, which is
  // authoritative pre-graduation. A number from a three-dollar pool is worse
  // than no number, because it looks like one.
  const token = '0xa9fcd15f315f5ffa918d3a767a980ee3dc019667';
  const pair = (liq, price) => ({
    chainId: 'robinhood',
    baseToken: { address: token },
    priceUsd: String(price),
    marketCap: price * 1e9,
    liquidity: { usd: liq },
  });

  assert.strictEqual(parsePairs({ pairs: [pair(3.32, 0.000006354)] }, token, 'robinhood').priceUsd, null);
  assert.strictEqual(parsePairs({ pairs: [pair(15100, 0.0000341)] }, token, 'robinhood').priceUsd, 0.0000341);

  // With both present the real market wins — not merely the deeper of two, but
  // the only one above the floor.
  const both = parsePairs({ pairs: [pair(3.32, 0.000006354), pair(15100, 0.0000341)] }, token, 'robinhood');
  assert.strictEqual(both.priceUsd, 0.0000341);
  assert.strictEqual(both.liquidityUsd, 15100);
});

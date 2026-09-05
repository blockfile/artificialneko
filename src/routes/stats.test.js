'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildStats, supplyFallback, withSupplyFallback } = require('./stats');

// The 5th argument is the REWARD token's price - what holders are paid in -
// not the quote asset's. They are different tokens and differ by orders of
// magnitude, so the distinction is the whole point.
const build = (market, token, rewards = {}, curve = {}, rewardPrice = {}, supply = null) =>
  buildStats({
    market, token, rewards, curve, rewardPrice,
    quote: rewardPrice, symbol: 'NEKO', tokenAddress: '0xabc', supply,
  });

// Blockscout-shaped supply: 1B tokens at 18 decimals.
const SUPPLY = { totalSupply: '1000000000000000000000000000', decimals: 18 };

// ── supply fallback (Blockscout unreachable) ────────────────────────────────

test('supplyFallback turns the configured whole-token supply into the explorer\'s wei shape', () => {
  assert.deepStrictEqual(supplyFallback({ tokenTotalSupply: 1_000_000_000, tokenDecimals: 18 }), SUPPLY);
  assert.deepStrictEqual(supplyFallback({ tokenTotalSupply: 5, tokenDecimals: 0 }), { totalSupply: '5', decimals: 0 });
});

test('supplyFallback is null when not configured or nonsense', () => {
  assert.strictEqual(supplyFallback({ tokenTotalSupply: null, tokenDecimals: 18 }), null);
  assert.strictEqual(supplyFallback({ tokenTotalSupply: 0, tokenDecimals: 18 }), null);
  assert.strictEqual(supplyFallback({ tokenTotalSupply: NaN, tokenDecimals: 18 }), null);
});

test('with Blockscout down, the curve market cap is computed from the configured supply', () => {
  assert.strictEqual(build({}, {}, {}, { priceUsd: 0.00001 }, {}, SUPPLY).marketCap, 10_000);
  assert.strictEqual(build({}, {}, {}, { priceUsd: 0.00001 }).marketCap, null); // no fallback configured
});

test('explorer supply wins over the configured fallback', () => {
  const explorer = { totalSupply: '2000000000000000000000000000', decimals: 18 }; // 2B
  assert.deepStrictEqual(withSupplyFallback(explorer, SUPPLY), explorer);
  assert.strictEqual(build({}, explorer, {}, { priceUsd: 0.00001 }, {}, SUPPLY).marketCap, 20_000);
});

test('the fallback fills only the missing halves and leaves holders alone', () => {
  const out = withSupplyFallback({ holders: 7, totalSupply: null, decimals: null }, SUPPLY);
  assert.deepStrictEqual(out, { holders: 7, ...SUPPLY });
});

test('returns the fields the site\'s BOOT window reads', () => {
  const out = build({ marketCap: 4_206_900 }, { holders: 6942 }, { totalRewarded: 826.7 }, {}, { priceUsd: 259.4 });
  assert.strictEqual(out.marketCap, 4_206_900);
  assert.strictEqual(out.ketDistributed, 826.7); // "Total $NVDA Distributed" — token amount, no "$"
  assert.strictEqual(out.totalHolders, 6942);
  // aliases for the other frontend templates
  assert.strictEqual(out.holders, 6942);
  assert.strictEqual(out.totalRewarded, 826.7);
  assert.strictEqual(out.nvdaRewarded, 826.7 * 259.4);
});

test('ketDistributed and totalHolders are null (never 0) when unsourced, and keep a real 0', () => {
  assert.strictEqual(build({}, {}).ketDistributed, null);
  assert.strictEqual(build({}, {}).totalHolders, null);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }).ketDistributed, 0);
});

test('`rewarded` is the generic alias of nvdaRewarded, null when missing', () => {
  const out = build({}, {}, { totalRewarded: 11 }, {}, { priceUsd: 486.91 });
  assert.strictEqual(out.rewarded, out.nvdaRewarded);
  assert.strictEqual(build({}, {}).rewarded, null);
});

test('falls back to the explorer market cap when DexScreener has none', () => {
  const out = build({ marketCap: null }, { circulatingMarketCap: 555 });
  assert.strictEqual(out.marketCap, 555);
});

test('prefers DexScreener over the explorer fallback', () => {
  const out = build({ marketCap: 1 }, { circulatingMarketCap: 999 });
  assert.strictEqual(out.marketCap, 1);
});

test('a dead upstream yields nulls, never zeros', () => {
  const out = build({}, {});
  assert.strictEqual(out.marketCap, null);
  assert.strictEqual(out.holders, null);
  assert.strictEqual(out.nvdaRewarded, null);
  assert.strictEqual(out.price, null);
});

test('a real zero market cap is preserved, not treated as missing', () => {
  const out = build({ marketCap: 0 }, { circulatingMarketCap: 999 });
  assert.strictEqual(out.marketCap, 0);
});

test('includes the total NVDA rewarded from the distributor service', () => {
  const out = build({}, {}, { totalRewarded: 826.5 });
  assert.strictEqual(out.totalRewarded, 826.5);
});

test('a dead rewards upstream yields null, and a real zero is preserved', () => {
  assert.strictEqual(build({}, {}).totalRewarded, null);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }).totalRewarded, 0);
});

test('pre-graduation: priceUsd falls back to the curve price', () => {
  assert.strictEqual(build({}, {}, {}, { priceUsd: 1.6929e-5 }).priceUsd, 1.6929e-5);
});

test('a live DexScreener price wins over the curve price', () => {
  assert.strictEqual(build({ priceUsd: 2 }, {}, {}, { priceUsd: 1 }).priceUsd, 2);
});

test('`price` mirrors priceUsd — the name the site\'s normalizer reads', () => {
  assert.strictEqual(build({ priceUsd: 2 }, {}).price, 2);
  assert.strictEqual(build({}, {}, {}, { priceUsd: 1 }).price, 1);
});

test('pre-graduation: market cap is computed from curve price × explorer supply', () => {
  const out = build({}, SUPPLY, {}, { priceUsd: 0.00001 });
  assert.strictEqual(out.marketCap, 10_000); // 1e9 tokens × $0.00001
});

test('curve market cap loses to DexScreener and the explorer figure', () => {
  assert.strictEqual(build({ marketCap: 5 }, SUPPLY, {}, { priceUsd: 1 }).marketCap, 5);
  assert.strictEqual(build({}, { ...SUPPLY, circulatingMarketCap: 7 }, {}, { priceUsd: 1 }).marketCap, 7);
});

test('totalRewardedUsd values the AI paid out at the AI/USD price', () => {
  // The amount is denominated in the REWARD token. Pricing it at NVDA's - a
  // tokenized stock worth hundreds - overstated the payout by orders of
  // magnitude, and pricing it at the quote token matched no ledger rows at all,
  // so the site read a flat $0.00 after a cycle that paid 66 holders.
  const out = build({}, {}, { totalRewarded: 11 }, {}, { priceUsd: 0.0013 });
  assert.strictEqual(out.totalRewardedUsd, 11 * 0.0013);
});

test('`nvdaRewarded` — the tile the site formats as dollars — is the USD figure', () => {
  const out = build({}, {}, { totalRewarded: 11 }, {}, { priceUsd: 0.0013 });
  assert.strictEqual(out.nvdaRewarded, out.totalRewardedUsd);
});

test('totalRewardedUsd needs both legs, and a real zero stays 0', () => {
  assert.strictEqual(build({}, {}, { totalRewarded: 11 }).totalRewardedUsd, null);
  assert.strictEqual(build({}, {}, {}, {}, { priceUsd: 0.0013 }).totalRewardedUsd, null);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }, {}, { priceUsd: 0.0013 }).totalRewardedUsd, 0);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }, {}, { priceUsd: 0.0013 }).nvdaRewarded, 0);
});

test('curve market cap needs both a price and the supply — else null', () => {
  assert.strictEqual(build({}, {}, {}, { priceUsd: 1 }).marketCap, null);
  assert.strictEqual(build({}, { totalSupply: '10', decimals: null }, {}, { priceUsd: 1 }).marketCap, null);
  assert.strictEqual(build({}, SUPPLY, {}, {}).marketCap, null);
});

// ── buyback + burn ─────────────────────────────────────────────────────────

test('exposes the burned total the site renders', () => {
  const out = buildStats({
    market: { priceUsd: 0.00002 },
    token: {},
    burns: { totalBurned: 12345.6, burnQuoteSpent: 2.5, burns: 3 },
    symbol: 'NEKO',
  });
  assert.strictEqual(out.totalBurned, 12345.6);
  assert.strictEqual(out.burns, 3);
});

test('what the burns COST is kept separate from what they are worth now', () => {
  // burnQuoteSpent is NVDA actually spent; totalBurnedUsd is today's market
  // value of the destroyed tokens. Conflating them would let the site claim a
  // burn was worth more than was ever spent on it.
  const out = buildStats({
    market: { priceUsd: 2 },
    token: {},
    burns: { totalBurned: 100, burnQuoteSpent: 1.5, burns: 1 },
    symbol: 'NEKO',
  });
  assert.strictEqual(out.burnQuoteSpent, 1.5, 'cost, in NVDA');
  assert.strictEqual(out.totalBurnedUsd, 200, 'current value, in USD');
});

test('burn figures are null (never 0) when nothing has been burned yet', () => {
  const out = buildStats({ market: {}, token: {}, symbol: 'NEKO' });
  assert.strictEqual(out.totalBurned, null);
  assert.strictEqual(out.totalBurnedUsd, null);
  assert.strictEqual(out.burnedPctOfSupply, null);
});

test('a real zero burn total is preserved, not treated as missing', () => {
  const out = buildStats({
    market: { priceUsd: 2 },
    token: {},
    burns: { totalBurned: 0, burnQuoteSpent: 0, burns: 0 },
    symbol: 'NEKO',
  });
  assert.strictEqual(out.totalBurned, 0);
  assert.strictEqual(out.totalBurnedUsd, 0);
});

test('burned share of supply adds back what was destroyed', () => {
  // The explorer reports CIRCULATING supply, which the burn already reduced.
  // 900 remaining + 100 burned = 1000 originally, so 10%.
  const out = buildStats({
    market: {},
    token: { totalSupply: (900n * 10n ** 18n).toString(), decimals: 18 },
    burns: { totalBurned: 100, burnQuoteSpent: 1, burns: 1 },
    symbol: 'NEKO',
  });
  assert.ok(Math.abs(out.burnedPctOfSupply - 10) < 1e-9);
});

test('burned share needs the supply — without it, null rather than a wrong number', () => {
  const out = buildStats({
    market: {},
    token: {},
    burns: { totalBurned: 100, burnQuoteSpent: 1, burns: 1 },
    symbol: 'NEKO',
  });
  assert.strictEqual(out.burnedPctOfSupply, null);
});

test('the reward total is served as TOKENS and its USD value separately', () => {
  // The site labels this card "TOTAL $NVDA DISTRIBUTED" and resolves it from
  // rewardDistributed first. Serving only `totalDistributed` — a USD figure —
  // put dollars under an NVDA label, overstating the token count by NVDA's
  // price, which is hundreds of dollars.
  const out = buildStats({
    market: {},
    token: {},
    rewards: { totalRewarded: 12.5 },
    rewardPrice: { priceUsd: 180 },
    symbol: 'NEKO',
    tokenAddress: '0xtoken',
  });
  assert.strictEqual(out.rewardDistributed, 12.5, 'the NVDA amount, for the $NVDA label');
  assert.strictEqual(out.rewardUsd, 2250, 'and its USD value, for the subtitle');
});

// ── which pool prices the token ──────────────────────────────────────────
const { parsePairs } = require('../services/marketdata');

const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const NEKO = '0xc6e8c393d46b685c2fb2177f759f2b16eb7a7d54';
const pair = (quote, price, mcap, liq) => ({
  chainId: 'robinhood',
  baseToken: { address: NEKO },
  quoteToken: { address: quote },
  priceUsd: String(price),
  marketCap: mcap,
  liquidity: { usd: liq },
});

test('the launch pair prices the token, however deep another pool is', () => {
  // Live: DexScreener returned 16 NEKO pairs. The deepest was a NEKO/ETH pool
  // with $35.8M liquidity quoting $3.22 — 4,800x the real price — which put the
  // site's market cap at $3.2 BILLION against a true ~$676K. Pons launched NEKO
  // paired with NVDA; that pool is the market, and depth alone cannot say so.
  const out = parsePairs(
    { pairs: [pair('0x0000000000000000000000000000000000000000', 3.22, 3_229_256_427, 35_825_285), pair(NVDA, 0.0006732, 676_040, 71_729)] },
    NEKO,
    'robinhood'
  );
  assert.strictEqual(out.marketCap, 676_040, 'the NVDA pair wins on identity, not depth');
  assert.strictEqual(out.priceUsd, 0.0006732);
});

test('the liquidity floor still applies within the launch pair', () => {
  // A dust NVDA pool is no more trustworthy than a dust ETH one.
  const out = parsePairs({ pairs: [pair(NVDA, 0.5, 500_000_000, 3.32)] }, NEKO, 'robinhood');
  assert.strictEqual(out.marketCap, null, 'below MIN_PAIR_LIQUIDITY_USD is no answer at all');
});

test('with no launch pair listed, the deepest real pool is still used', () => {
  // Before the NVDA pair is indexed there may be nothing else to go on, and a
  // deep pool is better than nothing — this is only a preference, not a filter.
  const out = parsePairs(
    { pairs: [pair('0x0000000000000000000000000000000000000000', 0.0006776, 677_601, 4_920)] },
    NEKO,
    'robinhood'
  );
  assert.strictEqual(out.marketCap, 677_601);
});

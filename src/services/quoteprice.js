'use strict';

// NVDA/USD — the price of the tokenized-SpaceX asset that NEKO is paired with
// and that holder rewards are paid in. Two consumers share this one cached
// read: the bonding-curve market cap (curve price is in NVDA) and the USD
// figure for rewards paid out. NVDA has deep USDG pools on Robinhood Chain, so
// DexScreener answering "no pair" is an upstream glitch, never a real state —
// it throws so the stale-while-error cache keeps the last good price.

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cached } = require('./cache');
const { parsePairs } = require('./marketdata');

/** Pure: a parsed DexScreener result for NVDA must carry a price. */
function requireQuotePrice(market) {
  if (typeof market.priceUsd !== 'number') throw new Error('NVDA price unavailable from DexScreener');
  return { priceUsd: market.priceUsd };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * DexScreener occasionally answers a concurrent burst with an HTTP 200 whose
 * `pairs` is null — a glitch fetchJson's status-based retry can't see. Retry
 * that shape a couple of times before treating it as a failure.
 */
async function fetchQuotePrice({ fetchFn = fetchJson, sleepFn = sleep, attempts = 3 } = {}) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${config.quoteTokenAddress}`;
  let market;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const data = await fetchFn(url, { headers: { accept: 'application/json' } });
    market = parsePairs(data, config.quoteTokenAddress, config.dexscreenerChainId);
    if (typeof market.priceUsd === 'number') break;
    if (attempt < attempts) await sleepFn(500);
  }
  return requireQuotePrice(market);
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getQuotePrice = cached(config.marketTtlMs, () => fetchQuotePrice());

module.exports = { getQuotePrice, fetchQuotePrice, requireQuotePrice };

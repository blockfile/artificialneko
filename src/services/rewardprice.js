'use strict';

// AI/USD — the price of the token holders are actually PAID in.
//
// Distinct from quoteprice.js, and the distinction matters: the bot claims NVDA
// but distributes Artificial Inu, so the running total is denominated in AI.
// Valuing it at the NVDA price would multiply an AI amount by a tokenized
// stock's price and overstate what holders received by orders of magnitude.
//
// Unlike NVDA, a memecoin's pair can genuinely be missing or unpriced, so this
// resolves to null rather than throwing. The site renders a null as "—", which
// is honest; a wrong number is not.

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cached } = require('./cache');
const { parsePairs } = require('./marketdata');

const EMPTY = { priceUsd: null };

async function fetchRewardPrice({ fetchFn = fetchJson } = {}) {
  if (!config.rewardTokenAddress) return EMPTY;
  const url = `https://api.dexscreener.com/latest/dex/tokens/${config.rewardTokenAddress}`;
  const data = await fetchFn(url, { headers: { accept: 'application/json' } });
  const market = parsePairs(data, config.rewardTokenAddress, config.dexscreenerChainId);
  return { priceUsd: typeof market.priceUsd === 'number' ? market.priceUsd : null };
}

const getRewardPrice = cached(config.marketTtlMs, fetchRewardPrice);

module.exports = { getRewardPrice, fetchRewardPrice, EMPTY };

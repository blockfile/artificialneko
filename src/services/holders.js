'use strict';

// Holder count for NEKO, from the Blockscout REST API on Robinhood Chain.
//
// This deliberately uses the token summary endpoint
//   GET {EXPLORER_API}/api/v2/tokens/{address}
// which returns the holder count as a single field, rather than paging
// /tokens/{address}/holders and counting rows. Blockscout returns 50 holders
// per page, so counting by hand would be ~140 upstream requests per refresh for
// a token with a few thousand holders — for one number the explorer already
// computes. The same response also carries a market-cap fallback, so one call
// feeds both stats.
//
// Field naming drifts between Blockscout versions (`holders` on older builds,
// `holders_count` on newer ones), so both are read.

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cached } = require('./cache');

const EMPTY = { holders: null, circulatingMarketCap: null, totalSupply: null, decimals: null };

/** Coerce Blockscout's stringly-typed numbers ("6942", null, "") to a number or null. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Pure: pull the fields we care about out of a Blockscout token response. */
function parseTokenInfo(data) {
  if (!data || typeof data !== 'object') return EMPTY;
  return {
    holders: toNumber(data.holders ?? data.holders_count),
    circulatingMarketCap: toNumber(data.circulating_market_cap),
    totalSupply: data.total_supply != null ? String(data.total_supply) : null,
    decimals: toNumber(data.decimals),
  };
}

async function fetchTokenInfo() {
  if (!config.tokenAddress) return EMPTY; // pre-launch: nothing to ask about
  const url = `${config.explorerApi}/api/v2/tokens/${config.tokenAddress}`;
  const data = await fetchJson(url, { headers: { accept: 'application/json' } });
  return parseTokenInfo(data);
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getTokenInfo = cached(config.holdersTtlMs, fetchTokenInfo);

module.exports = { getTokenInfo, parseTokenInfo, EMPTY };

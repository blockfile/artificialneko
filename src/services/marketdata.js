'use strict';

// Market cap for NEKO, from DexScreener's public API (no key required).
//
// Returns nulls rather than throwing when the token isn't listed yet or the API
// is unreachable, so /stats never breaks — the site hides a tile whose value is
// null instead of showing a misleading zero. The chain slug is configurable
// (DEXSCREENER_CHAIN_ID) because newly-supported chains get their slug over time.

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cached } = require('./cache');

const EMPTY = { marketCap: null, priceUsd: null, liquidityUsd: null, pairUrl: null };

const toNumber = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Pure: pick our token's deepest pair out of a DexScreener response.
 * @param {object} data raw DexScreener body
 * @param {string} token lowercased contract address
 * @param {string} chainId DexScreener chain slug
 */
function parsePairs(data, token, chainId) {
  const pairs = Array.isArray(data && data.pairs) ? data.pairs : [];

  // Pairs on our chain where our token is the base side; deepest liquidity wins.
  const ours = pairs
    .filter(
      (p) =>
        p.chainId === chainId &&
        p.baseToken &&
        p.baseToken.address &&
        p.baseToken.address.toLowerCase() === token
    )
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

  // Ignore pairs too thin to price anything. A token can have a dust pool
  // nobody trades - NEKO had a NEKO/ETH pair holding $3.32 - and
  // DexScreener will happily quote a price and a market cap from it. That put
  // the site at $6.35K while the real figure, on the bonding curve where the
  // token actually trades, was $34.13K.
  //
  // Returning EMPTY rather than the thin pair matters: the caller falls back to
  // the curve price, which is authoritative before graduation. A number from a
  // three-dollar pool is worse than no number, because it looks like one.
  const deepEnough = (x) => (toNumber(x.liquidity && x.liquidity.usd) ?? 0) >= config.minPairLiquidityUsd;

  // Depth alone picks the WRONG pool. Live, DexScreener listed 16 NEKO pairs and
  // the deepest was a NEKO/ETH pool with $35.8M of liquidity quoting $3.22 a
  // token — 4,800x the real price — which put the site's market cap at $3.2
  // BILLION against a true ~$676K. Anyone can open a pool with any ratio, and a
  // deep one is not thereby the market.
  //
  // The launch settles it: pons priced NEKO in NVDA, so the NEKO/NVDA pool IS
  // where it trades and every other pair is a side venue. Preference, not a
  // filter — before that pair is indexed a deep pool is still better than
  // nothing, and the liquidity floor applies either way.
  const quoteToken = String(config.quoteTokenAddress || '').toLowerCase();
  const launchPair = quoteToken
    ? ours.filter((x) => String((x.quoteToken && x.quoteToken.address) || '').toLowerCase() === quoteToken)
    : [];

  const p = launchPair.find(deepEnough) || (launchPair.length ? null : ours.find(deepEnough));
  if (!p) return EMPTY;
  return {
    // marketCap is DexScreener's circulating figure; fdv is the fully-diluted
    // one. Memecoins normally have their whole supply in circulation, so the
    // two agree — but fdv is the more reliably populated of the two.
    marketCap: toNumber(p.marketCap) ?? toNumber(p.fdv),
    priceUsd: toNumber(p.priceUsd),
    liquidityUsd: toNumber(p.liquidity && p.liquidity.usd),
    pairUrl: p.url || null,
  };
}

async function fetchMarketData() {
  if (!config.tokenAddress) return EMPTY; // pre-launch: nothing listed anywhere
  const url = `https://api.dexscreener.com/latest/dex/tokens/${config.tokenAddress}`;
  const data = await fetchJson(url, { headers: { accept: 'application/json' } });
  return parsePairs(data, config.tokenAddress, config.dexscreenerChainId);
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getMarketData = cached(config.marketTtlMs, fetchMarketData);

module.exports = { getMarketData, parsePairs, EMPTY };

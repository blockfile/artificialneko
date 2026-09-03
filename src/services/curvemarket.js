'use strict';

// Pre-graduation NEKO price, computed from the Pons bonding curve.
//
// Until NEKO graduates off the Pons V2 bonding curve there is no Uniswap pool,
// so DexScreener has nothing to say about it. But the curve itself trades all
// day, and Pons's chart API (same host as the rewards distributor API) reports
// the curve price denominated in NVDA — while NVDA, the tokenized-SpaceX quote
// asset, IS listed on DexScreener with deep pools. Multiplying the two gives a
// real USD price for NEKO today:
//
//   GET {ponsApi}/api/pons-v2-market/{token}/chart?range=1d
//     -> { points: [{ t, price, ... }] }        price = NVDA per NEKO
//   GET dexscreener /latest/dex/tokens/{NVDA}   -> NVDA price in USD
//
//   priceUsd = latest curve price × NVDA priceUsd
//
// /stats uses this as a FALLBACK: once the token graduates, the DexScreener
// pair for NEKO itself takes over (see routes/stats.js merge order) and this
// service quietly stops mattering. No trades yet or an unlisted quote asset
// degrade to null, never 0; malformed responses throw so the stale-while-error
// cache keeps the last good value.

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cached } = require('./cache');
const { getQuotePrice } = require('./quoteprice');
const { getMarketData } = require('./marketdata');

const EMPTY = { priceUsd: null };

/** Pure: latest curve price (NVDA per NEKO) out of a Pons chart payload, or null. */
function parseCurvePrice(data) {
  if (!data || typeof data !== 'object') {
    throw new Error(`malformed chart response: ${String(data).slice(0, 80)}`);
  }
  const points = Array.isArray(data.points) ? data.points : [];
  if (points.length === 0) return null; // no trades in the window
  const price = points[points.length - 1].price;
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new Error(`malformed chart price: ${String(price).slice(0, 80)}`);
  }
  return price;
}

/**
 * Pure: combine the two legs. No curve trades (null curve price) is a REAL
 * empty — the token simply has no price yet. But a missing NVDA/USD price is
 * always an upstream glitch (NVDA is a major listed asset), so it THROWS:
 * a fulfilled empty would overwrite the cached good value for a whole TTL,
 * while a throw makes the cache keep serving it (see cache.js).
 */
function combinePrices(curvePrice, quoteUsd) {
  if (curvePrice === null) return EMPTY;
  if (quoteUsd === null) throw new Error('NVDA price unavailable from DexScreener');
  return { priceUsd: curvePrice * quoteUsd };
}

async function fetchCurveMarket() {
  if (!config.tokenAddress || !config.quoteTokenAddress) return EMPTY;

  // The curve price exists to cover the window BEFORE a token graduates. Once
  // it trades on a real pool DexScreener prices it, this value is never read
  // (it is the third fallback behind two better sources), and pons answers 502
  // for the chart of a graduated token. Paying four retries to rediscover that
  // on every request is what put 4-10 seconds on /stats.
  //
  // Read from the shared cache, so this costs nothing. If DexScreener itself is
  // down we fall through and ask pons after all - which is exactly the outage
  // the curve fallback is for.
  const market = await getMarketData().catch(() => ({}));
  if (typeof market.priceUsd === 'number' && market.priceUsd > 0) return EMPTY;

  const chartUrl = `${config.ponsApi}/api/pons-v2-market/${config.tokenAddress}/chart?range=1d`;
  const [chart, quote] = await Promise.all([
    // One retry, not three. This is the pre-graduation price only - a nice
    // extra before a token bonds and dead weight afterwards, when the pons
    // endpoint starts answering 502 for it. It must never be the reason
    // /stats is slow.
    // A generous timeout and NO retry. The endpoint takes ~7s to answer, well
    // past the browser-facing default, so the default aborted every call and
    // left a pre-graduation token with no price at all. One attempt, because a
    // second would double the worst-case wait on a cold cache and the
    // stale-while-error cache already covers a blip.
    fetchJson(chartUrl, {
      headers: { accept: 'application/json' },
      retries: 0,
      timeoutMs: config.curveFetchTimeoutMs,
    }),
    getQuotePrice(), // shared cached NVDA/USD read (see quoteprice.js)
  ]);

  return combinePrices(parseCurvePrice(chart), quote.priceUsd);
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getCurveMarket = cached(config.marketTtlMs, fetchCurveMarket);

module.exports = { getCurveMarket, parseCurvePrice, combinePrices, EMPTY };

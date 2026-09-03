'use strict';

// GET /stats returns what the site's BOOT window reads (src/api/mockData.js
// in the frontend documents the shape; VideoTV.jsx renders it):
//
//   { "marketCap": 4189702,        -> "Market Cap" panel, formatted with a "$"
//     "ketDistributed": 826.7,     -> "Total $NVDA Distributed" panel, NVDA token amount
//     "totalHolders": 12879 }
//
// The remaining fields are aliases and extras for sites built from the other
// templates in this lineage (`nvdaRewarded`/`rewarded` = USD figure, `price`,
// `holders`), so any of those frontends works against this API unchanged.
// A field that cannot be sourced is null, never 0 — the site renders a null
// as "—", but would render a 0 as a real number.

const express = require('express');
const config = require('../config');
const { getMarketData } = require('../services/marketdata');
const { getTokenInfo } = require('../services/holders');
const { getRewards } = require('../services/rewards');
const { getCurveMarket } = require('../services/curvemarket');
const { getQuotePrice } = require('../services/quoteprice');
const { getRewardPrice } = require('../services/rewardprice');
const { getBurns } = require('../services/burns');

const router = express.Router();

/**
 * Pure: what the burned NEKO is worth at the CURRENT price.
 *
 * Deliberately distinct from `burnQuoteSpent`, which is what the buybacks
 * actually cost in NVDA. The two answer different questions and drift apart as
 * the price moves; conflating them would let the site claim a burn was worth
 * more (or less) than was ever spent on it.
 */
function burnedUsd(burns, priceUsd) {
  if (typeof burns.totalBurned !== 'number' || typeof priceUsd !== 'number') return null;
  return burns.totalBurned * priceUsd;
}

/** Pure: burned tokens as a share of what was minted, in percent. */
function burnedPctOfSupply(burns, token) {
  if (typeof burns.totalBurned !== 'number') return null;
  if (token.totalSupply == null || token.decimals == null) return null;
  const minted = Number(BigInt(token.totalSupply)) / 10 ** token.decimals;
  // The explorer reports CIRCULATING supply, which a burn has already reduced —
  // so the denominator is what remains plus what we destroyed.
  const original = minted + burns.totalBurned;
  if (!(original > 0)) return null;
  return (burns.totalBurned / original) * 100;
}

/**
 * Pure: USD value of what holders were PAID.
 *
 * Priced with the REWARD token's own price. The amount is denominated in
 * Artificial Inu, so valuing it at NVDA's price - a tokenized stock worth a few
 * hundred dollars - overstates the payout by orders of magnitude.
 */
function rewardedUsd(rewards, rewardPrice) {
  if (typeof rewards.totalRewarded !== 'number' || typeof rewardPrice.priceUsd !== 'number') return null;
  return rewards.totalRewarded * rewardPrice.priceUsd;
}

/**
 * Pure: market cap computed from the bonding-curve price and the token's
 * total supply, for the window before the token graduates to a real pool.
 * Needs both halves — a price with no supply (or vice versa) is null.
 */
function curveMarketCap(curve, token) {
  if (typeof curve.priceUsd !== 'number') return null;
  if (token.totalSupply == null || token.decimals == null) return null;
  return (Number(BigInt(token.totalSupply)) / 10 ** token.decimals) * curve.priceUsd;
}

/**
 * Pure: the configured supply as Blockscout would report it (a wei string plus
 * decimals), or null when TOKEN_TOTAL_SUPPLY is not set.
 */
function supplyFallback({ tokenTotalSupply, tokenDecimals }) {
  if (tokenTotalSupply == null || !Number.isFinite(tokenTotalSupply) || tokenTotalSupply <= 0) return null;
  const decimals = Number.isFinite(tokenDecimals) ? tokenDecimals : 18;
  return {
    totalSupply: (BigInt(Math.round(tokenTotalSupply)) * 10n ** BigInt(decimals)).toString(),
    decimals,
  };
}

/**
 * Pure: fill in supply/decimals from the fallback when the explorer could not
 * provide them, so the bonding-curve market cap survives a Blockscout outage
 * (its Cloudflare front intermittently refuses API calls). Explorer values
 * always win when present.
 */
function withSupplyFallback(token, fallback) {
  if (!fallback) return token;
  return {
    ...token,
    totalSupply: token.totalSupply ?? fallback.totalSupply,
    decimals: token.decimals ?? fallback.decimals,
  };
}

/**
 * Pure: merge the five upstreams into the response body.
 *
 * Market cap prefers DexScreener (live pool pricing, exists only after the
 * token graduates), then Blockscout's circulating_market_cap (populated only
 * once the explorer has an exchange rate), then the bonding-curve computation
 * — so the tile shows a real number at every stage of the token's life.
 */
function buildStats({ market, token: explorerToken, rewards = {}, burns = {}, curve = {}, quote = {}, rewardPrice = {}, symbol, tokenAddress, supply = null }) {
  const token = withSupplyFallback(explorerToken, supply);
  const priceUsd = market.priceUsd ?? curve.priceUsd ?? null;
  const totalRewarded = rewards.totalRewarded ?? null; // NVDA token amount
  const totalRewardedUsd = rewardedUsd(rewards, rewardPrice);
  const holders = token.holders ?? null;
  return {
    marketCap: market.marketCap ?? token.circulatingMarketCap ?? curveMarketCap(curve, token),
    // The Artificial Neko site reads these two first and falls back to the
    // camelCase names; serving both means a frontend rename cannot break it.
    market_cap_usd: market.marketCap ?? token.circulatingMarketCap ?? curveMarketCap(curve, token),
    total_distributed_usd: rewardedUsd(rewards, rewardPrice),
    holders,
    totalHolders: holders, // the name this site's mock shape uses
    totalRewarded,
    // "Total $NVDA Distributed" panel — the site shows this without a "$", so
    // it is the NVDA token amount, not USD. (Field name inherited from the
    // template's original token.)
    ketDistributed: totalRewarded,
    totalRewardedUsd,
    // USD figure under the names the other frontend templates read
    // (`raw.<asset>Rewarded ?? raw.<asset>_rewarded ?? raw.rewarded`).
    nvdaRewarded: totalRewardedUsd,
    rewarded: totalRewardedUsd,
    // The space-inu site reads `totalDistributed` and renders it through
    // compactCurrency with a "$" prefix, so it wants the USD figure — not the
    // NVDA token amount that `totalRewarded` carries.
    totalDistributed: totalRewardedUsd,
    // ── Buyback + burn ──────────────────────────────────────────────────────
    // NEKO tokens destroyed. The headline number for the burn tile.
    totalBurned: burns.totalBurned ?? null,
    // What those buybacks cost, in NVDA — what was actually spent.
    burnQuoteSpent: burns.burnQuoteSpent ?? null,
    // What the burned tokens are worth at today's price — a different figure
    // from what they cost, and it moves with the market.
    totalBurnedUsd: burnedUsd(burns, priceUsd),
    burnedPctOfSupply: burnedPctOfSupply(burns, token),
    burns: burns.burns ?? null,

    priceUsd,
    price: priceUsd,
    liquidityUsd: market.liquidityUsd ?? null,
    symbol,
    tokenAddress: tokenAddress ?? null,
    updatedAt: new Date().toISOString(),
  };
}

router.get('/stats', async (req, res, next) => {
  try {
    // Independent upstreams — one being down must not delay or fail the other,
    // so all settle and a rejection degrades to nulls for its own fields only.
    const [marketResult, tokenResult, rewardsResult, burnsResult, curveResult, quoteResult, rewardPriceResult] =
      await Promise.allSettled([
        getMarketData(),
        getTokenInfo(),
        getRewards(),
        getBurns(),
        getCurveMarket(),
        getQuotePrice(),
        getRewardPrice(),
      ]);

    const market = marketResult.status === 'fulfilled' ? marketResult.value : {};
    const token = tokenResult.status === 'fulfilled' ? tokenResult.value : {};
    const rewards = rewardsResult.status === 'fulfilled' ? rewardsResult.value : {};
    const burns = burnsResult.status === 'fulfilled' ? burnsResult.value : {};
    const curve = curveResult.status === 'fulfilled' ? curveResult.value : {};
    const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : {};
    const rewardPrice = rewardPriceResult.status === 'fulfilled' ? rewardPriceResult.value : {};

    if (marketResult.status === 'rejected') {
      console.warn('[artificialneko] market data unavailable:', marketResult.reason?.message);
    }
    if (tokenResult.status === 'rejected') {
      console.warn('[artificialneko] holder count unavailable:', tokenResult.reason?.message);
    }
    if (rewardsResult.status === 'rejected') {
      console.warn('[artificialneko] rewards unavailable:', rewardsResult.reason?.message);
    }
    if (burnsResult.status === 'rejected') {
      console.warn('[artificialneko] burn totals unavailable:', burnsResult.reason?.message);
    }
    if (curveResult.status === 'rejected') {
      console.warn('[artificialneko] curve price unavailable:', curveResult.reason?.message);
    }
    if (quoteResult.status === 'rejected') {
      console.warn('[artificialneko] NVDA price unavailable:', quoteResult.reason?.message);
    }
    if (rewardPriceResult.status === 'rejected') {
      console.warn('[artificialneko] AI price unavailable:', rewardPriceResult.reason?.message);
    }

    res.json(
      buildStats({
        market,
        token,
        rewards,
        burns,
        curve,
        quote,
        rewardPrice,
        symbol: config.tokenSymbol,
        tokenAddress: config.tokenAddress,
        supply: supplyFallback(config),
      })
    );
  } catch (err) {
    next(err);
  }
});

module.exports = { router, buildStats, supplyFallback, withSupplyFallback };

'use strict';

// Total NEKO bought back and burned, from this bot's own ledger.
//
// Same source and same rules as the rewards total: the bot is the only thing
// performing these burns, so its records are the authority, and only burns
// carrying a real on-chain transaction hash are counted — a DRY_RUN burn is
// recorded with a fabricated signature and must never reach a visitor.
//
// `quoteSpent` is what the burns actually COST, in NVDA. That is a different
// question from what the burned tokens are worth today, and both are served so
// the site can show either without doing arithmetic the backend already has the
// inputs for.
//
// Null (not 0) before launch: the site hides a null tile, but would render a
// zero as a real "nothing has been burned" claim. Once live, a real zero means
// no cycle has burned yet and is served as 0.

const config = require('./../config');
const repo = require('../db/repository');
const { cached } = require('./cache');

const EMPTY = { totalBurned: null, burnQuoteSpent: null, burns: null };

async function fetchBurns() {
  if (!config.tokenAddress) return EMPTY; // pre-launch: nothing to sum
  const { tokensBurned, quoteSpent, burns } = await repo.getBurnTotal();
  return {
    totalBurned: tokensBurned ?? 0,
    burnQuoteSpent: quoteSpent ?? 0,
    burns: burns ?? 0,
  };
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getBurns = cached(config.rewardsTtlMs, fetchBurns);

module.exports = { getBurns, fetchBurns, EMPTY };

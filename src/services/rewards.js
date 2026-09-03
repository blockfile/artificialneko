'use strict';

// Total NVDA paid to holders — summed from this project's own airdrop ledger.
//
// This previously read Pons's fee-distributor API, which was the right source
// while Pons did the distributing. This launch keeps creator fees with the bot,
// so there IS no distributor: the bot claims and airdrops, and its records are
// the only authority on what holders have actually been paid.
//
// `getDistributedTotal` counts only payouts carrying a real on-chain
// transaction hash, so simulated DRY_RUN rows are never included — publishing
// those would show visitors a headline number backed by transactions that do
// not exist.
//
// Null (not 0) before launch: the site hides a null tile, but would render a
// zero as a real "nothing has been paid yet" claim. Once the token is live, a
// real zero means no cycle has paid out yet and is served as 0.

const config = require('./../config');
const repo = require('../db/repository');
const { cached } = require('./cache');

const EMPTY = { totalRewarded: null };

async function fetchRewards() {
  if (!config.tokenAddress) return EMPTY; // pre-launch: nothing to sum
  // The REWARD token, not the quote one. Holders are paid Artificial Inu; the
  // airdrop ledger records that, so summing the quote asset matches nothing and
  // reports a flat zero after a cycle that paid everybody.
  const { totalUi } = await repo.getDistributedTotal(config.rewardTokenAddress);
  return { totalRewarded: totalUi ?? 0 };
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getRewards = cached(config.rewardsTtlMs, fetchRewards);

module.exports = { getRewards, fetchRewards, EMPTY };

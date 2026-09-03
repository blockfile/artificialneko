'use strict';

// A feed of BURN events, shaped like the rewards feed on purpose.
//
// /stats already carries the burn TOTALS, and for a long time that was all the
// site could show: how much had been destroyed, but never when, and no way for
// a visitor to verify any of it. A holder watching a buyback happen on the DEX
// had nothing on the site that corresponded to it.
//
// The envelope matches /rewards field for field (`transactions` / `items` /
// `rows` + `nextCursor`) so a frontend can reuse the normalizer it already has
// rather than growing a second one.

const config = require('../config');
const repo = require('../db/repository');
const { cachedByKey } = require('./cache');

/**
 * One stored buyback step -> one feed row.
 *
 * `amount` is the MEMECOIN destroyed, not the NVDA spent, because that is what
 * a burn card announces. The cost rides along as `quoteSpent` for anyone who
 * wants both.
 *
 * Wrapped by the caller rather than passed to .map directly: Array.map calls
 * its callback with (element, index, array), and the index would land in the
 * second parameter.
 */
function toRow(row, explorerTxBase = config.explorerTxBase) {
  const detail = row.detail || {};
  return {
    id: String(row.id),
    type: 'burn',
    amount: detail.tokensBought ?? null,
    symbol: config.tokenSymbol || null,
    quoteSpent: detail.quoteSpent ?? null,
    quoteSymbol: config.quoteSymbol || null,
    txHash: row.signature || null,
    txUrl: row.signature ? `${explorerTxBase}${row.signature}` : null,
    timestamp: row.at || row.created_at || null,
  };
}

async function fetchFeedPage(cursor, limit) {
  if (!config.tokenAddress) return { rows: [], nextCursor: null };
  const page = await repo.getBurnPage(limit, cursor);
  return { rows: page.rows.map((row) => toRow(row)), nextCursor: page.nextCursor };
}

const getFeedPage = cachedByKey(config.feedTtlMs, fetchFeedPage);

module.exports = { getFeedPage, fetchFeedPage, toRow };

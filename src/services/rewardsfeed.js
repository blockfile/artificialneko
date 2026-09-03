'use strict';

// The rewards feed: individual NVDA payouts to holder wallets, newest first.
//
// The payouts are made by this project's own bot, so its ledger IS the source
// of truth. That is a change from the previous implementation, which read NVDA
// transfers out of a pons fee distributor — correct while pons did the
// distributing, but this launch keeps creator fees with the bot, so there is no
// distributor to read and that feed would be permanently empty.
//
// Reading our own records also removes an explorer round trip from every
// visitor poll, removes the lag between a payout landing and appearing, and
// keeps the feed working while Blockscout is having a bad minute.
//
// `repo.getAirdropPage` already excludes DRY_RUN payouts by requiring a real
// transaction hash, so a simulated payout can never reach a visitor.
//
// The cursor is the numeric id of the last row served. Ids are monotonic, so
// "older than this" is a plain comparison. The site treats the cursor as opaque
// and only echoes back `nextCursor`, so its format is ours to choose.

const config = require('./../config');
const repo = require('../db/repository');
const { cachedByKey } = require('./cache');

const EMPTY_PAGE = { rows: [], nextCursor: null };

function badCursor() {
  const err = new Error('malformed cursor — expected a row id');
  err.status = 400;
  return err;
}

/** Pure: cursor string -> row id, or null for "start at the newest". Throws 400. */
function parseCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) throw badCursor();
  return Number(cursor);
}

/** Pure: an explorer link for a transaction hash, or null without one. */
function txUrlFor(txHash, base) {
  if (!txHash || !base) return null;
  return `${base}${txHash}`;
}

/** Pure: a stored airdrop row -> the feed row the route serves. */
function toRow(row, explorerTxBase = config.explorerTxBase) {
  const at = Date.parse(row.created_at);
  return {
    id: String(row.id),
    wallet: row.recipient,
    // The site formats this and appends its own ticker. 0 rather than null: an
    // amount is always known for a payout that actually happened.
    amount: row.amount_ui ?? 0,
    txHash: row.signature,
    // Sent explicitly because the site only builds its own link when this is
    // absent — and its fallback points at Ethereum's explorer, which is the
    // wrong chain entirely for these transactions.
    txUrl: txUrlFor(row.signature, explorerTxBase),
    at: Number.isFinite(at) ? at : null, // epoch ms
  };
}

async function fetchFeedPage({ cursor = null, limit }) {
  if (!config.tokenAddress) return EMPTY_PAGE; // pre-launch: nothing paid out yet
  const page = await repo.getAirdropPage(limit, parseCursor(cursor));
  // Wrapped, NOT passed by reference: Array.map calls its callback with
  // (element, index, array), so `map(toRow)` fed the index into toRow's second
  // parameter. Index 0 is falsy and produced a null link; every later index was
  // concatenated onto the hash, giving "50x1d29…" — which the browser resolved
  // as a relative path on the site itself.
  return { rows: page.rows.map((row) => toRow(row)), nextCursor: page.nextCursor };
}

// Cached per (cursor, limit) — the site polls this every 15s per open tab.
const pages = cachedByKey(config.feedTtlMs, (cursor, limit) => fetchFeedPage({ cursor, limit }));
const getFeedPage = (cursor, limit) => pages(`${cursor ?? ''}|${limit}`, cursor, limit);

module.exports = { getFeedPage, fetchFeedPage, parseCursor, toRow, txUrlFor, EMPTY_PAGE };

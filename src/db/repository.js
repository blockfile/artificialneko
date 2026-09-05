'use strict';

const { getDb } = require('./index');

const NO_ID = { projection: { _id: 0 } };

/** Atomic numeric auto-increment, mirroring simple rowids. */
async function nextId(name) {
  const db = getDb();
  const doc = await db.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  // mongodb v6 returns the document directly; older shapes nest it under .value
  return (doc && doc.seq) ?? (doc && doc.value && doc.value.seq);
}

async function createCycle({ dryRun }) {
  const db = getDb();
  const id = await nextId('cycles');
  await db.collection('cycles').insertOne({
    id,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    phase: null,
    // Quote amounts are NVDA, the launch's quote asset — there is no ETH in
    // this flow, so no *_eth columns. tokens_burned is NEKO: the only
    // thing the bot ever buys, and it is destroyed in the same cycle.
    quote_claimed: null,
    quote_distributed: null,
    quote_burned: null,
    tokens_burned: null,
    sweep_skipped: 0,
    sweep_reason: null,
    dry_run: dryRun ? 1 : 0,
    note: null,
    error: null,
  });
  return id;
}

/** Set only the provided fields; finished_at defaults to now. */
async function finishCycle(id, fields) {
  const db = getDb();
  const allowed = [
    'status', 'mode', 'phase', 'quote_claimed', 'quote_distributed',
    'quote_burned', 'tokens_burned', 'quote_gas', 'eth_received',
    'eligible_holders', 'total_holders',
    'sweep_skipped', 'sweep_reason',
    'note', 'error',
  ];
  const $set = { finished_at: fields.finished_at ?? new Date().toISOString() };
  for (const key of allowed) {
    if (fields[key] !== undefined) $set[key] = fields[key];
  }
  await db.collection('cycles').updateOne({ id }, { $set });
}

async function addStep({ cycleId, name, status, signature, detail }) {
  const db = getDb();
  const id = await nextId('steps');
  const doc = {
    id,
    cycle_id: cycleId,
    name,
    status,
    signature: signature ?? null,
    detail: detail ?? null,
    created_at: new Date().toISOString(),
  };
  await db.collection('steps').insertOne(doc);
}

async function getCycleWithSteps(id) {
  const db = getDb();
  const cycle = await db.collection('cycles').findOne({ id }, NO_ID);
  if (!cycle) return null;
  const steps = await db
    .collection('steps')
    .find({ cycle_id: id }, NO_ID)
    .sort({ id: 1 })
    .toArray();
  return { ...cycle, steps };
}

async function getCycles(limit, offset) {
  const db = getDb();
  const total = await db.collection('cycles').countDocuments();
  const items = await db
    .collection('cycles')
    .find({}, NO_ID)
    .sort({ id: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
  return { total, items };
}

async function getLastCycle() {
  const db = getDb();
  const last = await db.collection('cycles').find({}, NO_ID).sort({ id: -1 }).limit(1).toArray();
  return last.length ? getCycleWithSteps(last[0].id) : null;
}

async function getStats() {
  const db = getDb();
  const [row] = await db
    .collection('cycles')
    .aggregate([
      {
        $group: {
          _id: null,
          cycles: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'complete'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } },
          total_quote_distributed: { $sum: { $ifNull: ['$quote_distributed', 0] } },
        },
      },
    ])
    .toArray();

  // Sum claimed NVDA from the claim STEPS, not the cycles: a step is recorded
  // the moment a claim succeeds, while cycles.quote_claimed is only set at
  // finish — a cycle that claims and then fails would silently drop its claim
  // from the total.
  const [claimRow] = await db
    .collection('steps')
    .aggregate([
      { $match: { name: 'claim', status: 'ok' } },
      { $group: { _id: null, quote: { $sum: { $ifNull: ['$detail.quoteClaimed', 0] } } } },
    ])
    .toArray();

  return {
    ...(row || {
      cycles: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      total_quote_distributed: 0,
    }),
    total_quote_claimed: claimRow ? claimRow.quote : 0,
  };
}

async function addAirdrop({ cycleId, rewardToken, recipient, amountRaw, amountUi, signature, status }) {
  const db = getDb();
  const id = await nextId('airdrops');
  const doc = {
    id,
    cycle_id: cycleId,
    reward_token: rewardToken,
    recipient,
    amount_raw: String(amountRaw),
    amount_ui: amountUi ?? null,
    signature: signature ?? null,
    status: status ?? 'ok',
    created_at: new Date().toISOString(),
  };
  await db.collection('airdrops').insertOne(doc);
  return id;
}

// A real on-chain transaction hash. DRY_RUN records airdrops with status 'ok'
// and a fabricated `airdrop_ka9f2x` signature, so status alone cannot tell a
// simulated payout from a real one.
const REAL_TX_HASH = '^0x[0-9a-fA-F]{64}$';

/**
 * One page of real (on-chain) payouts, newest first, for the public feed.
 *
 * The cursor is the numeric row id of the last row served — ids are monotonic,
 * so "older than this" is a plain `$lt`. Simulated DRY_RUN payouts are excluded
 * HERE rather than at the route, so no caller can forget: their fabricated
 * signature fails the real-hash test.
 *
 * @param {number} limit
 * @param {string|number|null} afterId
 * @returns {Promise<{rows: object[], nextCursor: string|null}>}
 */
async function getAirdropPage(limit, afterId = null) {
  const db = getDb();
  const filter = { status: 'ok', signature: { $regex: REAL_TX_HASH } };
  if (afterId !== null && afterId !== undefined && afterId !== '') {
    filter.id = { $lt: Number(afterId) };
  }
  // Fetch one extra row to learn whether a further page exists, without a
  // second count query on every visitor poll.
  const found = await db
    .collection('airdrops')
    .find(filter, NO_ID)
    .sort({ id: -1 })
    .limit(limit + 1)
    .toArray();

  const rows = found.slice(0, limit);
  const more = found.length > limit;
  const last = rows[rows.length - 1];
  return { rows, nextCursor: more && last ? String(last.id) : null };
}

/**
 * Total for ONE reward token, counting only payouts that actually landed on
 * chain. Counting a simulated payout as distributed would inflate the headline
 * number the site shows to visitors, and link them to a nonexistent tx.
 * @returns {Promise<{totalUi:number, sends:number, holders:number}>}
 */
async function getDistributedTotal(rewardToken) {
  const db = getDb();
  const [row] = await db
    .collection('airdrops')
    .aggregate([
      { $match: { reward_token: rewardToken, status: 'ok', signature: { $regex: REAL_TX_HASH } } },
      {
        $group: {
          _id: null,
          sends: { $sum: 1 },
          totalUi: { $sum: { $ifNull: ['$amount_ui', 0] } },
          recipients: { $addToSet: '$recipient' },
        },
      },
      { $project: { _id: 0, sends: 1, totalUi: 1, holders: { $size: '$recipients' } } },
    ])
    .toArray();
  return row || { totalUi: 0, sends: 0, holders: 0 };
}

/**
 * Everything this bot has bought and burned, summed from the buyback STEPS.
 *
 * Read from steps rather than cycles for the same reason the claim total is: a
 * step is written the moment it succeeds, while the cycle's columns are only
 * set at finish, so a cycle that burns and then fails later would drop its burn
 * from the total.
 *
 * Filtered on a real transaction hash, so DRY_RUN burns — recorded with a
 * fabricated `burn_ka9f2x` signature — can never inflate a number the site
 * shows to visitors. `burned: true` excludes the bought-but-not-burned state,
 * where the tokens exist and supply has NOT dropped.
 *
 * @returns {Promise<{tokensBurned:number, quoteSpent:number, burns:number}>}
 */
/**
 * One page of BURN events, newest first.
 *
 * Same source as getBurnTotal - a completed buyback step carrying a real
 * transaction hash - but as individual events rather than a sum, so the site
 * can show "874,649 NEKO destroyed" beside a link to the burn itself. The
 * totals alone could tell a visitor how much had been burned but never when,
 * or let them verify any of it.
 */
async function getBurnPage(limit, afterId = null) {
  const db = getDb();
  const filter = {
    name: 'buyback',
    status: 'ok',
    'detail.burned': true,
    signature: { $regex: REAL_TX_HASH },
  };
  if (afterId !== null && afterId !== undefined && afterId !== '') {
    filter.id = { $lt: Number(afterId) };
  }
  const found = await db
    .collection('steps')
    .find(filter, NO_ID)
    .sort({ id: -1 })
    .limit(limit + 1)
    .toArray();

  const rows = found.slice(0, limit);
  const more = found.length > limit;
  const last = rows[rows.length - 1];
  return { rows, nextCursor: more && last ? String(last.id) : null };
}

async function getBurnTotal() {
  const db = getDb();
  const [row] = await db
    .collection('steps')
    .aggregate([
      {
        $match: {
          name: 'buyback',
          status: 'ok',
          'detail.burned': true,
          signature: { $regex: REAL_TX_HASH },
        },
      },
      {
        $group: {
          _id: null,
          burns: { $sum: 1 },
          tokensBurned: { $sum: { $ifNull: ['$detail.tokensBought', 0] } },
          quoteSpent: { $sum: { $ifNull: ['$detail.quoteSpent', 0] } },
        },
      },
      { $project: { _id: 0, burns: 1, tokensBurned: 1, quoteSpent: 1 } },
    ])
    .toArray();
  return row || { tokensBurned: 0, quoteSpent: 0, burns: 0 };
}

/**
 * The fee gauge the site's /distribution endpoint serves.
 *
 * Written by the BOT (which can see the chain and the scheduler) and read by
 * the PUBLIC API (which can do neither). Mongo is the only thing the two
 * processes share, and going through it is what lets the API answer "how full
 * is the tank" without a wallet key or an RPC of its own.
 */
async function setDistributionState(patch) {
  const db = getDb();
  await db.collection('state').updateOne(
    { _id: 'distribution' },
    { $set: { ...patch, at: new Date().toISOString() } },
    { upsert: true }
  );
}

/**
 * The holder index: every balance, and the block they were correct at.
 *
 * Written together and never apart. The index is a fold over an append-only
 * log, so it is not idempotent — re-applying a block doubles it — and the ONLY
 * thing that keeps it honest is lastBlock advancing past exactly what was
 * applied. A balance map saved without its block, or a block saved without its
 * balances, is a wrong airdrop waiting to happen.
 */
async function getHolderIndex(token) {
  const db = getDb();
  return db.collection('holderindex').findOne({ _id: String(token).toLowerCase() }, { projection: { _id: 0 } });
}

async function setHolderIndex(token, { lastBlock, balances }) {
  const db = getDb();
  await db.collection('holderindex').updateOne(
    { _id: String(token).toLowerCase() },
    { $set: { lastBlock, balances, at: new Date().toISOString() } },
    { upsert: true }
  );
}

async function getDistributionState() {
  const db = getDb();
  return db.collection('state').findOne({ _id: 'distribution' }, { projection: { _id: 0 } });
}

/**
 * Tokens this bot bought to burn but could not burn.
 *
 * Carried forward so a failed burn is retried on the next cycle instead of
 * sitting in the wallet forever. Tracked as a NUMBER OF TOKENS THE BOT BOUGHT,
 * never as "whatever the wallet holds": the signing wallet is also the dev
 * wallet and may hold NEKO personally, which must never be burned.
 */
async function setPendingBurn(raw) {
  const db = getDb();
  await db.collection('state').updateOne(
    { _id: 'burn' },
    { $set: { pendingRaw: String(raw), at: new Date().toISOString() } },
    { upsert: true }
  );
}

async function getPendingBurn() {
  const db = getDb();
  const doc = await db.collection('state').findOne({ _id: 'burn' });
  try {
    return BigInt((doc && doc.pendingRaw) || '0');
  } catch (_err) {
    return 0n;
  }
}

module.exports = {
  createCycle,
  setDistributionState,
  setPendingBurn,
  getPendingBurn,
  getDistributionState,
  getHolderIndex,
  setHolderIndex,
  finishCycle,
  addStep,
  getBurnTotal,
  getBurnPage,
  getCycleWithSteps,
  getCycles,
  getLastCycle,
  getStats,
  addAirdrop,
  getAirdropPage,
  getDistributedTotal,
};

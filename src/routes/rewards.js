'use strict';

// GET /rewards?cursor=<rowId>&limit=<1..50> — the live payout feed.
//
// The site's REWARDS window (RewardsScene.jsx) polls this every 15s with no
// query string and renders `transactions` as one scrollable ledger, so the
// default page is the full 50. Shape, per its mockData.js:
//
//   { "transactions": [{ "id", "wallet", "amount", "txHash", "timestamp" }], ... }
//
// `amount` is an NVDA token amount (the site formats it and appends its own
// reward ticker), `timestamp` is ISO-8601, `txHash` is linked to the Robinhood
// Chain explorer by the site. `symbol`/`txUrl` are deliberately omitted so the
// site's own SITE.rewardTicker applies. `txUrl` IS sent, though: the site only
// builds its own link when the API omits one, and its fallback points at
// Ethereum's explorer rather than this chain's.
//
// The same page is also returned as `rows` (+ `nextCursor`) for the
// cursor-paging frontends in this lineage — `at` there is epoch ms. See
// services/rewardsfeed.js for where the rows come from.

const express = require('express');
const config = require('../config');
const { getGauge } = require('../services/feegauge');
const { secondsUntilNext } = require('../services/nextrun');

/**
 * The fee meter, in the shape the site's normaliser expects.
 *
 * Its status vocabulary differs from ours: it knows 'charging' / 'ready' /
 * 'distributing', where the bot records 'collecting' / 'distributing'. Anything
 * unrecognised silently collapses to 'charging', which would strand the meter
 * mid-cycle, so the mapping is explicit.
 */
async function buildMeter() {
  const g = await getGauge();
  if (!g) return null;
  const accumulated = Number(g.collectedUsd || 0);
  const threshold = Number(g.thresholdUsd || config.claimEveryUsd);
  const status =
    g.status === 'distributing' ? 'distributing' : accumulated >= threshold ? 'ready' : 'charging';
  return { accumulated_usd: accumulated, threshold_usd: threshold, status };
}
const { getFeedPage, parseCursor } = require('../services/rewardsfeed');

const router = express.Router();

const MAX_LIMIT = 50; // one Blockscout page
const DEFAULT_LIMIT = MAX_LIMIT; // the site asks for "the feed", not a page

/**
 * Pure: query string -> { cursor, limit }. Limit is clamped into 1..MAX and
 * junk falls back to the default; a malformed cursor throws with status 400.
 */
function parseQuery(query = {}) {
  const raw = typeof query.limit === 'string' ? Number(query.limit) : NaN;
  const limit = Number.isFinite(raw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw))) : DEFAULT_LIMIT;

  let cursor = query.cursor;
  if (cursor === undefined || cursor === '') cursor = null;
  parseCursor(cursor); // validates (arrays and garbage included) — throws 400
  return { cursor, limit };
}

/** Pure: a feed row (`at` in epoch ms) -> the site's transaction (ISO `timestamp`). */
function toTransaction(row) {
  return {
    id: row.id,
    wallet: row.wallet,
    amount: row.amount,
    txHash: row.txHash,
    txUrl: row.txUrl,
    timestamp: row.at === null ? null : new Date(row.at).toISOString(),
  };
}

/** Pure: the cached page -> the response body, serving both shapes. */
function presentPage(page) {
  const transactions = page.rows.map(toTransaction);
  return {
    // Three names for one list, because the frontends in this lineage disagree
    // about which to read and none of them falls back to the others:
    //   `transactions` — the space-inu RewardsScene
    //   `items`        — the space-inu-site rewards feed, which checks
    //                    items -> rewards -> data and would otherwise render
    //                    an empty feed against a perfectly healthy API
    //   `rows`         — the cursor-paging frontends (epoch-ms `at`)
    transactions,
    items: transactions,
    //   `data` + `meter` — the Artificial Neko site. Its normaliser reads
    //     `json.data ?? json.rewards ?? json` and THROWS on anything that is
    //     not an array, so without `data` a perfectly healthy API renders as
    //     "Unexpected rewards payload shape".
    data: transactions,
    rows: page.rows,
    meter: page.meter || null,
    nextCursor: page.nextCursor,
  };
}

router.get('/rewards', async (req, res) => {
  let q;
  try {
    q = parseQuery(req.query);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  try {
    const [page, meter] = await Promise.all([
      getFeedPage(q.cursor, q.limit),
      // The site draws its fee meter from the same call as the feed, so serve
      // both together rather than making it poll twice.
      buildMeter().catch(() => null),
    ]);
    res.json(presentPage({ ...page, meter }));
  } catch (err) {
    // Nothing cached for this page and the upstream is down. A 502 makes the
    // site show its retry state; an empty 200 would read as "no payouts yet".
    console.warn('[artificialneko] rewards feed unavailable:', err.message);
    res.status(502).json({ error: 'rewards feed unavailable' });
  }
});

/**
 * Pure: the fee meter in the shape the site's RewardMeter documents.
 *
 * Kept separate from buildMeter above rather than merged: that one feeds the
 * `meter` object inside GET /rewards and other frontends in this lineage read
 * it, so its snake_case keys and three-state vocabulary are a settled contract.
 * This one is the site's four-state contract, countdown included.
 *
 * `idle` and `charging` are not the same claim. An empty pot has nothing
 * happening; a partly full one is visibly filling, and the site animates them
 * differently.
 *
 * @param {object} gauge the stored distribution state
 * @param {number|null} secondsUntilCheck null when the schedule is unreadable
 */
function buildMeterPayload(gauge, secondsUntilCheck) {
  const g = gauge || {};
  const accumulatedUsd = Number(g.collectedUsd || 0);
  const thresholdUsd = Number(g.thresholdUsd) > 0 ? Number(g.thresholdUsd) : config.claimEveryUsd;

  // Order matters. A cycle mid-payout says so even on an empty pot, because it
  // has just emptied it. Only then does the amount decide.
  const state =
    g.status === 'distributing'
      ? 'distributing'
      : accumulatedUsd >= thresholdUsd
        ? 'ready'
        : accumulatedUsd <= 0.01
          ? 'idle'
          : 'charging';

  return { accumulatedUsd, thresholdUsd, secondsUntilCheck, state };
}

// The site polls this every 30s and re-fetches the moment its countdown hits
// zero — that is when the backend either distributes or rolls the window over.
router.get('/rewards/meter', async (req, res) => {
  try {
    const gauge = await getGauge();
    res.json(buildMeterPayload(gauge, secondsUntilNext(config.triggerSchedule)));
  } catch (err) {
    // The meter has no honest empty state — its normaliser throws without a
    // pot — so a 502 gives the panel its retry button rather than a zeroed
    // gauge that looks like a stalled bot.
    console.warn('[artificialneko] fee meter unavailable:', err.message);
    res.status(502).json({ error: 'fee meter unavailable' });
  }
});

module.exports = { router, parseQuery, presentPage, buildMeterPayload, DEFAULT_LIMIT, MAX_LIMIT };

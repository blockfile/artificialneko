'use strict';

// GET /burns — the buyback-and-burn feed.
//
// Deliberately its own endpoint rather than extra rows inside /rewards: the
// site's payout feed has a settled shape that frontends already parse, and
// quietly mixing a different kind of row into it would break them.

const express = require('express');
const { getFeedPage } = require('../services/burnsfeed');
const { parseQuery, DEFAULT_LIMIT, MAX_LIMIT } = require('./rewards');

const router = express.Router();

function presentPage(page) {
  const transactions = page.rows;
  return {
    // Three names for one list, matching /rewards, so whichever key a frontend
    // reaches for it finds the same rows.
    transactions,
    items: transactions,
    rows: transactions,
    nextCursor: page.nextCursor,
  };
}

router.get('/burns', async (req, res) => {
  let q;
  try {
    q = parseQuery(req.query);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  try {
    res.json(presentPage(await getFeedPage(`${q.cursor || ''}|${q.limit}`, q.cursor, q.limit)));
  } catch (err) {
    console.warn('[artificialneko] burns feed unavailable:', err.message);
    res.status(502).json({ error: 'burns feed unavailable' });
  }
});

module.exports = { router, presentPage, DEFAULT_LIMIT, MAX_LIMIT };

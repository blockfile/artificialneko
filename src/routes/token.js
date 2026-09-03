'use strict';

// GET /token — the site's App.jsx fetches this once on load and reads
// `ticker` (falling back to its own SITE.ticker if the call fails). Serving it
// keeps the console clean of a 404 per visit and lets the ticker/CA be set in
// one place (.env) once the token launches. Shape follows the site's
// mockData.js `mockToken`; fields the API has no source for are omitted so the
// site's hand-edited copy (tagline, narrative, buyUrl) wins.

const express = require('express');
const config = require('../config');

const router = express.Router();

/** Pure: the token identity the site reads. */
function buildToken({ name, symbol, tokenAddress }) {
  return {
    name,
    ticker: `$${symbol}`,
    symbol,
    contractAddress: tokenAddress ?? null, // null until launch — the site shows a dash
    chain: 'Robinhood Chain',
  };
}

router.get('/token', (req, res) => {
  res.json(buildToken({ name: config.tokenName, symbol: config.tokenSymbol, tokenAddress: config.tokenAddress }));
});

module.exports = { router, buildToken };

'use strict';

// GET /distribution — the fee gauge behind the site's launch animation.
//
//   { collectedUsd, thresholdUsd, status, lastDistributionId, lastDistributionAt }
//
// `status` is "collecting" or "distributing"; the site holds its launch
// animation on the latter. It also resets the gauge whenever
// lastDistributionId / lastDistributionAt changes, which is how the backend
// says "a payout landed" without needing a socket.
//
// The numbers come from the bot's ledger (see services/feegauge.js), so this
// route makes no chain call and needs no wallet.

const express = require('express');
const { getGauge } = require('../services/feegauge');

const router = express.Router();

router.get('/distribution', async (req, res, next) => {
  try {
    res.json(await getGauge());
  } catch (err) {
    next(err);
  }
});

module.exports = { router };

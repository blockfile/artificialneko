'use strict';

// Operator control for the bot process.
//
// bot.js binds this to 127.0.0.1 and it is additionally gated by API_KEY, so it
// is reachable only over SSH. POST /run pays real money out; that is not a
// thing to expose to the internet, and it is deliberately absent from the
// public server.js.

const express = require('express');
const { formatEther } = require('ethers');
const config = require('../config');
const scheduler = require('../jobs/scheduler');
const { getFeeRecipientCheck } = require('../jobs/cycle');
const { provider, walletAddress } = require('../evm/provider');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();
router.use(requireApiKey);

/**
 * Pure: assemble the operator status payload.
 *
 * Unknowns are null, never 0 — `feeRecipientOk: null` means no cycle has
 * checked yet, while `false` means the launch pays someone else entirely.
 * Collapsing those two would turn every cold start into a false alarm.
 */
function buildStatus({ scheduler: s, feeCheck, walletAddress: address, ethBalance }) {
  return {
    dryRun: config.dryRun,
    tokenSymbol: config.tokenSymbol,
    // false = the launch pays creator fees somewhere else and the cycle can
    // never claim. The single most important flag in this response.
    feeRecipientOk: feeCheck ? feeCheck.ok : null,
    creatorFeeRecipient: feeCheck ? feeCheck.actual : null,
    claimableQuote: s.lastClaimable ?? null,
    claimableUsd: s.lastClaimableUsd ?? null,
    nvdaPriceUsd: s.lastPriceUsd ?? null,
    trigger: {
      mode: config.triggerMode,
      claimEveryUsd: config.claimEveryUsd,
      schedule: config.pollSchedule,
    },
    // All four shares, so they visibly add to 100. Reporting only reward and
    // dev made the split read as 65/0 — numbers that do not reach the claim and
    // leave an operator hunting for the missing third.
    split: {
      rewardPct: config.rewardPct,
      burnPct: config.burnPct,
      gasPct: config.gasPct,
      devPct: config.devPct,
      minHold: config.minHold,
      // null means the dev cut accumulates in the signing wallet — worth seeing.
      devPayoutAddress: config.devPayoutAddress,
    },
    wallet: {
      address,
      ephemeral: config.walletIsEphemeral,
      ethBalance,
      // Shown next to the balance on purpose: gas is not self-funding here, so
      // this pair is the thing an operator has to keep an eye on.
      gasReserveEth: config.gasReserveEth,
    },
    scheduler: s,
  };
}

router.get('/status', async (req, res, next) => {
  try {
    let ethBalance = null;
    if (!config.dryRun) {
      try {
        ethBalance = Number(formatEther(await provider.getBalance(walletAddress())));
      } catch (_err) {
        ethBalance = null; // an RPC blip must not take the status page down
      }
    }
    res.json(
      buildStatus({
        scheduler: scheduler.getState(),
        feeCheck: getFeeRecipientCheck(),
        walletAddress: walletAddress(),
        ethBalance,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/run', async (req, res) => {
  try {
    const result = await scheduler.triggerNow();
    if (result && result.skipped) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pause', (req, res) => res.json(scheduler.pause()));
router.post('/resume', (req, res) => res.json(scheduler.resume()));

module.exports = { router, buildStatus };

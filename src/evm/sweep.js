'use strict';

// Fees accrue ON the curve (pre-bond) or ON the hook (post-bond) and only reach
// the escrow when someone sweeps. So:
//
//   1. The TRIGGER must count unswept fees. Gating on the escrow alone
//      deadlocks — the bot sees zero, never sweeps, and nothing ever arrives.
//   2. A sweep may be refused. Both contracts revert when clearing pending
//      fees would need an internal swap, because only pons's trusted operator
//      may set that swap's slippage bound. That is expected, not exceptional:
//      the fees stay pending and the next cycle picks them up.
//
// Split math is transcribed from PonsV2BondingCurve._sweepFees and
// V2MemeHook._distribute — they are the same shape:
//
//   protocolAmount = pending * protocolFeeShareBps / 10000
//   creatorBucket  = pending - protocolAmount
//   buyback        = enabled ? min(buybackPending, creatorBucket) : 0
//   creatorAmount  = creatorBucket - buyback + creatorTax
//
// The creator tax bypasses the protocol split entirely and is paid in full.

const { Contract, formatUnits } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { CURVE_ABI, HOOK_ABI } = require('./abi');
const { NATIVE } = require('./pool');

const BPS = 10000n;

/** The creator's share of a pending fee bucket, after the protocol's cut. */
function creatorShareRaw(pendingRaw, protocolFeeShareBps) {
  const pending = BigInt(pendingRaw);
  if (pending <= 0n) return 0n;
  return (pending * (BPS - BigInt(protocolFeeShareBps))) / BPS;
}

/** Both contracts refuse a sweep that would need pons's trusted operator. */
function isOperatorOnlyError(err) {
  if (!err) return false;

  // Check error name (works after ABI declaration lets ethers decode the custom error)
  const m = String((err.shortMessage || err.message) || '');
  if (m.includes('InternalSwapRequiresOperator') || m.includes('NotFeeSweepOperator')) {
    return true;
  }

  // Check raw selector bytes — ethers error shape varies by provider and context.
  // InternalSwapRequiresOperator() = 0x31cdb504, NotFeeSweepOperator() = 0x8d42130c
  const data = String(
    (err.data) || (err.info && err.info.error && err.info.error.data) || (err.error && err.error.data) || ''
  );
  return data.includes('31cdb504') || data.includes('8d42130c');
}

function curveAt(address, runner = provider) {
  return new Contract(address, CURVE_ABI, runner);
}
function hookAt(runner = provider) {
  return new Contract(config.memeHook, HOOK_ABI, runner);
}

/**
 * Can WE sweep this pool right now, or does it need pons's trusted operator?
 *
 * Transcribed from V2MemeHook._requiresTrustedOperator: any memecoin-
 * denominated pending fee or creator tax, or a pending buyback in the quote,
 * locks the sweep to the operator — because clearing it needs an internal swap
 * whose slippage bound only pons may choose.
 *
 * This matters far more after graduation than before. On the hook, a BUY takes
 * its fee in the unspecified currency, which for a buy IS the memecoin — so on
 * an actively traded token there is nearly always memecoin-denominated pending,
 * and the creator can essentially never sweep. Those fees are not lost; pons's
 * operator sweeps them into the escrow, and the next cycle claims them.
 */
async function sweepBlockedByOperator(launch, hook = null) {
  if (!launch.graduated) return false;
  const h = hook || hookAt();
  const quote = launch.pairToken || NATIVE;
  const [feeInMeme, taxInMeme, buybackInQuote] = await Promise.all([
    h.pendingFees(launch.poolId, launch.token),
    h.pendingCreatorTax(launch.poolId, launch.token),
    h.pendingBuyback(launch.poolId, quote),
  ]);
  return feeInMeme > 0n || taxInMeme > 0n || buybackInQuote > 0n;
}

/**
 * Fees sitting unswept that WE could actually move into the escrow.
 *
 * Zero when the sweep is locked to pons's operator. Reporting the pending
 * amount there would be worse than useless: it is what the trigger measures, so
 * the bot fired every single minute on money it could not reach, swept nothing,
 * claimed nothing, and reset the site's gauge to zero on each pass.
 */
async function sweepableRaw(launch, hook = null) {
  if (config.dryRun) return 0n; // the sim vault models the escrow directly
  if (await sweepBlockedByOperator(launch, hook)) return 0n;
  return pendingCreditRaw(launch, hook);
}

/**
 * Everything the pool has accrued to US, whether or not we may sweep it today.
 *
 * The same arithmetic as sweepableRaw without the operator gate, because the
 * two answer different questions. The TRIGGER must ask "what can I claim right
 * now", or it fires on money it cannot reach. The site's fee gauge must ask
 * "how much has built up", or it reads $0 for hours while fees accrue behind
 * the lock and then jumps - which looks to a holder like a dead flywheel.
 *
 * Both are true. Only the second belongs on a progress bar.
 */
async function pendingCreditRaw(launch, hook = null) {
  if (config.dryRun) return 0n;

  if (!launch.graduated) {
    const c = curveAt(launch.curve);
    const [pending, tax, buyback, protocolBps] = await Promise.all([
      c.quoteFeeBalance(), c.creatorTaxBalance(), c.buybackQuoteBalance(), c.protocolFeeShareBps(),
    ]);
    const bucket = creatorShareRaw(pending, Number(protocolBps));
    const earmark = launch.buybackEnabled ? (buyback < bucket ? buyback : bucket) : 0n;
    return bucket - earmark + tax;
  }

  const h = hook || hookAt();
  const quote = launch.pairToken || NATIVE;
  const [info, pending, tax, buyback] = await Promise.all([
    h.launches(launch.poolId),
    h.pendingFees(launch.poolId, quote),
    h.pendingCreatorTax(launch.poolId, quote),
    h.pendingBuyback(launch.poolId, quote),
  ]);
  if (!info.registered) return 0n;
  const bucket = creatorShareRaw(pending, Number(info.protocolFeeShareBps));
  const earmark = info.buybackEnabled ? (buyback < bucket ? buyback : bucket) : 0n;
  return bucket - earmark + tax;
}

/**
 * Pending fees in whole NVDA. Named for the quote asset because that is what
 * this launch pays in — there is no ETH anywhere in this path, and the math
 * above already reads the hook keyed by `launch.pairToken`.
 */
async function sweepableQuote(launch) {
  return Number(formatUnits(await sweepableRaw(launch), config.quoteDecimals));
}

/** What has accrued to us, reachable or not — the number the gauge shows. */
async function pendingCreditQuote(launch) {
  return Number(formatUnits(await pendingCreditRaw(launch), config.quoteDecimals));
}

/**
 * Push pending fees into the escrow. Best-effort by design: a refusal is
 * reported, never thrown, so the cycle proceeds to claim whatever is already
 * in the escrow.
 */
async function sweepFees(launch) {
  // The simulated vault is accrued once per tick by the scheduler, NOT here.
  // Accruing in both places made a dry run's claim twice the balance the
  // scheduler had just reported, which made the numbers impossible to reason
  // about and left the "nothing claimed" branch unreachable under DRY_RUN.
  if (config.dryRun) {
    return { swept: true, skipped: false, reason: null, signature: `sweep_${Date.now().toString(36)}` };
  }

  // Passing minBuybackTokensOut = 0 is only safe while buyback is disabled: with
  // it enabled the contracts revert MinimumOutputRequired, which is NOT an
  // operator-only error and would therefore throw out of this function and fail
  // the cycle BEFORE it ever claims. Refuse the sweep instead, so the cycle
  // still collects whatever is already sitting in the escrow.
  if (launch.buybackEnabled) {
    const reason =
      'buyback is enabled on this launch — sweeping needs a slippage bound this bot does not set; ' +
      'fees stay pending and the escrow is claimed as usual';
    console.warn(`[sweep] ${reason}`);
    return { swept: false, skipped: true, reason, signature: null };
  }

  if (await sweepBlockedByOperator(launch)) {
    const reason =
      "pons's trusted operator must sweep this pool — memecoin-denominated fees " +
      'need an internal swap. They are not lost: the operator moves them to the ' +
      'escrow and the next cycle claims them.';
    console.warn(`[sweep] ${reason}`);
    return { swept: false, skipped: true, reason, signature: null };
  }

  const pending = await sweepableRaw(launch);
  if (pending <= 0n) {
    return { swept: false, skipped: true, reason: 'nothing pending to sweep', signature: null };
  }

  try {
    const tx = launch.graduated
      ? await hookAt(wallet).sweepPoolFees(launch.poolId, 0, 0)
      : await curveAt(launch.curve, wallet).sweepFees(0);
    await tx.wait();
    console.log(`[tx] sweep fees (${launch.graduated ? 'hook' : 'curve'}): ${tx.hash}`);
    return { swept: true, skipped: false, reason: null, signature: tx.hash };
  } catch (err) {
    if (isOperatorOnlyError(err)) {
      const reason = 'sweep needs pons\'s trusted operator — fees stay pending for the next cycle';
      console.warn(`[sweep] ${reason}`);
      return { swept: false, skipped: true, reason, signature: null };
    }
    throw err;
  }
}

module.exports = {
  creatorShareRaw, isOperatorOnlyError, sweepableRaw, sweepableQuote,
  sweepFees, sweepBlockedByOperator,
  pendingCreditRaw, pendingCreditQuote,
};

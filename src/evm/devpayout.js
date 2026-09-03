'use strict';

// Forward the dev cut to a cold address at the end of each cycle.
//
// Without this the dev cut simply accumulates in the bot wallet — the one whose
// private key sits in a .env file on an internet-facing server. Over months that
// turns a disposable hot wallet into the project treasury. Sending it out every
// cycle means the server wallet only ever holds gas plus the cut of the cycle
// currently in flight.
//
// DEV_PAYOUT_ADDRESS is an ADDRESS, never a key: the destination only receives,
// so its key can stay in a hardware wallet and never touch the server.
//
// This is deliberately NOT part of the airdrop:
//   - the dev cut is not a holder reward, and recording it as one would publish
//     it in the public /rewards feed and inflate `totalRewarded`;
//   - it must not disturb the invariant that airdrop allocations sum exactly to
//     the amount distributed to holders.
//
// It is also deliberately non-fatal. By the time it runs the escrow has been
// claimed and the holders have been paid; a failure here means the cut is still
// ours, just sitting in the hot wallet instead of the cold one. Failing the
// cycle over that would mark a successful airdrop as failed.

const { parseUnits, formatEther } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { readTokenBalance } = require('./erc20');
const { sendTx } = require('./send');
const { toUnitString } = require('./units');
const { swapQuoteForGas } = require('./gasswap');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Pure: a one-line log/description of what the dev payout did. */
function describeOutcome(result) {
  if (result.skipped) return `dev payout skipped: ${result.reason}`;
  if (result.sent) return `dev payout sent ${result.ethSent} ETH (from ${result.amount} ${config.quoteSymbol}) -> ${result.to}`;
  return `dev payout FAILED (${result.error}) — the cut stays in the bot wallet and is retried next cycle`;
}

/**
 * Send `quoteAmount` NVDA to DEV_PAYOUT_ADDRESS.
 *
 * @param {{quoteAmount: number}} opts
 * @returns {Promise<{sent:boolean, skipped:boolean, reason?:string, error?:string,
 *                    signature:string|null, amount:number, to:string|null}>}
 */
async function sendDevPayout({ quoteAmount }) {
  const to = config.devPayoutAddress;
  const base = { sent: false, skipped: false, signature: null, amount: quoteAmount, ethSent: 0, to };

  if (!to) {
    return {
      ...base,
      skipped: true,
      reason: 'DEV_PAYOUT_ADDRESS not set — the dev cut stays in the bot wallet',
    };
  }
  if (!(quoteAmount > 0)) {
    return { ...base, skipped: true, reason: 'dev cut is zero' };
  }

  if (config.dryRun) {
    return { ...base, sent: true, ethSent: +(quoteAmount * 0.2).toFixed(9), signature: fakeSig('devpayout') };
  }

  const wanted = parseUnits(toUnitString(quoteAmount, config.quoteDecimals), config.quoteDecimals);
  // Same clamp as the buyback, for the same reason: the legs are rounded
  // decimals and this one runs last of all.
  const held = await readTokenBalance(config.quoteTokenAddress, wallet.address);
  const raw = wanted <= held ? wanted : held;
  if (raw <= 0n) {
    return { ...base, skipped: true, reason: 'dev cut rounds to zero base units' };
  }

  try {
    // Paid in ETH, not in the quote asset. The cut is spending money and a
    // tokenized stock is a poor thing to be paid in - so it takes the same
    // NVDA -> WETH -> unwrap route the gas leg uses, then forwards the native
    // ETH. Two hops, but the destination receives something it can actually use.
    const swap = await swapQuoteForGas({ quoteAmount: Number(toUnitString(quoteAmount, config.quoteDecimals)) });
    if (!swap.swapped) {
      return { ...base, skipped: true, reason: `could not convert the dev cut to ETH: ${swap.reason || swap.error}` };
    }

    const value = parseUnits(toUnitString(swap.ethReceived, 18), 18);
    if (value <= 0n) return { ...base, skipped: true, reason: 'the converted dev cut rounds to zero wei' };

    const tx = await sendTx(() => wallet.sendTransaction({ to, value }));
    await tx.wait();
    console.log(`[tx] dev payout ${formatEther(value)} ETH -> ${to}: ${tx.hash}`);
    return { ...base, sent: true, ethSent: Number(formatEther(value)), signature: tx.hash };
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    console.error(`[devpayout] ${error}`);
    return { ...base, sent: false, error };
  }
}

module.exports = { sendDevPayout, describeOutcome };

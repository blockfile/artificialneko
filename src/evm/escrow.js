'use strict';

// The V2FeeEscrow is where BOTH launch phases deliver the creator's share.
//
// For this launch that share is NVDA, not native ETH: pons pays creator fees in
// whatever the launch is priced in, and NEKO is priced in NVDA. So every
// read and write here uses the TOKEN path — `balanceOfToken` / `claimToken` —
// and the native `balanceOf` / `claim` pair is deliberately never called.
// Calling the native one would not error; it would quietly return zero, the
// trigger would never fire, and the bot would look healthy while collecting
// nothing. That silent-zero failure is the whole reason this module exists.
//
// The claimed amount comes from the contract's own ClaimedToken event rather
// than a balance delta, so a transfer landing in the same block cannot inflate
// it. Escrow balances are per-recipient ACROSS ALL LAUNCHES, so a single claim
// collects this wallet's NVDA from every launch it is the fee recipient of —
// which is why the parser sums matching events rather than taking the first.

const { Contract, Interface, formatUnits } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { ESCROW_ABI } = require('./abi');
const simvault = require('./simvault');

const ESCROW_IFACE = new Interface(ESCROW_ABI);
const CLAIMED_TOKEN_TOPIC = ESCROW_IFACE.getEvent('ClaimedToken').topicHash;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function escrow(runner = provider) {
  return new Contract(config.feeEscrow, ESCROW_ABI, runner);
}

/**
 * Pure: total credited to `recipient` for `token` by this receipt's logs.
 *
 * Filters on all three of emitting contract, recipient and token. Both
 * `recipient` and `token` are indexed, so they arrive as topics and only
 * `amount` sits in data. Anything else in the receipt is skipped rather than
 * throwing — one unrelated or undecodable log must not fail a claim that has
 * already happened on chain.
 *
 * @param {readonly object[]} logs receipt logs
 * @param {string} escrowAddress
 * @param {string} recipient
 * @param {string} token
 * @returns {bigint}
 */
function parseClaimedAmount(logs, escrowAddress, recipient, token) {
  const wantEscrow = String(escrowAddress).toLowerCase();
  const wantRecipient = String(recipient).toLowerCase();
  const wantToken = String(token).toLowerCase();

  let claimed = 0n;
  for (const log of logs || []) {
    if (String(log.address).toLowerCase() !== wantEscrow) continue;
    if (!log.topics || log.topics[0] !== CLAIMED_TOKEN_TOPIC) continue;
    let parsed;
    try {
      parsed = ESCROW_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch (_err) {
      continue; // not ours to read
    }
    if (String(parsed.args.recipient).toLowerCase() !== wantRecipient) continue;
    if (String(parsed.args.token).toLowerCase() !== wantToken) continue;
    claimed += parsed.args.amount;
  }
  return claimed;
}

/** NVDA already swept into the escrow and withdrawable right now, in whole tokens. */
async function escrowBalanceQuote() {
  if (config.dryRun) return simvault.peek();
  const raw = await escrow().balanceOfToken(wallet.address, config.quoteTokenAddress);
  return Number(formatUnits(raw, config.quoteDecimals));
}

/** Withdraw the whole NVDA escrow balance. Amount comes from the ClaimedToken event. */
async function claimQuoteFromEscrow() {
  if (config.dryRun) {
    const quoteClaimed = +simvault.drain().toFixed(9);
    return { signature: fakeSig('claim'), quoteClaimed, simulated: true };
  }

  const balance = await escrow().balanceOfToken(wallet.address, config.quoteTokenAddress);
  if (balance <= 0n) {
    return { signature: null, quoteClaimed: 0, simulated: false, note: 'escrow empty' };
  }

  const tx = await escrow(wallet).claimToken(config.quoteTokenAddress);
  const receipt = await tx.wait();
  console.log(`[tx] claimToken(${config.quoteSymbol || 'NVDA'}) from fee escrow: ${tx.hash}`);

  const claimed = parseClaimedAmount(
    receipt.logs,
    config.feeEscrow,
    wallet.address,
    config.quoteTokenAddress
  );
  return {
    signature: tx.hash,
    quoteClaimed: Number(formatUnits(claimed, config.quoteDecimals)),
    simulated: false,
  };
}

module.exports = { escrowBalanceQuote, claimQuoteFromEscrow, parseClaimedAmount, escrow };

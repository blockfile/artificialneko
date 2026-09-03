'use strict';

// Permit2 allowances for the buyback swap.
//
// The v4 UniversalRouter does not pull ERC-20 inputs with a plain allowance — it
// pulls them through Permit2. So spending NVDA needs TWO approvals, and both are
// easy to forget because the bot needed neither while it only ever spent native
// ETH:
//
//   1. a normal ERC-20 approve of NVDA to the Permit2 contract, and
//   2. a Permit2 allowance naming the UniversalRouter as spender, which carries
//      its own uint48 expiration and silently stops working when it lapses.
//
// Both are checked and topped up before each swap rather than assumed. An
// expired Permit2 allowance is the classic cause of a swap that worked
// yesterday and reverts today, and here it would revert AFTER the escrow had
// been claimed and the holders paid.
//
// Amounts are set to the uint160/uint256 maximum rather than the exact swap
// size: a fresh approval per cycle would double the transaction count and the
// gas for no security gain, since this wallet holds only what it is about to
// spend anyway.

const { Contract, MaxUint256 } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { ERC20_ABI, PERMIT2_ABI } = require('./abi');
const { sendTx } = require('./send');

// Permit2 stores allowances as uint160 with a uint48 expiration.
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

// Re-approve when less than this is left, rather than at exactly zero, so a
// swap cannot land in the gap between "just enough" and "not enough".
const TOPUP_THRESHOLD = MAX_UINT160 / 2n;
// Re-approve when the expiry is inside this window, for the same reason.
const EXPIRY_MARGIN_SEC = 3600;

function permit2(runner = provider) {
  return new Contract(config.permit2, PERMIT2_ABI, runner);
}
function token(address, runner = provider) {
  return new Contract(address, ERC20_ABI, runner);
}

/**
 * Pure: does this (amount, expiration) pair still cover an upcoming swap?
 *
 * @param {{amount: bigint, expiration: bigint|number, needed: bigint, nowSec: number}} args
 * @returns {boolean}
 */
function permit2AllowanceIsSufficient({ amount, expiration, needed, nowSec }) {
  if (BigInt(amount) < BigInt(needed)) return false;
  const exp = Number(expiration);
  // 0 means "no allowance", not "never expires".
  if (exp === 0) return false;
  return exp > nowSec + EXPIRY_MARGIN_SEC;
}

/**
 * Make sure the router can pull `needed` of `tokenAddress` from this wallet.
 * Sends at most two transactions, and usually none.
 *
 * @param {{tokenAddress: string, spender: string, needed: bigint}} opts
 * @returns {Promise<{erc20Approved: boolean, permit2Approved: boolean}>}
 */
async function ensurePermit2Allowance({ tokenAddress, spender, needed }) {
  let erc20Approved = false;
  let permit2Approved = false;

  // 1. NVDA -> Permit2 (a plain ERC-20 allowance).
  const erc20Allowance = await token(tokenAddress).allowance(wallet.address, config.permit2);
  if (erc20Allowance < BigInt(needed)) {
    console.log(`[permit2] approving ${tokenAddress} to Permit2`);
    const tx = await sendTx(() => token(tokenAddress, wallet).approve(config.permit2, MaxUint256));
    await tx.wait();
    erc20Approved = true;
  }

  // 2. Permit2 -> router (amount + expiration).
  const [amount, expiration] = await permit2().allowance(wallet.address, tokenAddress, spender);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!permit2AllowanceIsSufficient({ amount, expiration, needed, nowSec })) {
    console.log(`[permit2] approving ${tokenAddress} -> ${spender}`);
    const tx = await sendTx(() =>
      permit2(wallet).approve(tokenAddress, spender, MAX_UINT160, MAX_UINT48)
    );
    await tx.wait();
    permit2Approved = true;
  }

  return { erc20Approved, permit2Approved };
}

module.exports = {
  ensurePermit2Allowance,
  permit2AllowanceIsSufficient,
  MAX_UINT160,
  MAX_UINT48,
  TOPUP_THRESHOLD,
  EXPIRY_MARGIN_SEC,
};

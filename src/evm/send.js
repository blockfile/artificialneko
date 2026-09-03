'use strict';

// Nonce-safe transaction sending.
//
// This bot fires several txs per cycle from ONE wallet (sweep → claim → buy →
// airdrop). Nonces are assigned by ethers reading getTransactionCount from
// the RPC at send time. Robinhood Chain's public RPC is load-balanced across
// nodes with slightly divergent views, so right after a tx is mined the next
// send can read a STALE nonce and be built with an already-used value — the node
// then rejects it with "nonce too low" / NONCE_EXPIRED. That is exactly what
// killed cycle 4's airdrop (built nonce 210, chain state 211 → all 68 failed).
//
// A rejected "nonce too low" tx never entered a block, so re-sending is safe:
// each resend re-reads the nonce fresh, and a short backoff lets the lagging node
// catch up. We ONLY retry the stale-nonce family (safe to resend) — never
// "already known" / replacement errors, where a tx with that nonce is already in
// the mempool and a resend could conflict.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * True for errors that mean the built nonce is BEHIND the chain (the tx was
 * rejected and can be safely re-sent with a fresh nonce).
 */
function isNonceError(err) {
  if (!err) return false;
  if (err.code === 'NONCE_EXPIRED') return true;
  const msg = String(
    err.shortMessage || (err.info && err.info.error && err.info.error.message) || err.message || ''
  ).toLowerCase();
  return msg.includes('nonce too low') || msg.includes('nonce has already been used');
}

/**
 * Send a transaction, retrying on transient stale-nonce errors. `send` must
 * (re)build AND submit the tx on each call and return the ethers
 * TransactionResponse — rebuilding is what lets ethers pick up a fresh nonce on
 * each attempt. Non-nonce errors (e.g. a revert) propagate immediately.
 *
 * @param {() => Promise<import('ethers').TransactionResponse>} send
 * @param {{retries?: number, delayMs?: number, sleepFn?: (ms:number)=>Promise<void>}} [opts]
 * @returns {Promise<import('ethers').TransactionResponse>}
 */
async function sendTx(send, { retries = 4, delayMs = 2000, sleepFn = sleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (err) {
      if (attempt >= retries || !isNonceError(err)) throw err;
      console.warn(
        `[tx] stale nonce (${err.code || 'nonce too low'}) — resending in ${delayMs}ms (attempt ${attempt + 1}/${retries})`
      );
      await sleepFn(delayMs);
    }
  }
}

module.exports = { sendTx, isNonceError };

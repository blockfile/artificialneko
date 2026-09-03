'use strict';

// Prove the quote asset is the real NVDA before the bot spends a cycle on it.
//
// At least five impostor NVDA tokens exist on this chain, several carrying the
// same name and symbol as the genuine one. A bot pointed at a fake would claim
// nothing, buy nothing, and look merely idle -- or worse, swap real value into
// a token nobody wants. Symbol and name are attacker-controlled and prove
// nothing; the deployed bytecode does not.
//
// Every genuine Robinhood tokenized stock is the same 283-byte beacon proxy, so
// SPCX, AMD and NVDA share one code hash. Comparing against that hash
// identifies the real ones as a family rather than pinning a single address,
// which also means a new stock ticker passes without a code change.

const { keccak256 } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');

// keccak256 of the beacon-proxy runtime shared by every genuine tokenized
// stock on chain 4663. Verified identical across SPCX, AMD and NVDA.
const STOCK_CODE_HASH = '0x6c1fdd40';

/**
 * @returns {Promise<{ok: boolean, reason?: string, codeHash?: string}>}
 */
async function checkQuoteToken(address = config.quoteTokenAddress) {
  if (!address) return { ok: false, reason: 'QUOTE_TOKEN_ADDRESS is not set' };
  const code = await provider.getCode(address);
  if (!code || code === '0x') {
    return { ok: false, reason: `no contract deployed at ${address}` };
  }
  const hash = keccak256(code);
  if (!hash.startsWith(STOCK_CODE_HASH)) {
    return {
      ok: false,
      codeHash: hash,
      reason:
        `${address} does not have the bytecode every genuine Robinhood tokenized stock shares. ` +
        'At least five impostor NVDA tokens exist on this chain, some using the same name and ' +
        'symbol — check the address against the explorer before running.',
    };
  }
  return { ok: true, codeHash: hash };
}

/** Same check, but fatal. Called at startup so a wrong address stops the bot
 *  before it claims anything rather than after. */
async function assertQuoteToken(address = config.quoteTokenAddress) {
  const r = await checkQuoteToken(address);
  if (!r.ok) throw new Error(`refusing to start: ${r.reason}`);
  return r;
}

module.exports = { checkQuoteToken, assertQuoteToken, STOCK_CODE_HASH };

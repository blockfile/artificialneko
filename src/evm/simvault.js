'use strict';

// In-memory simulated fee vault, used ONLY in DRY_RUN so the trigger and the
// cycle can be exercised without real fees.
//
// Amounts are NVDA, not ETH: this launch is quoted in NVDA, so that is what the
// escrow pays out. Live mode never touches this — real fees accrue on the
// bonding curve or the V2MemeHook and reach the escrow via a sweep.
let balanceQuote = 0;

// Add `rate` NVDA to the simulated vault; returns the new balance.
function accrue(rate) {
  balanceQuote += Number(rate) || 0;
  return balanceQuote;
}

// Current simulated balance, WITHOUT mutating it.
function peek() {
  return balanceQuote;
}

// Claim the whole vault: return the balance and reset to 0.
function drain() {
  const quote = balanceQuote;
  balanceQuote = 0;
  return quote;
}

// Test helper — force the balance to a known value.
function reset(quote = 0) {
  balanceQuote = Number(quote) || 0;
  return balanceQuote;
}

module.exports = { accrue, peek, drain, reset };

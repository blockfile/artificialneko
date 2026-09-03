'use strict';

// Addresses that hold the token but are not people. On v4 the POOL MANAGER is
// the big one: it custodies every pool's liquidity, so it shows up as one of the
// largest holders of any graduated token. Pre-graduation the BONDING CURVE holds
// the entire unsold supply and would otherwise take almost the whole airdrop.

const config = require('../config');
const { wallet } = require('./provider');

async function buildExcludeSet(launch = null) {
  const set = new Set();
  const add = (a) => { if (a) set.add(String(a).toLowerCase()); };

  add(wallet.address);        // us
  add(config.deadAddress);    // supply holders burned themselves
  add(config.poolManager);    // v4 liquidity custodian
  add(config.memeHook);       // pending fee inventory
  add(config.buybackVault);   // vesting locks
  add(config.feeEscrow);      // fee custody
  add(config.v2Factory);      // launch plumbing
  add(config.quoteTokenAddress);   // the quote asset's own contract
  add(config.rewardTokenAddress);  // and the reward token's
  if (launch && launch.curve) add(launch.curve); // unsold supply pre-graduation
  for (const a of config.airdropExclude) add(a);

  return set;
}

module.exports = { buildExcludeSet };

'use strict';
const { Contract } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { ERC20_ABI } = require('./abi');

const decimalsCache = new Map();

// DRY_RUN must simulate EVERY chain call. A pons v2 launch mints 1e9 tokens at
// 18 decimals, so that is the supply a dry run reasons about — without it, the
// REWARD_CAP_PCT path is the one read that still needs a live RPC, and a dry
// run against an unreachable node dies AFTER the simulated buy is recorded.
const SIM_TOTAL_SUPPLY_RAW = 1_000_000_000n * 10n ** 18n;

function erc20(address, runner = provider) {
  return new Contract(address, ERC20_ABI, runner);
}

/** decimals() never changes, so read it once per token per process. */
async function getDecimals(address) {
  const key = String(address).toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const d = Number(await erc20(address).decimals());
  decimalsCache.set(key, d);
  return d;
}

async function readTokenBalance(token, owner) {
  return erc20(token).balanceOf(owner);
}

async function getTokenSupplyRaw(token) {
  if (config.dryRun) return SIM_TOTAL_SUPPLY_RAW;
  return erc20(token).totalSupply();
}

// Test seam only — lets a unit test assert the cache without a chain read.
function __setDecimalsCache(address, value) {
  decimalsCache.set(String(address).toLowerCase(), value);
}

module.exports = {
  erc20, getDecimals, readTokenBalance, getTokenSupplyRaw,
  SIM_TOTAL_SUPPLY_RAW, __setDecimalsCache, wallet,
};

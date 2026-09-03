'use strict';

// Uniswap v4 addresses a pool by the hash of its PoolKey rather than by a pool
// contract address — there is no pool contract. Every hook read (pendingFees,
// launches, sweepPoolFees) is keyed by that hash, and a wrong hash reads zeros
// rather than reverting, so the derivation is asserted against a real pool in
// pool.test.js.

const { Contract, AbiCoder, keccak256, getAddress } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');
const { QUOTE_SINGLE_TYPE, V4_QUOTER_ABI } = require('./abi');

const NATIVE = '0x0000000000000000000000000000000000000000';
const coder = AbiCoder.defaultAbiCoder();

/** Build a canonical PoolKey. Currencies sort ascending by address; native ETH
 *  is address(0) and therefore always currency0. */
function buildPoolKey({ token, quoteToken = NATIVE, fee, tickSpacing, hooks }) {
  const a = getAddress(token);
  const b = getAddress(quoteToken);
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: getAddress(hooks) };
}

/** poolId = keccak256(abi.encode(PoolKey)). Field order is load-bearing. */
function poolIdOf(key) {
  return keccak256(
    coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

/** True when `currencyIn` is currency0 — the direction flag v4 swaps take. */
function isZeroForOne(key, currencyIn) {
  return getAddress(currencyIn).toLowerCase() === key.currency0.toLowerCase();
}

/** Quote an exact-in swap. The quoter reverts to return its answer, so it is
 *  not a view function and must be reached with staticCall. */
async function quoteExactInSingle({ poolKey, zeroForOne, amountIn }) {
  const quoter = new Contract(config.v4Quoter, V4_QUOTER_ABI, provider);
  const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
    poolKey: [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    zeroForOne,
    exactAmount: amountIn,
    hookData: '0x',
  });
  return amountOut;
}

module.exports = { NATIVE, buildPoolKey, poolIdOf, isZeroForOne, quoteExactInSingle, QUOTE_SINGLE_TYPE };

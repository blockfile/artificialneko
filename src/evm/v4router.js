'use strict';

// Uniswap v4 swaps go through the UniversalRouter, which takes a byte string of
// COMMANDS and a matching array of encoded inputs. A single-pool exact-in swap
// is one command (V4_SWAP) whose input carries three ACTIONS:
//
//   SWAP_EXACT_IN_SINGLE  do the swap
//   SETTLE_ALL            pay the input currency in
//   TAKE_ALL              take the output currency out
//
// The input currency decides how the swap is FUNDED. The encoding is identical
// either way; only msg.value and the approvals differ:
//
//   native ETH -> attach msg.value, settle address(0), no approval needed.
//   an ERC-20  -> attach no value; the router pulls the input through PERMIT2,
//                 so the wallet needs both an ERC-20 allowance to Permit2 and a
//                 Permit2 allowance naming this router. Missing or expired,
//                 the swap reverts.
//
// This bot takes the ERC-20 path — NEKO is quoted in NVDA, so the buyback
// spends NVDA. The approvals are ensured HERE rather than by the caller,
// because a swap that reverts on a lapsed Permit2 expiry does so after the
// escrow has already been claimed and the holders paid.

const { Contract, AbiCoder, concat, toBeHex } = require('ethers');
const config = require('../config');
const { wallet } = require('./provider');
const { EXACT_IN_SINGLE_TYPE, UNIVERSAL_ROUTER_ABI } = require('./abi');
const { NATIVE } = require('./pool');
const { ensurePermit2Allowance } = require('./permit2');

const V4_SWAP = 0x10;              // UniversalRouter Commands.V4_SWAP
const SWAP_EXACT_IN_SINGLE = 0x06; // v4-periphery Actions
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

const coder = AbiCoder.defaultAbiCoder();

function keyTuple(k) {
  return [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
}

/** Encode one exact-in single-pool swap for UniversalRouter.execute(). */
function encodeExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum }) {
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const actions = concat([toBeHex(SWAP_EXACT_IN_SINGLE, 1), toBeHex(SETTLE_ALL, 1), toBeHex(TAKE_ALL, 1)]);
  const params = [
    coder.encode([EXACT_IN_SINGLE_TYPE], [[keyTuple(poolKey), zeroForOne, amountIn, amountOutMinimum, '0x']]),
    coder.encode(['address', 'uint256'], [currencyIn, amountIn]),
    coder.encode(['address', 'uint256'], [currencyOut, amountOutMinimum]),
  ];

  return {
    commands: toBeHex(V4_SWAP, 1),
    inputs: [coder.encode(['bytes', 'bytes[]'], [actions, params])],
  };
}

/**
 * Send the swap. Native input rides along as msg.value; an ERC-20 input is
 * pulled through Permit2, whose allowances are topped up first if needed.
 */
async function swapExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum, deadlineSec = 600 }) {
  const { commands, inputs } = encodeExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum });
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const isNative = currencyIn.toLowerCase() === NATIVE;
  const value = isNative ? amountIn : 0n;

  if (!isNative) {
    await ensurePermit2Allowance({
      tokenAddress: currencyIn,
      spender: config.universalRouter,
      needed: amountIn,
    });
  }

  const router = new Contract(config.universalRouter, UNIVERSAL_ROUTER_ABI, wallet);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
  return router.execute(commands, inputs, deadline, { value });
}

module.exports = {
  encodeExactInSingle, swapExactInSingle,
  V4_SWAP, SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL,
};

'use strict';

// Buy through our own V4Buyer contract instead of the UniversalRouter.
//
// The UniversalRouter cannot swap INTO a pons pool whose quote asset is an
// ERC-20. Verified against the live chain, with the wallet funded and Permit2
// fully approved: NVDA -> NEKO reverts with empty data at every size, in
// both directions, under every action ordering, while the same router happily
// does NVDA -> ETH on a hookless pool and ETH -> memecoin on the same pons
// hook. The V4Quoter executes the failing swap, hook included, and returns a
// price -- so the pool is fine and the fault is in the router's settlement.
//
// V4Buyer talks to the PoolManager directly: unlock, swap, settle exactly what
// the swap consumed, take the output. No Permit2 and no aggregator.

const { Contract } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { erc20 } = require('./erc20');
const { sendTx } = require('./send');

const V4_BUYER_ABI = [
  'function buy((address,address,uint24,int24,address) key, bool zeroForOne, uint128 amountIn, uint128 minAmountOut, address recipient) returns (uint256)',
];

/** The buyer PULLS the input with transferFrom, so it needs an allowance. */
async function ensureBuyerAllowance({ tokenAddress, needed }) {
  const token = erc20(tokenAddress, provider);
  const allowance = await token.allowance(wallet.address, config.v4BuyerAddress);
  if (allowance >= needed) return false;
  console.log(`[buyback] approving ${tokenAddress} to the v4 buyer ${config.v4BuyerAddress}`);
  const { MaxUint256 } = require('ethers');
  const tx = await sendTx(() => erc20(tokenAddress, wallet).approve(config.v4BuyerAddress, MaxUint256));
  await tx.wait();
  return true;
}

/**
 * Swap `amountIn` of the quote asset for the memecoin, delivered to this wallet.
 *
 * @returns {Promise<import('ethers').TransactionResponse>}
 */
async function buyViaV4Buyer({ poolKey, zeroForOne, amountIn, amountOutMinimum }) {
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  await ensureBuyerAllowance({ tokenAddress: currencyIn, needed: amountIn });

  const buyer = new Contract(config.v4BuyerAddress, V4_BUYER_ABI, wallet);
  return sendTx(() =>
    buyer.buy(
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      zeroForOne,
      amountIn,
      amountOutMinimum,
      wallet.address
    )
  );
}

module.exports = { buyViaV4Buyer, ensureBuyerAllowance, V4_BUYER_ABI };

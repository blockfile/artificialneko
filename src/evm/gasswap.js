'use strict';

// Turn a slice of the claimed quote into native ETH, so the bot can pay for its
// own transactions.
//
// Fees arrive as NVDA and gas is native ETH, so without this the wallet drains
// and every cycle eventually fails. The lineage this grew from did the swap in
// one v4 hop, but NVDA has NO native-ETH v4 pool on this chain -- every
// plausible fee/tickSpacing combination reads as an empty pool. The route here
// is Uniswap v3 to WETH and then an unwrap:
//
//     NVDA --(v3 SwapRouter02, fee 500)--> WETH --(withdraw)--> native ETH
//
// Two transactions rather than one. A multicall could fuse them, but keeping
// them separate means a failure names which half broke, and the unwrap is
// driven by the balance we actually received rather than a predicted amount.

const { Contract, MaxUint256, formatEther, formatUnits, parseUnits } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { erc20 } = require('./erc20');
const { sendTx } = require('./send');
const { toUnitString } = require('./units');

const V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];
const WETH_ABI = [
  'function withdraw(uint256)',
  'function balanceOf(address) view returns (uint256)',
];

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}`;
}

/** Human-readable one-liner for the cycle log. */
function describeOutcome(r) {
  if (r.skipped) return `gas swap skipped: ${r.reason}`;
  if (r.error) return `gas swap FAILED (${r.error}) — the NVDA stays in the wallet`;
  return `gas swap sold ${r.quoteSpent} ${config.quoteSymbol} for ${r.ethReceived} ETH`;
}

/** The router pulls with transferFrom, so it needs an allowance. */
async function ensureRouterAllowance(needed) {
  const token = erc20(config.quoteTokenAddress, provider);
  const allowance = await token.allowance(wallet.address, config.v3Router);
  if (allowance >= needed) return false;
  console.log(`[gasswap] approving ${config.quoteSymbol} to the v3 router ${config.v3Router}`);
  const tx = await sendTx(() => erc20(config.quoteTokenAddress, wallet).approve(config.v3Router, MaxUint256));
  await tx.wait();
  return true;
}

async function swapQuoteForGas({ quoteAmount }) {
  const base = { swapped: false, skipped: false, signature: null, quoteSpent: quoteAmount, ethReceived: 0 };

  if (!(quoteAmount > 0)) return { ...base, skipped: true, reason: 'gas share of this claim is zero' };

  if (config.dryRun) {
    return { ...base, swapped: true, ethReceived: +(quoteAmount * 0.2).toFixed(9), signature: fakeSig('gasswap') };
  }

  if (config.gasCeilingEth > 0) {
    const held = Number(formatEther(await provider.getBalance(wallet.address)));
    if (held >= config.gasCeilingEth) {
      return { ...base, skipped: true, reason: `wallet already holds ${held} ETH (GAS_CEILING_ETH ${config.gasCeilingEth})` };
    }
  }

  const amountIn = parseUnits(toUnitString(quoteAmount, config.quoteDecimals), config.quoteDecimals);
  if (amountIn <= 0n) return { ...base, skipped: true, reason: 'gas share rounds to zero base units' };

  try {
    await ensureRouterAllowance(amountIn);

    const router = new Contract(config.v3Router, V3_ROUTER_ABI, wallet);
    const params = {
      tokenIn: config.quoteTokenAddress,
      tokenOut: config.wethAddress,
      fee: config.gasPoolFee,
      recipient: wallet.address,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    // Simulate to learn the output, then send with a floor derived from it.
    // There is no v3 quoter deployed here that we have verified, and sending
    // with amountOutMinimum = 0 would hand the whole swap to a sandwich.
    const expected = await router.exactInputSingle.staticCall(params);
    if (expected <= 0n) throw new Error('the v3 NVDA/WETH pool quoted zero');
    const floor = (expected * BigInt(10000 - Math.round(config.slippagePct * 100))) / 10000n;

    const weth = new Contract(config.wethAddress, WETH_ABI, wallet);
    const wethBefore = await weth.balanceOf(wallet.address);

    const swapTx = await sendTx(() => router.exactInputSingle({ ...params, amountOutMinimum: floor }));
    await swapTx.wait();
    const wethAfter = await weth.balanceOf(wallet.address);
    const received = wethAfter > wethBefore ? wethAfter - wethBefore : 0n;
    console.log(`[tx] gas swap ${quoteAmount} ${config.quoteSymbol} -> ${formatUnits(received, 18)} WETH: ${swapTx.hash}`);

    if (received <= 0n) throw new Error('the swap returned no WETH');

    // Unwrap exactly what arrived. Anything already held is left alone — it may
    // not be ours to spend.
    const ethBefore = await provider.getBalance(wallet.address);
    const unwrapTx = await sendTx(() => weth.withdraw(received));
    const unwrapReceipt = await unwrapTx.wait();
    const ethAfter = await provider.getBalance(wallet.address);
    const gasCost = unwrapReceipt.gasUsed * (unwrapReceipt.gasPrice ?? unwrapReceipt.effectiveGasPrice ?? 0n);
    const netEth = ethAfter - ethBefore + gasCost;
    console.log(`[tx] unwrapped ${formatEther(received)} WETH -> ETH: ${unwrapTx.hash}`);

    return {
      ...base,
      swapped: true,
      ethReceived: Number(formatEther(netEth > 0n ? netEth : received)),
      signature: swapTx.hash,
      unwrapSignature: unwrapTx.hash,
    };
  } catch (err) {
    const error = err && (err.shortMessage || err.message) ? err.shortMessage || err.message : String(err);
    console.error(`[gasswap] ${error}`);
    return { ...base, error };
  }
}

module.exports = { swapQuoteForGas, describeOutcome, ensureRouterAllowance };

'use strict';

// Buy the REWARD token with claimed quote.
//
// This is what makes Artificial Neko different from the lineage it grew
// from. There, the asset claimed from the escrow was the same asset paid to
// holders, so a cycle claimed and airdropped without ever touching a DEX. Here
// fees arrive as NVDA and holders are paid in Artificial Inu, so every cycle
// has to buy the reward before it can distribute it.
//
// It routes through V4Buyer rather than the UniversalRouter, for the same
// reason the buyback does: the router cannot settle an ERC-20 input into a
// HOOKED v4 pool. Verified on this pool with the wallet funded and Permit2
// approved -- both SETTLE and SETTLE_ALL revert with empty data, while V4Buyer
// returns 89,152 AI for 100 NVDA. That is now confirmed on two unrelated hooks
// (pons's V2MemeHook and Doppler's), so treat it as the rule on this chain, not
// a quirk of one pool.

const { formatUnits } = require('ethers');
const config = require('../config');
const { buildPoolKey, poolIdOf, isZeroForOne, quoteExactInSingle } = require('./pool');
const { buyViaV4Buyer } = require('./v4buyer');
const { erc20, getDecimals } = require('./erc20');
const { provider, wallet } = require('./provider');
const { toUnitString } = require('./units');
const { parseUnits } = require('ethers');

/** The AI/NVDA pool. Its key is configured, not derived — it is an ordinary
 *  Uniswap pool with no launch record to read it from. */
function rewardPoolKey() {
  return buildPoolKey({
    token: config.rewardTokenAddress,
    quoteToken: config.quoteTokenAddress,
    fee: config.rewardPoolFee,
    tickSpacing: config.rewardPoolTickSpacing,
    hooks: config.rewardPoolHooks,
  });
}

/** Pure: the smaller of what we want to spend and what we actually hold. */
function clampToBalance(wanted, held) {
  return wanted <= held ? wanted : held;
}

/**
 * Swap `quoteAmount` of NVDA for the reward token, into this wallet.
 *
 * @returns {Promise<{bought: boolean, tokensBought: number, signature: string|null,
 *                    quoteSpent: number, error?: string}>}
 */
async function buyReward({ quoteAmount }) {
  const base = { bought: false, tokensBought: 0, signature: null, quoteSpent: 0 };
  if (!(quoteAmount > 0)) return { ...base, skipped: true, reason: 'reward share of this claim is zero' };

  // When holders are paid the SAME asset the fees arrive in, there is nothing
  // to buy: the claim is already denominated in the reward token. Skipping the
  // swap is not an optimisation, it is the correct behaviour - routing NVDA
  // through a NVDA/NVDA pool is meaningless, and a real swap would cost the
  // holders a fee and slippage for no gain.
  //
  // The rest of the cycle is unchanged, so one codebase serves both shapes:
  // pay the quote asset directly, or buy a third token with it first.
  if (config.rewardTokenAddress.toLowerCase() === config.quoteTokenAddress.toLowerCase()) {
    const raw = parseUnits(toUnitString(quoteAmount, config.rewardDecimals), config.rewardDecimals);
    return {
      bought: raw > 0n,
      boughtRaw: raw,
      tokensBought: quoteAmount,
      quoteSpent: quoteAmount,
      signature: null,
      direct: true,
    };
  }

  if (config.dryRun) {
    // Roughly the live rate, so a rehearsal's numbers are the right order of
    // magnitude rather than invented. Every chain call below is skipped: a dry
    // run must never need an RPC, and this one would fail having already
    // "claimed" the escrow.
    const tokens = +(quoteAmount * 900).toFixed(9);
    const boughtRaw = parseUnits(toUnitString(tokens, config.rewardDecimals), config.rewardDecimals);
    return {
      bought: boughtRaw > 0n,
      boughtRaw,
      tokensBought: tokens,
      quoteSpent: quoteAmount,
      signature: `rewardswap_${Date.now().toString(36)}`,
    };
  }

  const wantRaw = parseUnits(toUnitString(quoteAmount, config.quoteDecimals), config.quoteDecimals);
  const held = await erc20(config.quoteTokenAddress, provider).balanceOf(wallet.address);
  const spendRaw = clampToBalance(wantRaw, held);
  if (spendRaw <= 0n) {
    return { ...base, skipped: true, reason: 'the wallet holds no NVDA to buy rewards with' };
  }
  if (spendRaw < wantRaw) {
    console.log(
      `[reward-swap] wallet holds ${formatUnits(held, config.quoteDecimals)} NVDA but the share is ` +
        `${quoteAmount} — spending what is there (rounding dust)`
    );
  }

  const poolKey = rewardPoolKey();
  const zeroForOne = isZeroForOne(poolKey, config.quoteTokenAddress);
  const quoted = await quoteExactInSingle({ poolKey, zeroForOne, amountIn: spendRaw });
  if (quoted <= 0n) throw new Error(`the reward pool quoted zero for ${config.rewardTokenAddress}`);

  // A floor, not a target. The quote is advisory — the hook takes its cut
  // after the swap — so this only refuses a fill far worse than quoted.
  const minOut = (quoted * BigInt(10000 - Math.round(config.rewardSlippageBps))) / 10000n;

  const before = await erc20(config.rewardTokenAddress, provider).balanceOf(wallet.address);
  const tx = await buyViaV4Buyer({ poolKey, zeroForOne, amountIn: spendRaw, amountOutMinimum: minOut });
  await tx.wait();
  const after = await erc20(config.rewardTokenAddress, provider).balanceOf(wallet.address);

  // Measured, not quoted: what we can actually hand to holders is the balance
  // delta. Airdropping a quoted figure would overrun the wallet by the hook's fee.
  const decimals = config.dryRun ? config.rewardDecimals : await getDecimals(config.rewardTokenAddress);
  const boughtRaw = after > before ? after - before : 0n;

  console.log(
    `[tx] bought ${formatUnits(boughtRaw, decimals)} ${config.rewardSymbol} ` +
      `for ${formatUnits(spendRaw, config.quoteDecimals)} ${config.quoteSymbol}: ${tx.hash}`
  );

  return {
    bought: boughtRaw > 0n,
    boughtRaw,
    tokensBought: Number(formatUnits(boughtRaw, decimals)),
    quoteSpent: Number(formatUnits(spendRaw, config.quoteDecimals)),
    signature: tx.hash,
  };
}

module.exports = { buyReward, rewardPoolKey, clampToBalance, poolIdOf };

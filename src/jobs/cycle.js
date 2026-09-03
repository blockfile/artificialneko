'use strict';

// One reward cycle:
//
//   sweep pending fees into the escrow   (best-effort — may need pons's operator)
//   claimToken(NVDA)                     -> NVDA in the wallet
//     -> GAS_PCT:    sell for native ETH, so the bot can pay its own gas
//     -> REWARD_PCT: airdrop pro-rata to NEKO holders
//     -> BURN_PCT:   buy NEKO with it and burn what was bought
//     -> remainder:  the dev cut — forwarded to DEV_PAYOUT_ADDRESS if one is
//                    set, otherwise left in the wallet. At the default
//                    65/25/10 it is zero.
//
// The gas leg runs FIRST because the airdrop that follows sends one
// transaction per holder: topping up before spending is what stops a cycle
// running dry halfway through paying people.
//
// The REWARD leg never swaps: fees arrive already denominated in NVDA, which is
// what holders are paid. The BUYBACK leg is the only thing in this bot that
// trades, which is why slippage, quoting and venue dispatch live entirely in
// evm/buyback.js and touch nothing else.
//
// Each step is recorded as it completes; a thrown step fails the cycle without
// crashing the process.

const { formatEther, parseUnits } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const { getLaunch, describePhase } = require('../evm/launch');
const { sweepFees } = require('../evm/sweep');
const { claimQuoteFromEscrow } = require('../evm/escrow');
const { getDecimals, getTokenSupplyRaw } = require('../evm/erc20');
const { snapshotEligibleHolders } = require('../evm/holders');
const { buildExcludeSet } = require('../evm/exclude');
const { buyReward } = require('../evm/rewardswap');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../evm/airdrop');
const { toUnitString } = require('../evm/units');
const { sendDevPayout, describeOutcome: describeDevPayout } = require('../evm/devpayout');
const { buybackAndBurn, describeOutcome: describeBuyback } = require('../evm/buyback');
const { swapQuoteForGas, describeOutcome: describeGasSwap } = require('../evm/gasswap');
const { provider } = require('../evm/provider');

/**
 * Split a claim three ways. Pure, so the invariant that the legs re-add to the
 * claim is directly testable.
 *
 * The dev cut is the REMAINDER rather than its own percentage, so the three can
 * never disagree with the claim: at the default 80/20 it is exactly zero, and it
 * only appears when REWARD_PCT + BURN_PCT total under 100.
 */
function splitClaim(claimedQuote) {
  // Round to 9 places and normalise negative zero. At a split that consumes the
  // whole claim the remainder lands on -1.1e-16, which toFixed renders as
  // "-0.000000000" and `+` turns into -0: a value that fails a strict
  // comparison with 0 and prints as "-0" in the cycle log.
  const round = (n) => {
    const r = +n.toFixed(9);
    return r === 0 ? 0 : r;
  };
  const rewardQuote = round(claimedQuote * (config.rewardPct / 100));
  const burnQuote = round(claimedQuote * (config.burnPct / 100));
  const gasQuote = round(claimedQuote * (config.gasPct / 100));
  // The dev leg is the remainder, so it absorbs the rounding of the other
  // three and can land just below zero -- a live cycle logged "-1e-9 to dev".
  // Config already refuses a split whose three legs exceed 100, so a negative
  // here is float error and nothing else. Clamp it: today the payout is skipped
  // when DEV_PAYOUT_ADDRESS is unset, but a negative amount reaching parseUnits
  // would throw, and the first person to set that address would be the one to
  // find out.
  const devQuote = Math.max(0, round(claimedQuote - rewardQuote - burnQuote - gasQuote));
  return { rewardQuote, burnQuote, gasQuote, devQuote };
}

/**
 * Is this wallet the address the launch actually pays creator fees to? Only
 * that address may sweep OR claim, so a mismatch means the cycle can never
 * collect anything — silently, with no error anywhere.
 * Case-insensitive: the factory returns EIP-55 checksummed addresses.
 */
function isFeeRecipientOk(launch, address) {
  const want = String(address || '').toLowerCase();
  const got = String((launch && launch.creatorFeeRecipient) || '').toLowerCase();
  return want !== '' && got !== '' && want === got;
}

/** The operator-facing warning for a mismatch, or null when it is fine. */
function feeRecipientWarning(launch, address) {
  if (isFeeRecipientOk(launch, address)) return null;
  const got = (launch && launch.creatorFeeRecipient) || '(unset)';
  return (
    `creatorFeeRecipient MISMATCH: the launch pays creator fees to ${got}, ` +
    `but this bot's wallet is ${address || '(unset)'}. This cycle cannot claim — ` +
    'only the creatorFeeRecipient may sweep or claim. The usual cause is that ' +
    "pons's \"route creator fees to holders\" toggle was switched on, which " +
    'reassigns the recipient to a fee distributor contract and leaves this bot ' +
    'with nothing. Switch it back off, or point WALLET_PRIVATE_KEY at the ' +
    'recipient the launch actually names.'
  );
}

// Last observed result of the check above, so the operator API can report it
// without making a chain call of its own. null until something has looked.
let lastFeeRecipientCheck = null;
function getFeeRecipientCheck() {
  return lastFeeRecipientCheck;
}

/**
 * Record the fee-recipient verdict from a launch record someone has already
 * read. Returns the warning, or null when it is fine.
 *
 * Called by the CYCLE and also by every scheduler poll. The poll already
 * fetches the launch record to price what is claimable, so re-using it makes
 * the single most important operational flag as fresh as the poll interval
 * instead of only as fresh as the last cycle — which, on a quiet token, could
 * be hours of reporting `null` about the one thing worth knowing.
 */
function recordFeeRecipientCheck(launch, address) {
  const warning = feeRecipientWarning(launch, address);
  lastFeeRecipientCheck = {
    ok: warning === null,
    expected: address,
    actual: (launch && launch.creatorFeeRecipient) || null,
    at: new Date().toISOString(),
  };
  return warning;
}

/**
 * How a cycle finishes, given what the reward leg actually did. Pure, so both
 * the "airdrop reached nobody" and the "nobody was eligible" cases are directly
 * testable — they look identical in `sent` (0) and must not be recorded
 * identically. One is a quiet no-op; the other means the NVDA is stranded.
 */
function summarizeReward(reward) {
  if (reward.skipped) {
    return { status: 'complete', note: `reward leg skipped: ${reward.reason}` };
  }
  if (!(reward.recipients > 0)) {
    return { status: 'complete', note: 'no eligible holders — nothing to airdrop' };
  }
  if (!(reward.sent > 0)) {
    return {
      status: 'failed',
      note: `airdrop reached 0 of ${reward.recipients} recipients`,
      error:
        `airdrop delivered nothing: 0 of ${reward.recipients} recipients received NVDA ` +
        `(${reward.failed} failed). Likely causes: the wallet is out of ETH for gas, NVDA is ` +
        'paused, or DISPERSE_ADDRESS points at something that is not an ERC-20 disperser. ' +
        'The NVDA claimed this cycle is still sitting in the wallet.',
    };
  }
  if (reward.failed > 0) {
    return { status: 'complete', note: `airdrop sent ${reward.sent}, ${reward.failed} failed` };
  }
  return { status: 'complete', note: `airdrop sent ${reward.sent}` };
}

/** Airdrop `quoteAmount` of NVDA pro-rata to eligible holders of the fee token. */
async function runRewardLeg(cycleId, { launch, quoteAmount }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  // MIN_HOLD is a whole-token figure; scale it by the TOKEN's own decimals
  // rather than assuming 18, or the eligibility threshold is wrong by orders of
  // magnitude on any token that is not 18-decimal — in whichever direction
  // makes the airdrop include everybody or nobody.
  //
  // DRY_RUN must simulate EVERY chain call, so it takes the configured value:
  // reading decimals() from the node is the one call that would otherwise make
  // a dry run need a live RPC, and it would die here having already "claimed".
  const tokenDecimals = config.dryRun ? config.tokenDecimals : await getDecimals(launch.token);
  const minHoldRaw = (BigInt(Math.trunc(config.minHold)) * 10n ** BigInt(tokenDecimals)).toString();

  const exclude = await buildExcludeSet(launch);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: launch.token, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${config.minHold}) of ${totalHolders} total`);

  const capPct = config.rewardCapPct > 0 ? config.rewardCapPct : null;
  const supplyRaw = capPct == null ? null : (await getTokenSupplyRaw(launch.token)).toString();

  // BUY THE REWARD FIRST. Fees arrive as NVDA and holders are paid in
  // Artificial Inu, so a cycle cannot distribute what it has not yet bought.
  // The amount airdropped is what the swap ACTUALLY returned, never the quoted
  // figure: the pool's hook takes its cut after the swap, so distributing a
  // quote would allocate more than the wallet holds and revert the last batch.
  const buy = await buyReward({ quoteAmount });
  await repo.addStep({
    cycleId,
    name: 'reward-swap',
    status: buy.bought ? 'ok' : buy.skipped ? 'skipped' : 'failed',
    signature: buy.signature,
    detail: {
      quoteSpent: buy.quoteSpent,
      tokensBought: buy.tokensBought,
      rewardToken: config.rewardTokenAddress,
      ...(buy.reason ? { reason: buy.reason } : {}),
    },
  });
  if (!buy.bought) {
    log(`no reward bought (${buy.reason || 'swap returned nothing'}) — nothing to distribute`);
    return { recipients: 0, sent: 0, failed: 0, skipped: true, eligibleHolders: holders.length, totalHolders, rewardBought: 0 };
  }
  log(`bought ${buy.tokensBought} ${config.rewardSymbol} for ${buy.quoteSpent} ${config.quoteSymbol}`);

  // The airdrop is denominated in the REWARD token's base units.
  const totalRaw = buy.boughtRaw;
  const allocations = computeWeightedAllocations(holders, totalRaw.toString(), {
    capPct,
    supplyRaw,
    clusters: config.clusters,
  });

  const air = await airdropToken({ rewardToken: config.rewardTokenAddress, allocations, cycleId });
  await repo.addStep({
    cycleId,
    name: 'airdrop',
    status: air.failed ? 'failed' : 'ok',
    detail: {
      token: config.rewardTokenAddress,
      quoteAmount,
      rewardAmount: buy.tokensBought,
      recipients: allocations.length,
      sent: air.sent,
      failed: air.failed,
    },
  });
  log(`airdrop ${config.rewardSymbol} sent=${air.sent} failed=${air.failed}`);

  return {
    recipients: allocations.length,
    sent: air.sent,
    failed: air.failed,
    eligibleHolders: holders.length,
    totalHolders,
    rewardBought: buy.tokensBought,
    quoteSpent: buy.quoteSpent,
  };
}

async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (NEKO) is required');

    const launch = await getLaunch();
    const phase = describePhase(launch);
    log(`phase=${phase}${launch.graduated ? ` pool=${String(launch.poolId).slice(0, 10)}…` : ` curve=${launch.curve}`}`);

    // Gas is NOT self-funding here: the dev cut is NVDA while gas is ETH, so
    // the wallet cannot refill itself from what it collects. Refuse to start
    // rather than emptying the escrow and then failing to pay anyone out.
    if (!config.dryRun) {
      const gasEth = Number(formatEther(await provider.getBalance(config.wallet.address)));
      if (gasEth < config.gasReserveEth) {
        throw new Error(
          `wallet ETH ${gasEth} is below GAS_RESERVE_ETH (${config.gasReserveEth}) — ` +
          'top up the wallet with ETH for gas; the fees stay safe in the escrow until then'
        );
      }
    }

    // The one thing that must not be wrong. Warn, never throw: an operator may
    // be mid-migration, and the cycle below still reports what it finds.
    const feeWarning = recordFeeRecipientCheck(launch, config.wallet.address);
    if (feeWarning) console.warn(`[cycle ${id}] ⚠️  ${feeWarning}`);

    // 1. Sweep pending fees into the escrow. Never fatal.
    const sweep = await sweepFees(launch);
    await repo.addStep({
      cycleId: id,
      name: 'sweep',
      status: sweep.swept ? 'ok' : 'skipped',
      signature: sweep.signature,
      detail: { phase, reason: sweep.reason },
    });
    if (sweep.skipped) log(`sweep skipped: ${sweep.reason}`);

    // 2. Claim the escrow, as NVDA.
    const claim = await claimQuoteFromEscrow();
    await repo.addStep({
      cycleId: id,
      name: 'claim',
      status: 'ok',
      signature: claim.signature,
      detail: { quoteClaimed: claim.quoteClaimed },
    });
    log(`claimed ${claim.quoteClaimed} NVDA`);

    const claimed = claim.quoteClaimed;
    if (!(claimed > 0)) {
      await repo.finishCycle(id, {
        status: 'skipped',
        phase,
        quote_claimed: 0,
        sweep_skipped: sweep.skipped ? 1 : 0,
        sweep_reason: sweep.reason,
        note: 'nothing claimed',
      });
      log('skipped: nothing to work with');
      return repo.getCycleWithSteps(id);
    }

    // 3. Split.
    const { rewardQuote, burnQuote, gasQuote, devQuote } = splitClaim(claimed);
    log(
      `split: ${rewardQuote} to holders (${config.rewardPct}%), ` +
        `${burnQuote} to buyback+burn (${config.burnPct}%), ` +
        `${gasQuote} to gas (${config.gasPct}%), ${devQuote} to dev (${config.devPct}%)`
    );

    // 3a. Gas first — the airdrop below sends one transaction per holder, so
    //     topping up beforehand is what stops a cycle running dry mid-payout.
    const gas = await swapQuoteForGas({ quoteAmount: gasQuote });
    await repo.addStep({
      cycleId: id,
      name: 'gas',
      status: gas.swapped ? 'ok' : gas.skipped ? 'skipped' : 'failed',
      signature: gas.signature,
      detail: {
        quoteSpent: gas.skipped ? 0 : gasQuote,
        ethReceived: gas.ethReceived,
        reason: gas.reason ?? null,
        error: gas.error ?? null,
      },
    });
    log(describeGasSwap(gas));

    // 4. Reward leg — airdrop the claimed NVDA directly. Nothing is bought.
    let reward = { skipped: false, sent: 0, failed: 0, recipients: 0, eligibleHolders: 0, totalHolders: 0 };
    if (rewardQuote > 0) {
      reward = { skipped: false, ...(await runRewardLeg(id, { launch, quoteAmount: rewardQuote })) };
    } else {
      const reason = 'reward share of this claim is zero';
      reward = { ...reward, skipped: true, reason };
      await repo.addStep({ cycleId: id, name: 'reward', status: 'skipped', detail: { reason, rewardQuote } });
      log(`reward leg skipped: ${reason}`);
    }

    // 5. Buy NEKO with the burn share and destroy it. Non-fatal: the
    //    holders have already been paid, so a failed swap leaves the NVDA in
    //    the wallet to retry next cycle rather than losing the whole cycle.
    const buyback = await buybackAndBurn({ launch, quoteAmount: burnQuote });
    await repo.addStep({
      cycleId: id,
      name: 'buyback',
      status: buyback.burned ? 'ok' : buyback.skipped ? 'skipped' : 'failed',
      signature: buyback.burnSignature || buyback.buySignature,
      detail: {
        quoteSpent: buyback.skipped ? 0 : burnQuote,
        tokensBought: buyback.tokensBought,
        bought: buyback.bought,
        burned: buyback.burned,
        venue: buyback.venue ?? null,
        buySignature: buyback.buySignature,
        burnSignature: buyback.burnSignature,
        reason: buyback.reason ?? null,
        error: buyback.error ?? null,
      },
    });
    log(describeBuyback(buyback));

    // 6. Forward the dev cut to the cold address, if one is configured.
    //    Recorded as its own step, never as an airdrop: it is not a holder
    //    reward, and logging it as one would publish it in the public feed and
    //    inflate totalRewarded. Non-fatal — the holders have already been paid,
    //    and a failure here leaves the cut safe in the bot wallet.
    const devPayout = await sendDevPayout({ quoteAmount: devQuote });
    await repo.addStep({
      cycleId: id,
      name: 'dev',
      status: devPayout.sent ? 'ok' : devPayout.skipped ? 'skipped' : 'failed',
      signature: devPayout.signature,
      detail: {
        amount: devQuote,
        to: devPayout.to,
        reason: devPayout.reason ?? null,
        error: devPayout.error ?? null,
      },
    });
    log(describeDevPayout(devPayout));

    const outcome = summarizeReward(reward);
    await repo.finishCycle(id, {
      status: outcome.status,
      mode: 'reward',
      phase,
      quote_claimed: claimed,
      quote_distributed: reward.skipped ? 0 : rewardQuote,
      quote_gas: gas.swapped ? gasQuote : 0,
      eth_received: gas.ethReceived,
      quote_burned: buyback.burned ? burnQuote : 0,
      tokens_burned: buyback.burned ? buyback.tokensBought : 0,
      eligible_holders: reward.eligibleHolders,
      total_holders: reward.totalHolders,
      sweep_skipped: sweep.skipped ? 1 : 0,
      sweep_reason: sweep.reason,
      note: outcome.note,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    if (outcome.status === 'complete') log(`complete — ${outcome.note}`);
    else console.warn(`[cycle ${id}] FAILED: ${outcome.error}`);
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = {
  runCycle,
  runRewardLeg,
  splitClaim,
  summarizeReward,
  isFeeRecipientOk,
  feeRecipientWarning,
  getFeeRecipientCheck,
  recordFeeRecipientCheck,
};

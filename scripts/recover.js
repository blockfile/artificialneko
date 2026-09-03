'use strict';

// Distribute NVDA that a FAILED cycle claimed but never paid out.
//
// A cycle claims the escrow first and pays holders later. If it dies in
// between - cycle 90 died on a fetch timeout while listing holders - the escrow
// is already empty and the money is sitting in the wallet, but no future cycle
// will touch it: each one splits only what IT claimed. The amount would stay
// stranded forever.
//
//   node scripts/recover.js --holders 0.499176872 --burn 0.191991105
//   node scripts/recover.js --holders 0.499176872 --burn 0.191991105 --confirm
//
// Amounts are given EXPLICITLY and never inferred from the wallet balance. The
// signing wallet is also the dev wallet and may hold NVDA that is nobody's but
// yours; a script that distributed "whatever is there" would give it away. Read
// the failed cycle's own log line - "split: X to holders, Y to buyback+burn" -
// and pass those two numbers.
//
// The work is recorded as a real cycle, so /rewards, totalRewarded and
// totalBurned include it and holders see the payout in the feed.

const { formatUnits } = require('ethers');
const config = require('../src/config');
const db = require('../src/db');
const repo = require('../src/db/repository');
const { getLaunch } = require('../src/evm/launch');
const { runRewardLeg, summarizeReward } = require('../src/jobs/cycle');
const { buybackAndBurn } = require('../src/evm/buyback');
const { erc20 } = require('../src/evm/erc20');
const { provider } = require('../src/evm/provider');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v < 0) {
    console.error(`--${name} must be a non-negative number`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const holders = arg('holders') || 0;
  const burn = arg('burn') || 0;
  const confirm = process.argv.includes('--confirm');

  if (holders <= 0 && burn <= 0) {
    console.error('Nothing to do. Pass --holders and/or --burn with amounts from the failed cycle log.\n');
    console.error('  node scripts/recover.js --holders 0.499176872 --burn 0.191991105');
    process.exit(1);
  }
  if (config.dryRun) {
    console.error('DRY_RUN is on — this script only makes sense against the live chain.');
    process.exit(1);
  }

  const me = config.wallet.address;
  const token = erc20(config.quoteTokenAddress, provider);
  const held = Number(formatUnits(await token.balanceOf(me), config.quoteDecimals));
  const needed = holders + burn;

  console.log(`wallet    : ${me}`);
  console.log(`holds     : ${held} NVDA`);
  console.log(`to holders: ${holders}`);
  console.log(`to burn   : ${burn}`);
  console.log(`total     : ${needed}`);

  if (held + 1e-9 < needed) {
    console.error(`\nThe wallet holds ${held} NVDA but ${needed} was asked for. Refusing.`);
    process.exit(1);
  }
  if (!confirm) {
    console.log('\nDry run — nothing sent. Re-run with --confirm to distribute.');
    return;
  }

  await db.connect();
  const id = await repo.createCycle({ dryRun: false });
  const log = (m) => console.log(`[recover ${id}] ${m}`);
  try {
    const launch = await getLaunch();

    let reward = { skipped: true };
    if (holders > 0) {
      reward = await runRewardLeg(id, { launch, quoteAmount: holders });
      log(`reward: ${summarizeReward(reward)}`);
    }

    let buyback = { burned: false };
    if (burn > 0) {
      buyback = await buybackAndBurn({ launch, quoteAmount: burn });
      await repo.addStep({
        cycleId: id,
        name: 'buyback',
        status: buyback.burned ? 'ok' : 'failed',
        detail: buyback,
      });
      log(buyback.burned
        ? `burned ${buyback.tokensBought} ${config.tokenSymbol || 'NEKO'} for ${burn} NVDA`
        : `buyback FAILED (${buyback.error}) — the NVDA stays in the wallet`);
    }

    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'recover',
      quote_claimed: 0, // nothing was claimed: this spends an EARLIER claim
      quote_distributed: reward.skipped ? 0 : holders,
      quote_burned: buyback.burned ? burn : 0,
      tokens_burned: buyback.burned ? buyback.tokensBought : 0,
      eligible_holders: reward.eligibleHolders,
      total_holders: reward.totalHolders,
      note: 'recovered a failed cycle\'s unspent claim',
    });
    log('done');
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    console.error(`[recover ${id}] FAILED: ${message}`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('recover failed:', err.shortMessage || err.message);
  process.exit(1);
});

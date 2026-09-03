'use strict';

// Decides when a cycle runs.
//
// The gate is USD-denominated rather than token-denominated: fees accrue in
// NVDA, one NVDA is worth hundreds of dollars, and a token threshold at that
// scale is unusable. CLAIM_EVERY_USD is the number an operator actually thinks
// in ("claim once there's $100 there").

const cron = require('node-cron');
const config = require('../config');
const { runCycle, recordFeeRecipientCheck } = require('./cycle');
const { getLaunch } = require('../evm/launch');
const { escrowBalanceQuote } = require('../evm/escrow');
const { sweepableQuote, pendingCreditQuote } = require('../evm/sweep');
const { getQuotePrice } = require('../services/quoteprice');
const repo = require('../db/repository');
const simvault = require('../evm/simvault');

const state = {
  task: null,
  paused: false,
  isRunning: false,
  lastRunAt: null,
  lastResult: null,
  lastClaimable: null,
  lastPriceUsd: null,
  lastClaimableUsd: null,
  lastAccrued: null,
  startedAt: null,
  lastPhase: null,
};

/**
 * What a cycle could realistically collect right now: what is already in the
 * escrow PLUS what a sweep would move into it. Reading the escrow alone
 * deadlocks — before the first sweep it is zero while the fees sit on the curve
 * or the hook, so the bot would never fire and never sweep.
 *
 * @param {object} deps Optional overrides for testing.
 */
async function getClaimableQuote(deps = {}) {
  const dryRun = deps.dryRun !== undefined ? deps.dryRun : config.dryRun;
  const readEscrow = deps.escrowBalanceQuote || escrowBalanceQuote;
  const readSweepable = deps.sweepableQuote || sweepableQuote;
  const readLaunch = deps.getLaunch || getLaunch;
  const token = deps.tokenAddress !== undefined ? deps.tokenAddress : config.tokenAddress;

  if (dryRun) {
    const v = await readEscrow();
    state.lastAccrued = v;
    return v;
  }
  if (!token) {
    state.lastAccrued = 0;
    return 0;
  }
  const launch = await readLaunch();
  state.lastPhase = launch.graduated ? 'v4' : 'curve';
  // Free: the launch record is already in hand, so the fee-recipient verdict
  // stays as fresh as the poll rather than as stale as the last cycle.
  const warning = recordFeeRecipientCheck(launch, config.wallet.address);
  if (warning) console.warn(`[scheduler] ⚠️  ${warning}`);
  const readAccrued = deps.pendingCreditQuote || pendingCreditQuote;
  const [inEscrow, pending, accrued] = await Promise.all([
    readEscrow(),
    readSweepable(launch),
    readAccrued(launch).catch(() => null),
  ]);
  state.lastAccrued = accrued === null ? null : inEscrow + accrued;
  return inEscrow + pending;
}

/**
 * Pure: should this tick run a cycle?
 *
 * If the price is unavailable the answer is NO. Firing blind would empty the
 * escrow at an unknown value and pay gas to do it; holding costs nothing,
 * because unclaimed fees are not lost — they keep accruing and the next tick
 * tries again. Interval mode skips the price entirely, since it has no
 * threshold to compare against.
 *
 * @param {{claimableQuote:number, priceUsd:number|null, triggerMode:string, claimEveryUsd:number}} args
 * @returns {{fire: boolean, reason: string, usd: number|null}}
 */
function shouldFire({ claimableQuote, priceUsd, triggerMode, claimEveryUsd }) {
  if (!(claimableQuote > 0)) return { fire: false, reason: 'nothing claimable', usd: null };

  if (triggerMode !== 'accumulation') {
    return { fire: true, reason: 'interval mode — firing on whatever has accrued', usd: null };
  }

  if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || !(priceUsd > 0)) {
    return { fire: false, reason: 'NVDA price unavailable — holding rather than claiming blind', usd: null };
  }

  const usd = claimableQuote * priceUsd;
  if (usd < claimEveryUsd) {
    return { fire: false, reason: `below the accumulation threshold ($${usd.toFixed(2)} < $${claimEveryUsd})`, usd };
  }
  return { fire: true, reason: `threshold met ($${usd.toFixed(2)} >= $${claimEveryUsd})`, usd };
}

/**
 * Persist the fee gauge for the public API to serve.
 *
 * Never allowed to break a cycle: this is display state. A Mongo hiccup while
 * recording "the tank is 80% full" must not stop the bot from claiming.
 */
async function recordGauge(patch) {
  try {
    await repo.setDistributionState(patch);
  } catch (err) {
    console.warn(`[scheduler] could not record the fee gauge: ${err.message}`);
  }
}

async function pollOnce(trigger, deps = {}) {
  if (state.paused) return { ran: false, reason: 'paused' };
  if (state.isRunning) {
    console.log(`[scheduler] ${trigger} tick ignored — a cycle is already running`);
    return { ran: false, reason: 'cycle already running' };
  }

  // Hold the run flag across the balance read too, so a manual POST /run
  // landing between the read and the cycle cannot spawn a second concurrent
  // cycle and contend for the wallet nonce.
  state.isRunning = true;
  try {
    const dryRun = deps.dryRun !== undefined ? deps.dryRun : config.dryRun;
    const cycleFn = deps.runCycle || runCycle;
    const readPrice = deps.getQuotePrice || getQuotePrice;

    // Simulate fees arriving so dry-run cycles have something to work with.
    // This is the ONLY place that accrues; the sweep deliberately does not.
    if (dryRun) simvault.accrue(config.dryRunFeePerPoll);

    const claimable = await getClaimableQuote(deps);
    state.lastClaimable = claimable;

    let priceUsd = null;
    try {
      priceUsd = (await readPrice()).priceUsd;
    } catch (err) {
      console.warn(`[artificialneko] NVDA price unavailable: ${err.message}`);
    }
    state.lastPriceUsd = priceUsd;

    const gate = shouldFire({
      claimableQuote: claimable,
      priceUsd,
      triggerMode: deps.triggerMode !== undefined ? deps.triggerMode : config.triggerMode,
      claimEveryUsd: deps.claimEveryUsd !== undefined ? deps.claimEveryUsd : config.claimEveryUsd,
    });
    state.lastClaimableUsd = gate.usd;

    // The bar shows what can actually TRIGGER a distribution - the claimable
    // amount - because that is the question a holder is asking: how close is
    // the next payout. Showing everything accrued over-promises: post-
    // graduation much of it sits behind pons's operator lock, so the bar filled
    // to 100% and the site announced "BUYING" while the bot was still waiting
    // on a sweep that had not happened.
    //
    // What has accrued but is not yet reachable rides along separately, so a
    // site can show "and $85 more awaiting a sweep" rather than either hiding
    // it or counting it as ready to spend.
    const accrued = state.lastAccrued === null ? claimable : Math.max(claimable, state.lastAccrued);
    const priced = typeof priceUsd === 'number' && priceUsd > 0;
    await recordGauge({
      collectedQuote: claimable,
      collectedUsd: priced ? claimable * priceUsd : gate.usd,
      accruedQuote: accrued,
      accruedUsd: priced ? accrued * priceUsd : null,
      pendingSweepUsd: priced ? Math.max(0, (accrued - claimable) * priceUsd) : null,
      priceUsd,
      thresholdUsd: deps.claimEveryUsd !== undefined ? deps.claimEveryUsd : config.claimEveryUsd,
      status: gate.fire ? 'distributing' : 'collecting',
    });

    if (!gate.fire) return { ran: false, claimable, usd: gate.usd, reason: gate.reason };

    console.log(`[scheduler] ${gate.reason} — running a cycle`);
    state.lastRunAt = new Date().toISOString();
    const cycle = await cycleFn();
    state.lastResult = { id: cycle.id, status: cycle.status };
    await recordGauge(finishedGauge(cycle));
    return { ran: true, claimable, usd: gate.usd, cycle };
  } finally {
    state.isRunning = false;
  }
}

function start() {
  if (state.task) return;
  if (!cron.validate(config.pollSchedule)) throw new Error(`Invalid POLL_SCHEDULE: ${config.pollSchedule}`);
  state.startedAt = new Date().toISOString();
  state.task = cron.schedule(config.pollSchedule, () => {
    pollOnce('poll').catch((err) => console.error('[scheduler] poll error:', err));
  });
  const gate =
    config.triggerMode === 'accumulation' ? ` threshold=$${config.claimEveryUsd}` : '';
  console.log(
    `[scheduler] started — mode="${config.triggerMode}" schedule="${config.pollSchedule}"${gate} (dryRun=${config.dryRun})`
  );
}

function pause() {
  state.paused = true;
  return getState();
}
function resume() {
  state.paused = false;
  return getState();
}

/**
 * Pure: the gauge after a cycle finishes. The tank is empty again, and the
 * marker moves so the site knows a payout landed and resets its animation —
 * but ONLY for a cycle that actually distributed. A cycle that claimed nothing
 * must not look like a distribution.
 */
function finishedGauge(cycle) {
  const paid = cycle && cycle.status === 'complete' && (cycle.quote_distributed || 0) > 0;
  return {
    collectedQuote: 0,
    collectedUsd: 0,
    status: 'collecting',
    ...(paid
      ? { lastDistributionId: String(cycle.id), lastDistributionAt: cycle.finished_at }
      : {}),
  };
}

async function triggerNow() {
  if (state.isRunning) return { skipped: true, reason: 'cycle already running' };
  state.isRunning = true;
  state.lastRunAt = new Date().toISOString();
  try {
    await recordGauge({ status: 'distributing' });
    // DRY_RUN accrues here too, not only on a scheduler tick. A manual run is
    // how an operator rehearses the flow, and without this it always meets an
    // empty vault and reports "nothing claimed" — never reaching the airdrop or
    // the buyback, which are the parts worth seeing. Live runs are untouched:
    // there, the escrow fills from real fees.
    if (config.dryRun) simvault.accrue(config.dryRunFeePerPoll);

    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    await recordGauge(finishedGauge(cycle));
    return cycle;
  } finally {
    state.isRunning = false;
  }
}

function getState() {
  return {
    triggerMode: config.triggerMode,
    pollSchedule: config.pollSchedule,
    claimEveryUsd: config.claimEveryUsd,
    paused: state.paused,
    isRunning: state.isRunning,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    lastClaimable: state.lastClaimable,
    lastPriceUsd: state.lastPriceUsd,
    lastClaimableUsd: state.lastClaimableUsd,
    lastAccrued: state.lastAccrued,
    phase: state.lastPhase,
    startedAt: state.startedAt,
  };
}

// Test helper — reset scheduler state to a clean slate.
function _resetState() {
  state.task = null;
  state.paused = false;
  state.isRunning = false;
  state.lastRunAt = null;
  state.lastResult = null;
  state.lastClaimable = null;
  state.lastPriceUsd = null;
  state.lastClaimableUsd = null;
  state.lastAccrued = null;
  state.startedAt = null;
  state.lastPhase = null;
}

module.exports = {
  start, pause, resume, triggerNow, pollOnce, getState,
  getClaimableQuote, shouldFire, finishedGauge, _resetState,
};

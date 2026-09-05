'use strict';

// Holder balances derived from Transfer logs, instead of asked of an explorer.
//
// Blockscout pages 50 holders at a time, so a token with 1,815 holders is ~37
// sequential requests through a shared public service that has answered a single
// page in 18 seconds, returned 504 four times running, and hung long enough to
// wedge a whole cycle. It sits directly in the payout path, and nothing checks
// its answer: a short list is paid as a short list.
//
// The chain has the same information and your own RPC serves it. Measured on
// this chain: 50,000 blocks of Transfer logs in 872ms, and NEKO's entire history
// is ~12 such calls — about 11 seconds, once. After that each cycle indexes only
// the blocks since the last one, which is a single fast call.
//
// The part that matters more than the speed: a derived index can be CHECKED.
// Balances must sum to totalSupply(), and if they do not the index is wrong and
// says so, before any NVDA moves. There is no equivalent check on an explorer's
// answer — you either trust it or you do not.
//
// This is deliberately a fold over an append-only log, so it is not idempotent:
// applying a batch twice doubles it. Correctness rests entirely on lastBlock
// advancing past exactly what was applied, which is why the persisted record
// carries both and is written together.

const { Contract, Interface, getAddress } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');

const ZERO = '0x0000000000000000000000000000000000000000';

const TRANSFER_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const IFACE = new Interface(TRANSFER_ABI);
const TRANSFER_TOPIC = IFACE.getEvent('Transfer').topicHash;

const lower = (a) => String(a).toLowerCase();

/**
 * Pure: fold Transfer events into a balance map. Mutates and returns `balances`.
 *
 * The zero address is never a holder — a transfer out of it is a mint and a
 * transfer into it is a burn, matching what totalSupply() does. A transfer to
 * 0x…dead is NOT a burn: supply is unchanged and the tokens are still held, so
 * they stay counted here and are dropped from the airdrop by buildExcludeSet.
 *
 * @param {Map<string,bigint>} balances keyed by LOWERCASE address
 * @param {{from:string,to:string,value:bigint}[]} events
 */
function applyTransfers(balances, events) {
  for (const e of events) {
    const value = BigInt(e.value);
    if (value === 0n) continue;

    const from = lower(e.from);
    if (from !== ZERO) {
      const next = (balances.get(from) || 0n) - value;
      // An emptied address must go, or it is airdropped a zero allocation and
      // inflates the holder count the site publishes.
      if (next > 0n) balances.set(from, next);
      else balances.delete(from);
    }

    const to = lower(e.to);
    if (to !== ZERO) {
      balances.set(to, (balances.get(to) || 0n) + value);
    }
  }
  return balances;
}

/** Pure: total of every balance, for the check against totalSupply(). */
function sumBalances(balances) {
  let total = 0n;
  for (const v of balances.values()) total += v;
  return total;
}

/** Pure: the shape snapshotEligibleHolders and the airdrop already consume. */
function toHolders(balances) {
  const out = [];
  for (const [owner, balanceRaw] of balances) out.push({ owner, balanceRaw: balanceRaw.toString() });
  return out;
}

/**
 * Pure: [from, to] block ranges covering fromBlock..toBlock inclusive.
 *
 * Chunked because the RPC refuses a wide getLogs — 200,000 blocks came back as
 * an error where 50,000 answered in under a second. Every block must appear in
 * exactly one range: a gap silently loses transfers and an overlap doubles them,
 * and neither shows up until someone is paid the wrong amount.
 */
function chunkRanges(fromBlock, toBlock, chunkSize) {
  const out = [];
  const size = Math.max(1, Math.floor(chunkSize));
  for (let start = fromBlock; start <= toBlock; start += size) {
    out.push([start, Math.min(start + size - 1, toBlock)]);
  }
  return out;
}

/** Pure: decode raw logs into the shape applyTransfers wants. */
function decodeTransfers(logs) {
  const out = [];
  for (const log of logs || []) {
    let parsed;
    try {
      parsed = IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch (_err) {
      continue; // not a Transfer we can read — skip rather than fail the index
    }
    if (!parsed || parsed.name !== 'Transfer') continue;
    out.push({ from: parsed.args.from, to: parsed.args.to, value: parsed.args.value });
  }
  return out;
}

/** Every Transfer of `token` between two blocks, in order, chunked to fit the RPC. */
async function fetchTransfers({ token, fromBlock, toBlock, chunkSize, getLogs }) {
  const read = getLogs || ((filter) => provider.getLogs(filter));
  const events = [];
  for (const [from, to] of chunkRanges(fromBlock, toBlock, chunkSize)) {
    const logs = await read({ address: token, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: to });
    events.push(...decodeTransfers(logs));
  }
  return events;
}

/**
 * The current holder set, indexed from the chain.
 *
 * Reads the stored index, applies only the blocks since it was written, checks
 * the result against totalSupply(), and persists both together. Throws rather
 * than returning a list it cannot vouch for — the caller falls back to the
 * explorer, which is slower but at least not silently wrong.
 */
async function buildHolderIndex(deps = {}) {
  const token = deps.token || config.tokenAddress;
  const fromBlockConfigured = deps.fromBlock !== undefined ? deps.fromBlock : config.holderIndexFromBlock;
  const chunkSize = deps.chunkSize || config.holderIndexChunk;
  const repo = deps.repo || require('../db/repository');
  const readSupply =
    deps.totalSupply ||
    (() => new Contract(token, ['function totalSupply() view returns (uint256)'], provider).totalSupply());
  const head = deps.head !== undefined ? deps.head : await provider.getBlockNumber();

  if (!token) throw new Error('holder index: TOKEN_ADDRESS is required');
  if (!(fromBlockConfigured > 0)) {
    throw new Error(
      'holder index: HOLDER_INDEX_FROM_BLOCK is not set. It must be the block the token was ' +
        'deployed in — starting later misses the mint, and the totalSupply check below will ' +
        'refuse the result. Find it on the explorer under the contract\'s creation transaction.'
    );
  }

  const stored = await repo.getHolderIndex(token);
  const balances = new Map();
  if (stored && stored.balances) {
    for (const [addr, raw] of Object.entries(stored.balances)) balances.set(lower(addr), BigInt(raw));
  }
  const fromBlock = stored && stored.lastBlock >= fromBlockConfigured ? stored.lastBlock + 1 : fromBlockConfigured;

  const events = await fetchTransfers({ token, fromBlock, toBlock: head, chunkSize, getLogs: deps.getLogs });
  applyTransfers(balances, events);

  // The whole point. An explorer's answer cannot be checked; this one can.
  const supply = BigInt(await readSupply());
  const summed = sumBalances(balances);
  if (summed !== supply) {
    throw new Error(
      `holder index: balances sum to ${summed} but totalSupply is ${supply} ` +
        `(off by ${summed > supply ? summed - supply : supply - summed}). ` +
        'The usual cause is HOLDER_INDEX_FROM_BLOCK being later than the deployment, so the ' +
        'mint was never indexed. Refusing to distribute against a list that does not add up.'
    );
  }

  await repo.setHolderIndex(token, {
    lastBlock: head,
    balances: Object.fromEntries([...balances].map(([a, v]) => [a, v.toString()])),
  });

  return { holders: toHolders(balances), lastBlock: head, indexedEvents: events.length, fromBlock };
}

module.exports = {
  applyTransfers,
  sumBalances,
  toHolders,
  chunkRanges,
  decodeTransfers,
  fetchTransfers,
  buildHolderIndex,
  ZERO,
  TRANSFER_TOPIC,
};

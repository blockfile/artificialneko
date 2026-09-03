'use strict';

// Snapshot of a token's holders on Robinhood Chain via the Blockscout REST API
// (GET {EXPLORER_API}/api/v2/tokens/{token}/holders, paginated by
// next_page_params). Live mode only; DRY_RUN returns simulated holders so the
// airdrop path can be exercised without a real token.

const config = require('../config');
const { wallet } = require('./provider');
const { fetchJson } = require('../services/fetchJson');

// Pure: collapse token holdings to per-owner balances, drop excluded owners and
// balances below `minHoldRaw`. `accounts`: [{ owner, amountRaw }]. `excludeSet`:
// Set of lowercased addresses. Returns [{ owner, balanceRaw }].
function filterEligible(accounts, minHoldRaw, excludeSet) {
  const min = BigInt(minHoldRaw.toString());
  const byOwner = new Map();
  for (const a of accounts) {
    const owner = String(a.owner);
    if (excludeSet.has(owner.toLowerCase())) continue;
    byOwner.set(owner, (byOwner.get(owner) || 0n) + BigInt(a.amountRaw.toString()));
  }
  const out = [];
  for (const [owner, bal] of byOwner) {
    if (bal >= min) out.push({ owner, balanceRaw: bal.toString() });
  }
  return out;
}

// Pure: distinct owners with any nonzero balance — the "total holders" figure
// explorers display (no min-hold filter, no exclusions).
function countOwners(accounts) {
  const owners = new Set();
  for (const a of accounts) {
    if (BigInt(a.amountRaw.toString()) > 0n) owners.add(String(a.owner).toLowerCase());
  }
  return owners.size;
}

// On-chain (via explorer): every holder of `token`, following pagination.
// Returns [{ owner, amountRaw }].
async function fetchAllHolders(token) {
  const base = `${config.explorerApi}/api/v2/tokens/${token}/holders`;
  const out = [];
  let params = null;
  let guard = 0;
  do {
    const url = params ? `${base}?${new URLSearchParams(params).toString()}` : base;
    // Retry transient explorer errors (Blockscout/Cloudflare 520/5xx/429) so a
    // blip doesn't fail the whole cycle after the claim has already happened.
    let data;
    try {
      // A generous timeout, deliberately. The default is tuned for a browser
      // waiting on /stats, where slow means broken; this is the bot paging
      // through every holder of the token, one page at a time, and it is
      // ALLOWED to be slow. A 6s default aborted this mid-cycle and failed the
      // whole run AFTER the escrow had been claimed and the gas leg swapped -
      // the most expensive moment to fail.
      data = await fetchJson(url, {
        headers: { accept: 'application/json' },
        timeoutMs: config.holdersFetchTimeoutMs,
      });
    } catch (err) {
      throw new Error(`holders fetch failed (${err.status || err.message}) for ${token}`);
    }
    for (const it of data.items || []) {
      out.push({ owner: it.address.hash, amountRaw: String(it.value) });
    }
    params = data.next_page_params || null;
    guard += 1;
  } while (params && guard < 2000);
  return out;
}

/**
 * Snapshot the eligible holders of `token`.
 * @param {{token: string, minHoldRaw: string|bigint, exclude: Set<string>|string[]}} opts
 * @returns {Promise<{holders: {owner:string, balanceRaw:string}[], totalHolders: number}>}
 */
async function snapshotEligibleHolders({ token, minHoldRaw, exclude }) {
  const excludeSet =
    exclude instanceof Set ? exclude : new Set((exclude || []).map((a) => String(a).toLowerCase()));

  if (config.dryRun) {
    const min = BigInt(minHoldRaw.toString());
    const sim = [
      { owner: '0x1111111111111111111111111111111111111111', amountRaw: String(min * 2n) },
      { owner: '0x2222222222222222222222222222222222222222', amountRaw: String(min * 3n) },
      { owner: wallet.address, amountRaw: String(min * 9n) }, // operating wallet (excluded)
    ];
    return { holders: filterEligible(sim, minHoldRaw, excludeSet), totalHolders: countOwners(sim) };
  }

  const accounts = await fetchAllHolders(token);
  return { holders: filterEligible(accounts, minHoldRaw, excludeSet), totalHolders: countOwners(accounts) };
}

module.exports = { filterEligible, countOwners, fetchAllHolders, snapshotEligibleHolders };

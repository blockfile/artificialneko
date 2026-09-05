'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { filterEligible, countOwners, snapshotEligibleHolders } = require('./holders');
const { buildExcludeSet } = require('./exclude');
const { wallet } = require('./provider');
const config = require('./../config');

test('filterEligible collapses per-owner, drops excluded + below-min', () => {
  const accounts = [
    { owner: '0xAAA', amountRaw: '60' },
    { owner: '0xAAA', amountRaw: '50' }, // same owner -> 110
    { owner: '0xBBB', amountRaw: '40' }, // below min 100
    { owner: '0xCCC', amountRaw: '200' },
    { owner: '0xDeaD', amountRaw: '999' }, // excluded (case-insensitive)
  ];
  const exclude = new Set(['0xdead']);
  const out = filterEligible(accounts, '100', exclude);
  const map = Object.fromEntries(out.map((h) => [h.owner, h.balanceRaw]));
  assert.deepStrictEqual(Object.keys(map).sort(), ['0xAAA', '0xCCC']);
  assert.strictEqual(map['0xAAA'], '110');
});

test('countOwners counts distinct nonzero owners (no min, no exclude)', () => {
  const accounts = [
    { owner: '0xAAA', amountRaw: '1' },
    { owner: '0xAAA', amountRaw: '2' },
    { owner: '0xBBB', amountRaw: '0' }, // zero -> not counted
    { owner: '0xCCC', amountRaw: '5' },
  ];
  assert.strictEqual(countOwners(accounts), 2);
});

test('DRY_RUN snapshot returns simulated eligible holders, excluding the operating wallet', async () => {
  const minHoldRaw = (10n ** 18n * 100000n).toString(); // 100k * 1e18
  const exclude = await buildExcludeSet(null);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: null, minHoldRaw, exclude });
  assert.strictEqual(totalHolders, 3);
  assert.strictEqual(holders.length, 2); // operating wallet excluded
  assert.ok(!holders.some((h) => h.owner.toLowerCase() === wallet.address.toLowerCase()));
});

test('buildExcludeSet includes wallet, dead, pool manager, reward token', async () => {
  const set = await buildExcludeSet(null);
  assert.ok(set.has(wallet.address.toLowerCase()));
  assert.ok(set.has(config.deadAddress.toLowerCase()));
  assert.ok(set.has(config.poolManager.toLowerCase()));
  assert.ok(set.has(config.quoteTokenAddress.toLowerCase()));
});

test('the holder enumeration is given far longer than a browser-facing read', async () => {
  // A 6s default - right for /stats, where slow means broken - aborted the
  // holder paging mid-cycle and failed the run AFTER the escrow was claimed and
  // the gas leg swapped, stranding the holders' share in the wallet. Paging
  // every holder is allowed to be slow.
  const config = require('../config');
  assert.ok(
    config.holdersFetchTimeoutMs >= 30_000,
    `holder paging needs room to breathe, got ${config.holdersFetchTimeoutMs}ms`
  );
  const { TIMEOUT_MS } = require('../services/fetchJson');
  assert.ok(
    config.holdersFetchTimeoutMs > TIMEOUT_MS,
    'it must not inherit the browser-facing default'
  );
});

// ── the retry budget has to survive a Blockscout wobble ───────────────────

const { fetchAllHolders } = require('./holders');
const cfg = require('../config');

test('the holders fetch is patient, because it runs AFTER the money moves', async () => {
  // fetchJson defaults to 3 retries a second apart — right for /stats, where a
  // visitor is waiting and slow means broken. This call happens after the escrow
  // has been claimed and the gas leg swapped, so giving up in ~3 seconds fails
  // the cycle at its most expensive moment and strands the claim in the wallet,
  // recoverable only by hand via scripts/recover.js.
  //
  // Seen live: Blockscout returned 504 four times in a row and took the cycle
  // with it.
  const calls = [];
  await fetchAllHolders('0xtoken', {
    fetchJson: async (url, opts) => {
      calls.push(opts);
      return { items: [], next_page_params: null };
    },
  });

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].retries >= 6, `expected a patient retry budget, got ${calls[0].retries}`);
  assert.ok(calls[0].delayMs >= 2000, `and a real gap between tries, got ${calls[0].delayMs}`);
  assert.strictEqual(calls[0].timeoutMs, cfg.holdersFetchTimeoutMs, 'and the generous timeout it already had');
});

test('the holders fetch gives up as a WHOLE, not just per page', async () => {
  // Per-request patience multiplies. At 1,815 holders that is ~37 sequential
  // pages, and a generous per-page budget turned a slow explorer into a cycle
  // that held the run lock for hours — every trigger tick dropped behind it,
  // and the claim stranded in the wallet the entire time.
  //
  // A cycle that fails in minutes is recoverable and visible. One that hangs
  // is neither.
  const slow = async () => {
    await new Promise((r) => setTimeout(r, 30));
    return { items: [{ address: { hash: '0x1' }, value: '1' }], next_page_params: { page: 2 } };
  };

  await assert.rejects(
    () => fetchAllHolders('0xtoken', { fetchJson: slow, deadlineMs: 120, now: () => Date.now() }),
    /gave up|deadline/i,
    'an endless pager must end the fetch, not run until the next trigger tick'
  );
});

// ── the index must not become a new way to fail ───────────────────────────

const { listAccounts } = require('./holders');

test('a broken index falls back to the explorer rather than failing the cycle', async () => {
  // The index is faster and checkable, but it is an addition, not a new
  // dependency to be taken hostage by. If it cannot vouch for its answer the
  // cycle still runs — slower, on the explorer, exactly as it did before.
  let explorerCalled = 0;
  const out = await listAccounts('0xtoken', {
    holderIndexFromBlock: 100,
    buildHolderIndex: async () => { throw new Error('balances do not add up to totalSupply'); },
    fetchAllHolders: async () => { explorerCalled += 1; return [{ owner: '0xa', amountRaw: '5' }]; },
  });
  assert.strictEqual(explorerCalled, 1);
  assert.deepStrictEqual(out, [{ owner: '0xa', amountRaw: '5' }]);
});

test('a healthy index means the explorer is never touched', async () => {
  let explorerCalled = 0;
  const out = await listAccounts('0xtoken', {
    holderIndexFromBlock: 100,
    buildHolderIndex: async () => ({ holders: [{ owner: '0xa', balanceRaw: '7' }], indexedEvents: 3 }),
    fetchAllHolders: async () => { explorerCalled += 1; return []; },
  });
  assert.strictEqual(explorerCalled, 0, 'the whole point is not calling it');
  assert.deepStrictEqual(out, [{ owner: '0xa', amountRaw: '7' }], 'and the explorer shape is preserved');
});

test('with no start block configured the index is not attempted at all', async () => {
  let indexCalled = 0;
  await listAccounts('0xtoken', {
    holderIndexFromBlock: 0,
    buildHolderIndex: async () => { indexCalled += 1; return { holders: [], indexedEvents: 0 }; },
    fetchAllHolders: async () => [{ owner: '0xa', amountRaw: '1' }],
  });
  assert.strictEqual(indexCalled, 0, 'unset means the old behaviour, unchanged');
});

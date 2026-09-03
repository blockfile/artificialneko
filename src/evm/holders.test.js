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

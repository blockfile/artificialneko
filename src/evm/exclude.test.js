'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';
process.env.AIRDROP_EXCLUDE = '0x1111111111111111111111111111111111111111';
delete require.cache[require.resolve('../config')];

const config = require('../config');
const { buildExcludeSet } = require('./exclude');

test('excludes every contract that custodies tokens but is not a holder', async () => {
  const launch = { curve: '0x00000000000000000000000000000000000c0f1e', graduated: true };
  const set = await buildExcludeSet(launch);
  for (const addr of [
    config.wallet.address, config.deadAddress, config.poolManager, config.memeHook,
    config.buybackVault, config.feeEscrow, config.v2Factory, config.quoteTokenAddress, launch.curve,
  ]) {
    assert.ok(set.has(String(addr).toLowerCase()), `expected ${addr} to be excluded`);
  }
});

test('honours extra addresses from AIRDROP_EXCLUDE', async () => {
  const set = await buildExcludeSet({ curve: null, graduated: false });
  for (const a of config.airdropExclude) assert.ok(set.has(a.toLowerCase()));
});

test('tolerates a launch with no curve address', async () => {
  const set = await buildExcludeSet({ curve: null, graduated: false });
  assert.ok(set.size > 0);
});

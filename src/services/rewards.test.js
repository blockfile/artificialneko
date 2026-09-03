'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { EMPTY } = require('./rewards');

test('pre-launch, the rewarded total is null rather than zero', () => {
  // The site hides a null tile but renders a 0 as a real "nothing paid" claim.
  assert.strictEqual(EMPTY.totalRewarded, null);
});

test('the total sums real payouts and ignores simulated ones', async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'artificialneko_rewards_test';
  process.env.TOKEN_ADDRESS = '0x50d0d0da00ffd195d2d1d2448617ad039855ad2b';
  for (const m of ['./../config', '../db/index', '../db/repository', './rewards']) {
    delete require.cache[require.resolve(m)];
  }
  const config = require('./../config');
  const db = require('../db');
  const repo = require('../db/repository');
  const { fetchRewards } = require('./rewards');

  await db.connect();
  const cycleId = await repo.createCycle({ dryRun: false });
  // Holders are paid the REWARD token, and that is what the ledger records.
  const common = { cycleId, rewardToken: config.rewardTokenAddress, amountRaw: '1' };

  await repo.addAirdrop({ ...common, recipient: '0xa', amountUi: 2.5, signature: `0x${'a'.repeat(64)}`, status: 'ok' });
  await repo.addAirdrop({ ...common, recipient: '0xb', amountUi: 1.5, signature: `0x${'b'.repeat(64)}`, status: 'ok' });
  await repo.addAirdrop({ ...common, recipient: '0xc', amountUi: 99, signature: 'airdrop_ka9f2x', status: 'ok' });
  await repo.addAirdrop({ ...common, recipient: '0xd', amountUi: 50, signature: `0x${'d'.repeat(64)}`, status: 'failed' });

  const out = await fetchRewards();
  assert.strictEqual(out.totalRewarded, 4, 'only the two real, successful payouts count');

  await db.close();
  await mongod.stop();
});

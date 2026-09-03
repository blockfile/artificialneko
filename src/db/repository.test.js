'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let db;
let repo;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'artificialneko_test';
  process.env.DRY_RUN = 'true';
  delete require.cache[require.resolve('../config')];
  db = require('./index');
  repo = require('./repository');
  await db.connect();
});

test.after(async () => {
  await db.close();
  await mongod.stop();
});

const REAL_TX = `0x${'a'.repeat(64)}`;

test('a page of airdrops comes back newest-first with a cursor', async () => {
  const cycleId = await repo.createCycle({ dryRun: false });
  for (let i = 0; i < 3; i += 1) {
    await repo.addAirdrop({
      cycleId,
      rewardToken: '0xnvda',
      recipient: `0xholder${i}`,
      amountRaw: '1000',
      amountUi: 1.5,
      signature: REAL_TX,
      status: 'ok',
    });
  }

  const page = await repo.getAirdropPage(2, null);
  assert.strictEqual(page.rows.length, 2);
  assert.ok(page.rows[0].id > page.rows[1].id, 'newest first');
  assert.strictEqual(page.nextCursor, String(page.rows[1].id));

  const next = await repo.getAirdropPage(2, page.nextCursor);
  assert.strictEqual(next.rows.length, 1);
  assert.strictEqual(next.nextCursor, null, 'no cursor once the feed is exhausted');
});

test('the distributed total counts only payouts with a real tx hash', async () => {
  const cycleId = await repo.createCycle({ dryRun: true });
  await repo.addAirdrop({
    cycleId,
    rewardToken: '0xsim',
    recipient: '0xa',
    amountRaw: '1',
    amountUi: 99,
    signature: 'airdrop_ka9f2x',
    status: 'ok',
  });
  const totals = await repo.getDistributedTotal('0xsim');
  assert.strictEqual(totals.totalUi, 0, 'a simulated payout must never be counted');
});

test('a simulated payout never reaches the public feed either', async () => {
  const page = await repo.getAirdropPage(50, null);
  assert.ok(
    page.rows.every((r) => /^0x[0-9a-fA-F]{64}$/.test(r.signature)),
    'every served row must carry a real transaction hash'
  );
});

test('a failed send is excluded even when its hash looks real', async () => {
  const cycleId = await repo.createCycle({ dryRun: false });
  await repo.addAirdrop({
    cycleId,
    rewardToken: '0xnvda',
    recipient: '0xreverted',
    amountRaw: '5',
    amountUi: 5,
    signature: `0x${'b'.repeat(64)}`,
    status: 'failed',
  });
  const page = await repo.getAirdropPage(50, null);
  assert.ok(!page.rows.some((r) => r.recipient === '0xreverted'), 'a reverted transfer is not a payout');
});

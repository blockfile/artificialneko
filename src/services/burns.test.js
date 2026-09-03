'use strict';

process.env.DRY_RUN = 'true';
process.env.TOKEN_ADDRESS = '0x50d0d0da00ffd195d2d1d2448617ad039855ad2b';

const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { EMPTY } = require('./burns');

let mongod;
let db;
let repo;
let fetchBurns;

// Lifecycle in before/after, NOT inline: a failed assertion mid-test would
// otherwise skip the teardown, leave mongod running, and hang the whole file
// until the runner's timeout.
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'artificialneko_burns_test';
  for (const m of ['./../config', '../db/index', '../db/repository', './burns']) {
    delete require.cache[require.resolve(m)];
  }
  db = require('../db');
  repo = require('../db/repository');
  ({ fetchBurns } = require('./burns'));
  await db.connect();
});

test.after(async () => {
  if (db) await db.close();
  if (mongod) await mongod.stop();
});

const REAL_TX = `0x${'a'.repeat(64)}`;

test('pre-launch, the burn total is null rather than zero', () => {
  // The site hides a null tile but renders a 0 as a real "nothing burned" claim.
  assert.strictEqual(EMPTY.totalBurned, null);
  assert.strictEqual(EMPTY.burnQuoteSpent, null);
});

test('sums real burns and ignores simulated or unburned ones', async () => {
  const cycleId = await repo.createCycle({ dryRun: false });
  const buyback = ({ signature = REAL_TX, status = 'ok', ...detail }) =>
    repo.addStep({ cycleId, name: 'buyback', status, signature, detail });

  await buyback({ burned: true, tokensBought: 100, quoteSpent: 1 });
  await buyback({ burned: true, tokensBought: 50, quoteSpent: 0.5 });

  // A DRY_RUN burn: status 'ok' and burned true, but a fabricated signature.
  // Counting it would publish an invented burn to visitors.
  await buyback({ signature: 'burn_ka9f2x', burned: true, tokensBought: 9999, quoteSpent: 99 });

  // Bought but NOT burned — the tokens exist and totalSupply has not dropped,
  // so this must not be reported as a burn.
  await buyback({
    signature: `0x${'b'.repeat(64)}`,
    status: 'failed',
    burned: false,
    bought: true,
    tokensBought: 777,
    quoteSpent: 7,
  });

  const out = await fetchBurns();
  assert.strictEqual(out.totalBurned, 150, 'only the two real, burned buybacks count');
  assert.strictEqual(out.burnQuoteSpent, 1.5, 'and only what those two cost');
  assert.strictEqual(out.burns, 2);
});

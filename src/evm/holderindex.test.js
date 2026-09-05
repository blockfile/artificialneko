'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { applyTransfers, sumBalances, toHolders, chunkRanges, ZERO, TRANSFER_TOPIC } = require('./holderindex');

const t = (from, to, value) => ({ from, to, value: BigInt(value) });
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = '0xcccccccccccccccccccccccccccccccccccccccc';
const DEAD = '0x000000000000000000000000000000000000dead';

test('a mint credits the recipient and debits nobody', () => {
  const bal = applyTransfers(new Map(), [t(ZERO, A, 1000)]);
  assert.strictEqual(bal.get(A), 1000n);
  assert.strictEqual(bal.has(ZERO), false, 'the zero address is not a holder');
  assert.strictEqual(sumBalances(bal), 1000n);
});

test('a transfer moves value without changing the total', () => {
  const bal = applyTransfers(new Map(), [t(ZERO, A, 1000), t(A, B, 400)]);
  assert.strictEqual(bal.get(A), 600n);
  assert.strictEqual(bal.get(B), 400n);
  assert.strictEqual(sumBalances(bal), 1000n, 'a transfer is not a mint');
});

test('a burn to the zero address leaves the supply', () => {
  // burn(uint256) emits Transfer(holder, 0x0, amount) and totalSupply drops, so
  // the index has to drop it too or its sum will never match the token's.
  const bal = applyTransfers(new Map(), [t(ZERO, A, 1000), t(A, ZERO, 250)]);
  assert.strictEqual(bal.get(A), 750n);
  assert.strictEqual(sumBalances(bal), 750n);
});

test('a transfer to 0x…dead is NOT a burn — it is still held', () => {
  // Supply is unchanged when tokens are parked at a dead address, so counting
  // it as a burn would put the index permanently out of step with totalSupply.
  // buildExcludeSet drops that address from the airdrop separately.
  const bal = applyTransfers(new Map(), [t(ZERO, A, 1000), t(A, DEAD, 250)]);
  assert.strictEqual(bal.get(DEAD), 250n);
  assert.strictEqual(sumBalances(bal), 1000n);
});

test('an address emptied to zero stops being a holder', () => {
  // Left in place it would be airdropped a zero allocation, and counted in the
  // holder total the site shows.
  const bal = applyTransfers(new Map(), [t(ZERO, A, 100), t(A, B, 100)]);
  assert.strictEqual(bal.has(A), false);
  assert.strictEqual(toHolders(bal).length, 1);
});

test('addresses are matched case-insensitively', () => {
  // Logs decode to checksummed addresses; anything already stored came back
  // from Mongo as written. Two casings of one holder would split a balance in
  // half and airdrop them twice.
  const bal = applyTransfers(new Map(), [t(ZERO, A.toUpperCase(), 100), t(A, B, 30)]);
  assert.strictEqual(bal.get(A), 70n);
  assert.strictEqual(bal.get(B), 30n);
  assert.strictEqual(bal.size, 2);
});

test('applying a batch twice would double it — so callers must not', () => {
  // Guards the contract that makes incremental indexing safe: the fold is NOT
  // idempotent, so lastBlock has to advance past what was applied.
  const once = applyTransfers(new Map(), [t(ZERO, A, 100)]);
  const twice = applyTransfers(once, [t(ZERO, A, 100)]);
  assert.strictEqual(twice.get(A), 200n);
});

test('an incremental batch continues from the stored balances', () => {
  const first = applyTransfers(new Map(), [t(ZERO, A, 1000)]);
  const second = applyTransfers(first, [t(A, B, 250), t(A, C, 250)]);
  assert.strictEqual(second.get(A), 500n);
  assert.strictEqual(sumBalances(second), 1000n);
});

test('toHolders gives the shape the airdrop already consumes', () => {
  const bal = applyTransfers(new Map(), [t(ZERO, A, 5)]);
  assert.deepStrictEqual(toHolders(bal), [{ owner: A, balanceRaw: '5' }]);
});

// ── block ranges ──────────────────────────────────────────────────────────
// The RPC refused a 200,000-block getLogs and served 50,000 in 872ms, so the
// backfill has to be chunked and the chunking has to be exact — a dropped or
// repeated block is a wrong balance nobody would notice until a payout.

test('ranges cover every block exactly once, with no gap or overlap', () => {
  const ranges = chunkRanges(100, 350, 100);
  assert.deepStrictEqual(ranges, [[100, 199], [200, 299], [300, 350]]);
});

test('a range shorter than one chunk is a single request', () => {
  assert.deepStrictEqual(chunkRanges(10, 20, 50000), [[10, 20]]);
});

test('nothing new to index is no requests at all', () => {
  assert.deepStrictEqual(chunkRanges(500, 499, 50000), []);
});

// ── buildHolderIndex: the check an explorer cannot offer ──────────────────

const { buildHolderIndex } = require('./holderindex');

const fakeRepo = (stored = null) => {
  const saved = [];
  return { saved, getHolderIndex: async () => stored, setHolderIndex: async (t, v) => saved.push(v) };
};
const logsFor = (events) => async () =>
  events.map((e) => ({
    topics: [TRANSFER_TOPIC, `0x${'0'.repeat(24)}${e.from.slice(2)}`, `0x${'0'.repeat(24)}${e.to.slice(2)}`],
    data: `0x${BigInt(e.value).toString(16).padStart(64, '0')}`,
  }));

test('an index that does not add up to totalSupply is REFUSED', async () => {
  // The reason to derive holders rather than ask for them. A short list from an
  // explorer is paid as a short list; a short list here cannot be, because the
  // arithmetic gives it away before any NVDA moves.
  const repo = fakeRepo();
  await assert.rejects(
    () =>
      buildHolderIndex({
        token: '0xtoken', fromBlock: 1, head: 10, chunkSize: 50, repo,
        getLogs: logsFor([t(ZERO, A, 600)]),
        totalSupply: async () => 1000n, // the mint we indexed is short by 400
      }),
    /does not add up|sum to 600 but totalSupply is 1000/,
  );
  assert.strictEqual(repo.saved.length, 0, 'and nothing is persisted from a bad run');
});

test('a matching index is persisted with the block it was correct at', async () => {
  const repo = fakeRepo();
  const out = await buildHolderIndex({
    token: '0xtoken', fromBlock: 1, head: 42, chunkSize: 50, repo,
    getLogs: logsFor([t(ZERO, A, 700), t(A, B, 200)]),
    totalSupply: async () => 700n,
  });
  assert.strictEqual(out.holders.length, 2);
  assert.strictEqual(out.lastBlock, 42);
  assert.strictEqual(repo.saved[0].lastBlock, 42, 'lastBlock and balances are written together');
  assert.strictEqual(repo.saved[0].balances[A], '500');
});

test('a warm index only reads the blocks it has not seen', async () => {
  // The fold is not idempotent, so re-reading an applied block doubles it. This
  // is the contract the whole incremental design rests on.
  const asked = [];
  await buildHolderIndex({
    token: '0xtoken', fromBlock: 1, head: 900, chunkSize: 1000,
    repo: fakeRepo({ lastBlock: 800, balances: { [A]: '1000' } }),
    getLogs: async (f) => { asked.push([f.fromBlock, f.toBlock]); return []; },
    totalSupply: async () => 1000n,
  });
  assert.deepStrictEqual(asked, [[801, 900]], 'resumes at lastBlock + 1, never re-reads');
});

test('an unset start block is refused, not guessed', async () => {
  await assert.rejects(
    () => buildHolderIndex({ token: '0xtoken', fromBlock: 0, head: 10, repo: fakeRepo() }),
    /HOLDER_INDEX_FROM_BLOCK/,
  );
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeWeightedAllocations, capToRaw } = require('./distribution');

// helper: turn result into { owner: amount } and the integer sum
function toMap(out) {
  const m = {};
  let sum = 0n;
  for (const { owner, amountRaw } of out) {
    m[owner] = (m[owner] || 0n) + BigInt(amountRaw);
    sum += BigInt(amountRaw);
  }
  return { m, sum };
}

test('pro-rata by balance when no cap (Leg B shape)', () => {
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '100' }, { owner: 'B', balanceRaw: '300' }],
    '400',
    { capPct: null }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 400n);
  assert.strictEqual(m.A, 100n); // 400 * 100/400
  assert.strictEqual(m.B, 300n); // 400 * 300/400
});

test('caps a whale at 2% of supply (Leg A shape)', () => {
  // supply 1,000,000 -> 2% cap = 20,000. Whale holds 500,000 (capped to 20,000),
  // small holder 20,000 (uncapped). Equal weights -> equal split of 1,000.
  const out = computeWeightedAllocations(
    [{ owner: 'WHALE', balanceRaw: '500000' }, { owner: 'SMALL', balanceRaw: '20000' }],
    '1000',
    { capPct: 2, supplyRaw: '1000000' }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 1000n);
  assert.strictEqual(m.WHALE, 500n);
  assert.strictEqual(m.SMALL, 500n);
});

test('clustered wallets are capped as one entity, then split by internal balance', () => {
  // Cluster [X,Y] combined 30,000 capped at 20,000 (2% of 1,000,000). Z holds 20,000.
  // Two entities, equal capped weight -> 500 each. Cluster's 500 splits X:Y = 10000:20000 = 167:333.
  const out = computeWeightedAllocations(
    [
      { owner: 'X', balanceRaw: '10000' },
      { owner: 'Y', balanceRaw: '20000' },
      { owner: 'Z', balanceRaw: '20000' },
    ],
    '1000',
    { capPct: 2, supplyRaw: '1000000', clusters: [['X', 'Y']] }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 1000n);
  assert.strictEqual(m.Z, 500n);
  assert.strictEqual(m.X + m.Y, 500n);
  assert.strictEqual(m.X, 167n); // floor(500 * 10000/30000) = 166 + 1 largest-remainder
  assert.strictEqual(m.Y, 333n); // floor(500 * 20000/30000) = 333
});

// ── I2: a tiny REWARD_CAP_PCT must still produce a cap, not silence ─────────
// The old maths was supply * round(capPct * 100) / 10000, so every capPct below
// 0.005 rounded to a ZERO cap: every weight clamped to 0, totalWeight hit 0,
// and the function returned [] — the step recorded 'ok' and the ROBBIE just
// bought was stranded with no error anywhere.
test('a sub-0.005 REWARD_CAP_PCT still allocates, and still caps', () => {
  const holders = [{ owner: 'WHALE', balanceRaw: '500000' }, { owner: 'SMALL', balanceRaw: '5' }];
  for (const capPct of [0.001, 0.004]) {
    const out = computeWeightedAllocations(holders, '1000', { capPct, supplyRaw: '1000000' });
    const { m, sum } = toMap(out);
    assert.strictEqual(out.length, 2, `capPct ${capPct} dropped recipients`);
    assert.strictEqual(sum, 1000n, `capPct ${capPct} lost tokens`);
    // Uncapped, the whale's 500000 vs 5 would take 999 of 1000. The cap is
    // 10 (0.001%) / 40 (0.004%) of supply, so it must take far less.
    assert.ok(m.WHALE < 900n, `capPct ${capPct} did not cap the whale (${m.WHALE})`);
    assert.ok(m.SMALL > 0n, `capPct ${capPct} starved the small holder`);
  }
});

test('capToRaw keeps precision far below 0.005% and never returns zero', () => {
  const supply = 1000000n;
  assert.strictEqual(capToRaw(2, supply), 20000n);      // 2%
  assert.strictEqual(capToRaw(0.004, supply), 40n);     // 0.004%
  assert.strictEqual(capToRaw(0.001, supply), 10n);     // 0.001% — was 0 before
  assert.strictEqual(capToRaw(0.0001, supply), 1n);
  // A cap finer than one base unit degrades to "everyone capped equally",
  // which is an equal split — never an empty allocation.
  assert.strictEqual(capToRaw(1e-12, supply), 1n);
});

// ── I3: CLUSTERS must not care about address casing ─────────────────────────
// Holder addresses come back EIP-55 checksummed from Blockscout while CLUSTERS
// is hand-written in .env, so a case-sensitive lookup matched nothing and the
// anti-sybil cap quietly did nothing at all.
test('a lowercase CLUSTERS entry caps exactly like a checksummed one', () => {
  const A = '0xAbCdEf0000000000000000000000000000000001'; // sybil 1 (checksummed)
  const B = '0xAbCdEf0000000000000000000000000000000002'; // sybil 2
  const C = '0xAbCdEf0000000000000000000000000000000003'; // honest holder
  const holders = [
    { owner: A, balanceRaw: '30000' },
    { owner: B, balanceRaw: '30000' },
    { owner: C, balanceRaw: '20000' },
  ];
  // 3% of 1,000,000 = a 30,000 cap: it binds on the clustered pair (60,000
  // combined) and on neither wallet alone.
  const run = (clusters) =>
    toMap(computeWeightedAllocations(holders, '1000', { capPct: 3, supplyRaw: '1000000', clusters })).m;

  const checksummed = run([[A, B]]);
  const lowercased = run([[A.toLowerCase(), B.toLowerCase()]]);
  const uppercased = run([[A.toUpperCase(), B.toUpperCase()]]);
  const none = run([]);

  // Clustered, the pair is ONE entity: 300/300 against the honest holder's 400.
  assert.strictEqual(checksummed[C], 400n);
  assert.strictEqual(checksummed[A], 300n);
  assert.strictEqual(checksummed[B], 300n);
  // The whole point: casing must not change a single number.
  assert.deepStrictEqual(lowercased, checksummed);
  assert.deepStrictEqual(uppercased, checksummed);
  // Unclustered the pair takes 750 and the honest holder drops to 250 — which
  // is exactly what a case-sensitive lookup silently produced.
  assert.strictEqual(none[C], 250n);
  assert.strictEqual(none[A] + none[B], 750n);
});

test('clustered payouts keep the holder address casing the airdrop sends to', () => {
  const A = '0xAbCdEf0000000000000000000000000000000001';
  const B = '0xAbCdEf0000000000000000000000000000000002';
  const out = computeWeightedAllocations(
    [{ owner: A, balanceRaw: '10000' }, { owner: B, balanceRaw: '10000' }],
    '1000',
    { capPct: 2, supplyRaw: '1000000', clusters: [[A.toLowerCase(), B.toLowerCase()]] }
  );
  assert.deepStrictEqual(out.map((o) => o.owner).sort(), [A, B].sort());
});

test('largest-remainder makes the sum exact (no dust, no overflow)', () => {
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '1' }, { owner: 'B', balanceRaw: '1' }, { owner: 'C', balanceRaw: '1' }],
    '7', // 7/3 = 2 each + 1 leftover -> someone gets 3
    { capPct: null }
  );
  const { sum } = toMap(out);
  assert.strictEqual(sum, 7n);
  assert.strictEqual(out.length, 3);
});

test('returns [] for empty / zero / all-zero-balance inputs', () => {
  assert.deepStrictEqual(computeWeightedAllocations([], '100', { capPct: null }), []);
  assert.deepStrictEqual(
    computeWeightedAllocations([{ owner: 'A', balanceRaw: '5' }], '0', { capPct: null }),
    []
  );
  assert.deepStrictEqual(
    computeWeightedAllocations([{ owner: 'A', balanceRaw: '0' }], '100', { capPct: null }),
    []
  );
});

test('allocations sum exactly to the amount bought, leaving no dust behind', () => {
  const holders = [
    { owner: '0xaa', balanceRaw: '333' },
    { owner: '0xbb', balanceRaw: '333' },
    { owner: '0xcc', balanceRaw: '334' },
  ];
  const total = 1000000n;
  const out = computeWeightedAllocations(holders, total.toString(), {});
  const sum = out.reduce((s, a) => s + BigInt(a.amountRaw), 0n);
  assert.strictEqual(sum, total);
});

test('a holder with zero balance receives nothing', () => {
  const out = computeWeightedAllocations(
    [{ owner: '0xaa', balanceRaw: '0' }, { owner: '0xbb', balanceRaw: '100' }],
    '500', {}
  );
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].owner, '0xbb');
});

// ── never ask for more than the wallet holds ──────────────────────────────

test('allocations within the balance are left exactly as they are', () => {
  const { fitAllocationsToBalance } = require('./distribution');
  const allocs = [{ owner: '0xa', amountRaw: '100' }, { owner: '0xb', amountRaw: '200' }];
  const fit = fitAllocationsToBalance(allocs, 300n);
  assert.strictEqual(fit.scaled, false);
  assert.deepStrictEqual(fit.allocations, allocs);
});

test('a shortfall scales everyone down instead of skipping a whole batch', () => {
  // The live failure: a batch of 5 wanted more than the wallet held, the
  // disperser is all-or-nothing, and all 5 holders got nothing while earlier
  // batches were paid in full. Paying slightly less beats paying nobody.
  const { fitAllocationsToBalance } = require('./distribution');
  const allocs = [
    { owner: '0xa', amountRaw: '600' },
    { owner: '0xb', amountRaw: '300' },
    { owner: '0xc', amountRaw: '100' },
  ];
  const fit = fitAllocationsToBalance(allocs, 500n);
  assert.strictEqual(fit.scaled, true);
  const sum = fit.allocations.reduce((s, a) => s + BigInt(a.amountRaw), 0n);
  assert.strictEqual(sum, 500n, 'the scaled total must equal the balance to the wei');
  assert.strictEqual(fit.allocations.length, 3, 'nobody is dropped');
  // proportions preserved: 6:3:1 of 500
  assert.strictEqual(fit.allocations[0].amountRaw, '300');
  assert.strictEqual(fit.allocations[1].amountRaw, '150');
  assert.strictEqual(fit.allocations[2].amountRaw, '50');
});

test('an empty wallet pays nobody rather than reverting a batch', () => {
  const { fitAllocationsToBalance } = require('./distribution');
  const fit = fitAllocationsToBalance([{ owner: '0xa', amountRaw: '10' }], 0n);
  assert.deepStrictEqual(fit.allocations, []);
  assert.strictEqual(fit.scaled, true);
});

test('holders whose scaled share rounds to zero are dropped, not sent 0', () => {
  const { fitAllocationsToBalance } = require('./distribution');
  const allocs = [{ owner: '0xa', amountRaw: '1000000' }, { owner: '0xb', amountRaw: '1' }];
  const fit = fitAllocationsToBalance(allocs, 2n);
  assert.ok(fit.allocations.every((a) => BigInt(a.amountRaw) > 0n));
  assert.strictEqual(fit.allocations.reduce((s, a) => s + BigInt(a.amountRaw), 0n), 2n);
});

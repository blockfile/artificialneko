'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.DRY_RUN = 'true';

const { buildPoolKey, poolIdOf, isZeroForOne, NATIVE } = require('./pool');

const ROBBIE = '0xe0eba1B76b73BE7bfA7716b6Ca96f724930e2263';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
// Read from chain 2026-08-14: hook.launches(<this>) returns registered = true.
const ROBBIE_POOL_ID = '0x813707ded6381854b2d96c3d942960c5d362244a0903ac7d5c4d471e0c6b175f';

// An ERC-20-QUOTED pons v2 pool — the shape every launch in THIS project has,
// since NEKO is quoted in NVDA and not in native ETH. Ryzen Kitty (RYZEN)
// paired with the AMD Robinhood Token, read from chain 2026-08-29 and
// cross-checked against StateView.getSlot0 and DexScreener's pair address.
// Worth its own fixture because with two real addresses the currency ordering
// is decided by comparing them, whereas address(0) always sorts first.
const RYZEN = '0x50d0d0da00FfD195d2d1d2448617ad039855ad2B';
const AMD = '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC';
const RYZEN_AMD_POOL_ID = '0xae6cdf3b4647d5eac2788562e35941b9dc825466597961f2f8dbedff068fd4c1';

test('sorts native ETH into currency0', () => {
  const key = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(key.currency0, NATIVE);
  assert.strictEqual(key.currency1.toLowerCase(), ROBBIE.toLowerCase());
});

test('derives ROBBIE\'s real poolId', () => {
  const key = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(poolIdOf(key), ROBBIE_POOL_ID);
});

test('sorting is independent of argument order', () => {
  const a = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  const b = buildPoolKey({ token: NATIVE, quoteToken: ROBBIE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(poolIdOf(a), poolIdOf(b));
});

test('zeroForOne is true when spending currency0', () => {
  const key = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(isZeroForOne(key, NATIVE), true);   // ETH -> ROBBIE
  assert.strictEqual(isZeroForOne(key, ROBBIE), false);  // ROBBIE -> ETH
});

test('a different tickSpacing is a different pool', () => {
  const a = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
  const b = buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 60, hooks: HOOK });
  assert.notStrictEqual(poolIdOf(a), poolIdOf(b));
});

test('derives the real poolId of an ERC-20-quoted launch (RYZEN/AMD)', () => {
  const key = buildPoolKey({ token: RYZEN, quoteToken: AMD, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(poolIdOf(key), RYZEN_AMD_POOL_ID);
});

test('with two real addresses, the lower one sorts into currency0', () => {
  const key = buildPoolKey({ token: RYZEN, quoteToken: AMD, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(key.currency0.toLowerCase(), RYZEN.toLowerCase(), '0x50d0… < 0x8692…');
  assert.strictEqual(key.currency1.toLowerCase(), AMD.toLowerCase());
});

test('an ERC-20-quoted pool sorts the same whichever side is named first', () => {
  const a = buildPoolKey({ token: RYZEN, quoteToken: AMD, fee: 0, tickSpacing: 200, hooks: HOOK });
  const b = buildPoolKey({ token: AMD, quoteToken: RYZEN, fee: 0, tickSpacing: 200, hooks: HOOK });
  assert.strictEqual(poolIdOf(a), poolIdOf(b));
});

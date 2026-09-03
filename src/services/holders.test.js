'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseTokenInfo, EMPTY } = require('./holders');

test('reads the holder count from the older `holders` field', () => {
  assert.strictEqual(parseTokenInfo({ holders: '6942' }).holders, 6942);
});

test('reads the holder count from the newer `holders_count` field', () => {
  assert.strictEqual(parseTokenInfo({ holders_count: 6942 }).holders, 6942);
});

test('a missing holder count is null, not zero', () => {
  assert.strictEqual(parseTokenInfo({}).holders, null);
  assert.strictEqual(parseTokenInfo({ holders: null }).holders, null);
  assert.strictEqual(parseTokenInfo({ holders: '' }).holders, null);
});

test('picks up circulating_market_cap as the market-cap fallback', () => {
  assert.strictEqual(parseTokenInfo({ circulating_market_cap: '1234.5' }).circulatingMarketCap, 1234.5);
});

test('a non-object response degrades to empty rather than throwing', () => {
  assert.deepStrictEqual(parseTokenInfo(null), EMPTY);
  assert.deepStrictEqual(parseTokenInfo('nope'), EMPTY);
});

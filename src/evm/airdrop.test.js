'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { chunk } = require('./airdrop');

test('chunk splits allocations into batches of the requested size', () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunk returns one batch when the size exceeds the input', () => {
  assert.deepStrictEqual(chunk([1, 2], 10), [[1, 2]]);
});

test('chunk never produces a zero-size batch, which would loop forever', () => {
  assert.deepStrictEqual(chunk([1, 2], 0), [[1], [2]]);
  assert.deepStrictEqual(chunk([1, 2], -5), [[1], [2]]);
});

test('chunk of an empty list is an empty list', () => {
  assert.deepStrictEqual(chunk([], 5), []);
});

test('chunk preserves order and loses no recipients', () => {
  const input = Array.from({ length: 97 }, (_, i) => i);
  const batches = chunk(input, 30);
  assert.strictEqual(batches.length, 4);
  assert.deepStrictEqual(batches.flat(), input, 'every recipient survives batching, in order');
});

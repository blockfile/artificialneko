'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { parseUnits } = require('ethers');
const { toPlainDecimalString, truncateDecimals, toUnitString } = require('./units');

test('leaves an ordinary decimal alone', () => {
  assert.strictEqual(toPlainDecimalString(21.368470124), '21.368470124');
  assert.strictEqual(toPlainDecimalString(0.5), '0.5');
  assert.strictEqual(toPlainDecimalString(100), '100');
});

test('expands the exponential notation parseUnits rejects', () => {
  // String(5.6e-7) === '5.6e-7', which parseUnits refuses outright.
  assert.strictEqual(toPlainDecimalString(5.6e-7), '0.00000056');
  assert.strictEqual(toPlainDecimalString(1e-9), '0.000000001');
  assert.strictEqual(toPlainDecimalString(1e21), '1000000000000000000000');
});

test('a tiny reward share converts to base units instead of throwing', () => {
  // The whole point: this is what a small claim's holder split looks like.
  assert.doesNotThrow(() => parseUnits(toUnitString(7e-7, 18), 18));
  assert.strictEqual(parseUnits(toUnitString(7e-7, 18), 18), 700000000000n);
});

test('does not mint base units the caller never had', () => {
  // toFixed(18) would render this as 21.368470124000001675 and invent 1675 wei.
  assert.strictEqual(parseUnits(toUnitString(21.368470124, 18), 18), 21368470124000000000n);
});

test('truncates sub-unit digits rather than rounding up', () => {
  assert.strictEqual(truncateDecimals('1.999999', 2), '1.99');
  assert.strictEqual(truncateDecimals('1.5', 6), '1.5');
  assert.strictEqual(truncateDecimals('100', 6), '100');
});

test('refuses a negative or non-finite amount', () => {
  assert.throws(() => toUnitString(-1, 18), /negative/);
  assert.throws(() => toUnitString(NaN, 18), /finite/);
  assert.throws(() => toUnitString(Infinity, 18), /finite/);
});

test('zero is a valid amount, not an error', () => {
  assert.strictEqual(parseUnits(toUnitString(0, 18), 18), 0n);
});

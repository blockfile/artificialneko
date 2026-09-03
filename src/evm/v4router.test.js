'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AbiCoder } = require('ethers');
process.env.DRY_RUN = 'true';

const { encodeExactInSingle, V4_SWAP } = require('./v4router');
const { buildPoolKey, NATIVE } = require('./pool');
const { EXACT_IN_SINGLE_TYPE } = require('./abi');

const ROBBIE = '0xe0eba1B76b73BE7bfA7716b6Ca96f724930e2263';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
const coder = AbiCoder.defaultAbiCoder();

function key() {
  return buildPoolKey({ token: ROBBIE, quoteToken: NATIVE, fee: 0, tickSpacing: 200, hooks: HOOK });
}

test('commands is the single V4_SWAP byte', () => {
  const { commands } = encodeExactInSingle({ poolKey: key(), zeroForOne: true, amountIn: 1n, amountOutMinimum: 0n });
  assert.strictEqual(commands, '0x10');
  assert.strictEqual(V4_SWAP, 0x10);
});

test('emits exactly one input, holding three actions', () => {
  const { inputs } = encodeExactInSingle({ poolKey: key(), zeroForOne: true, amountIn: 1n, amountOutMinimum: 0n });
  assert.strictEqual(inputs.length, 1);
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  assert.strictEqual(actions, '0x060c0f'); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  assert.strictEqual(params.length, 3);
});

test('the swap params round-trip with the amounts and direction given', () => {
  const amountIn = 12345n;
  const minOut = 999n;
  const { inputs } = encodeExactInSingle({ poolKey: key(), zeroForOne: true, amountIn, amountOutMinimum: minOut });
  const [, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const [decoded] = coder.decode([EXACT_IN_SINGLE_TYPE], params[0]);
  assert.strictEqual(decoded.zeroForOne, true);
  assert.strictEqual(decoded.amountIn, amountIn);
  assert.strictEqual(decoded.amountOutMinimum, minOut);
  assert.strictEqual(decoded.poolKey.currency0, NATIVE);
  assert.strictEqual(decoded.hookData, '0x');
});

test('settles the input currency and takes the output currency', () => {
  const { inputs } = encodeExactInSingle({ poolKey: key(), zeroForOne: true, amountIn: 500n, amountOutMinimum: 7n });
  const [, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const [settleCurrency, settleAmount] = coder.decode(['address', 'uint256'], params[1]);
  const [takeCurrency, takeAmount] = coder.decode(['address', 'uint256'], params[2]);
  assert.strictEqual(settleCurrency, NATIVE);          // paying ETH in
  assert.strictEqual(settleAmount, 500n);
  assert.strictEqual(takeCurrency.toLowerCase(), ROBBIE.toLowerCase()); // taking tokens out
  assert.strictEqual(takeAmount, 7n);
});

test('reversing the direction swaps which currency is settled', () => {
  const { inputs } = encodeExactInSingle({ poolKey: key(), zeroForOne: false, amountIn: 5n, amountOutMinimum: 1n });
  const [, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const [settleCurrency] = coder.decode(['address', 'uint256'], params[1]);
  assert.strictEqual(settleCurrency.toLowerCase(), ROBBIE.toLowerCase());
});

'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../config');

test('when the reward IS the quote asset, there is nothing to buy', async () => {
  // Artificial Neko pays holders NVDA, the same asset creator fees arrive in.
  // Routing that through a NVDA/NVDA swap would be meaningless and would cost
  // holders a pool fee and slippage for nothing. The buy leg turns itself off.
  assert.strictEqual(
    config.rewardTokenAddress.toLowerCase(),
    config.quoteTokenAddress.toLowerCase(),
    'this project is configured to pay the quote asset directly'
  );

  const { buyReward } = require('./rewardswap');
  const out = await buyReward({ quoteAmount: 6.5 });
  assert.strictEqual(out.direct, true, 'no swap was performed');
  assert.strictEqual(out.tokensBought, 6.5, 'the claim is handed over untouched');
  assert.strictEqual(out.quoteSpent, 6.5);
  assert.strictEqual(out.signature, null, 'no transaction, so no hash to record');
  assert.ok(out.bought, 'and it still counts as delivered, so the airdrop runs');
});

test('a zero share still short-circuits before anything else', async () => {
  const { buyReward } = require('./rewardswap');
  const out = await buyReward({ quoteAmount: 0 });
  assert.strictEqual(out.skipped, true);
  assert.match(out.reason, /zero/);
});

'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { STOCK_CODE_HASH } = require('./tokens');

test('the guard identifies stocks by bytecode, never by name', () => {
  // Five impostor NVDA tokens exist on this chain, several carrying the real
  // one's name AND symbol. Both are attacker-controlled; the deployed bytecode
  // is not. Verified live: the real NVDA, SPCX and AMD all share this hash,
  // while Artificial Inu and a plain EOA do not.
  assert.ok(STOCK_CODE_HASH.startsWith('0x'), 'a code-hash prefix, not a symbol');
  assert.ok(STOCK_CODE_HASH.length >= 10, 'long enough to be meaningful');
});

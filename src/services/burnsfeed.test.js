'use strict';

process.env.DRY_RUN = 'true';
process.env.TOKEN_ADDRESS = '0xA75262B1c9cD4CeB50BB944C5209f42f649eBCa8';

const test = require('node:test');
const assert = require('node:assert');
const { toRow } = require('./burnsfeed');

test('a burn row announces the tokens destroyed, and links to the proof', () => {
  const row = toRow(
    {
      id: 41,
      signature: '0x264e64394e1b8c1d94a907be88ac439db73a04aa9c0600d1d6966645fb27f9b0',
      at: '2026-08-31T05:28:50.000Z',
      detail: { burned: true, tokensBought: 874649.0691003794, quoteSpent: 0.204239857 },
    },
    'https://rh-scan.com/tx/'
  );
  assert.strictEqual(row.type, 'burn');
  assert.strictEqual(row.amount, 874649.0691003794, 'the memecoin destroyed, not the NVDA spent');
  assert.strictEqual(row.quoteSpent, 0.204239857);
  assert.strictEqual(
    row.txUrl,
    'https://rh-scan.com/tx/0x264e64394e1b8c1d94a907be88ac439db73a04aa9c0600d1d6966645fb27f9b0',
    'a burn nobody can verify is just a claim'
  );
  assert.strictEqual(row.timestamp, '2026-08-31T05:28:50.000Z');
});

test('a row with no signature offers no link rather than a broken one', () => {
  const row = toRow({ id: 1, signature: null, detail: { tokensBought: 5 } });
  assert.strictEqual(row.txHash, null);
  assert.strictEqual(row.txUrl, null);
});

test('mapping a page keeps every row intact', () => {
  // Array.map hands its callback (element, index, array); passing toRow directly
  // would feed the index into explorerTxBase and mangle every URL but the first.
  const rows = [1, 2, 3].map((n) => ({
    id: n,
    signature: `0x${String(n).repeat(64)}`,
    at: '2026-08-31T00:00:00.000Z',
    detail: { tokensBought: n * 100, quoteSpent: n },
  }));
  const out = rows.map((r) => toRow(r, 'https://rh-scan.com/tx/'));
  assert.strictEqual(out.length, 3);
  for (const r of out) {
    assert.ok(r.txUrl.startsWith('https://rh-scan.com/tx/0x'), `bad url: ${r.txUrl}`);
    assert.ok(r.amount > 0);
  }
});

test('a burn row names both tickers', () => {
  // quoteSymbol came back null on the live feed: config.quoteSymbol was
  // referenced in four places but never defined, and everywhere else hid it
  // behind a `|| 'NVDA'` fallback.
  const config = require('../config');
  assert.strictEqual(config.quoteSymbol, 'NVDA');
  const row = toRow({ id: 1, signature: '0x' + 'a'.repeat(64), detail: { tokensBought: 5, quoteSpent: 1 } });
  assert.strictEqual(row.symbol, 'NEKO', 'what was destroyed');
  assert.strictEqual(row.quoteSymbol, 'NVDA', 'what paid for it');
});

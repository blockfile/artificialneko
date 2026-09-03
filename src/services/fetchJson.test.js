'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fetchJson, USER_AGENT } = require('./fetchJson');

const okResponse = (data) => ({ ok: true, json: async () => data });

test('passes method and body through to fetch (for JSON-RPC POSTs)', async () => {
  let seen;
  const fetchFn = async (url, init) => {
    seen = { url, init };
    return okResponse({ result: '0x1' });
  };
  const out = await fetchJson('https://rpc.example', {
    method: 'POST',
    body: '{"jsonrpc":"2.0"}',
    headers: { 'content-type': 'application/json' },
    fetchFn,
  });
  assert.deepStrictEqual(out, { result: '0x1' });
  assert.strictEqual(seen.init.method, 'POST');
  assert.strictEqual(seen.init.body, '{"jsonrpc":"2.0"}');
  assert.strictEqual(seen.init.headers['content-type'], 'application/json');
});

test('a plain GET still works with no method/body given', async () => {
  const fetchFn = async () => okResponse({ ok: 1 });
  assert.deepStrictEqual(await fetchJson('https://x', { fetchFn }), { ok: 1 });
});

test('always sends a User-Agent — Cloudflare 403-challenges Node\'s bare fetch', async () => {
  let seen;
  const fetchFn = async (url, init) => {
    seen = init;
    return okResponse({});
  };
  await fetchJson('https://x', { fetchFn, headers: { accept: 'application/json' } });
  assert.strictEqual(seen.headers['user-agent'], USER_AGENT);
  // The self-identifying crawler form — a bare "<name>/<version>" gets challenged too.
  assert.match(USER_AGENT, /^Mozilla\/5\.0 \(compatible; [a-z]+-api\/\d+\.\d+\.\d+(; \+https:\/\/[^)]+)?\)$/);
  assert.strictEqual(seen.headers.accept, 'application/json'); // caller headers kept
});

test('a caller-supplied User-Agent wins over the default', async () => {
  let seen;
  const fetchFn = async (url, init) => {
    seen = init;
    return okResponse({});
  };
  await fetchJson('https://x', { fetchFn, headers: { 'user-agent': 'custom/1' } });
  assert.strictEqual(seen.headers['user-agent'], 'custom/1');
});

test('retries a transient failure and then succeeds', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503 };
    return okResponse({ ok: 1 });
  };
  const out = await fetchJson('https://x', { fetchFn, sleepFn: async () => {} });
  assert.deepStrictEqual(out, { ok: 1 });
  assert.strictEqual(calls, 2);
});

test('does not retry a non-retryable status (404, or a Cloudflare 403 challenge)', async () => {
  for (const status of [404, 403]) {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: false, status };
    };
    await assert.rejects(fetchJson('https://x', { fetchFn, sleepFn: async () => {} }), new RegExp(`HTTP ${status}`));
    assert.strictEqual(calls, 1);
  }
});

test('a hung upstream is abandoned rather than waited on forever', async () => {
  // Node's fetch has no default timeout, so a socket that opens and goes quiet
  // hangs until the OS gives up. With retries that stacked into four unbounded
  // waits and /stats sat there until the browser timed out.
  let signals = [];
  const hung = (_url, opts) => {
    signals.push(opts.signal);
    return new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => rej(opts.signal.reason));
    });
  };
  await assert.rejects(
    fetchJson('https://example.test/x', { fetchFn: hung, retries: 1, delayMs: 0, timeoutMs: 20 })
  );
  assert.strictEqual(signals.length, 2, 'timed out, then retried once');
  assert.ok(signals.every((s) => s && typeof s.aborted === 'boolean'), 'every attempt carried a timeout signal');
});

test('a timeout can be switched off for callers that manage their own', async () => {
  const seen = [];
  const ok = (_url, opts) => { seen.push(opts.signal); return { ok: true, json: async () => ({ fine: true }) }; };
  assert.deepStrictEqual(await fetchJson('https://example.test/x', { fetchFn: ok, timeoutMs: 0 }), { fine: true });
  assert.strictEqual(seen[0], undefined, 'no signal attached when disabled');
});

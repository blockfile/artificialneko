'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cached, cachedByKey } = require('./cache');

test('serves from cache within the TTL', async () => {
  let calls = 0;
  const get = cached(10_000, async () => ++calls);
  assert.strictEqual(await get(), 1);
  assert.strictEqual(await get(), 1);
  assert.strictEqual(calls, 1);
});

test('a stale read is served immediately and refreshed behind the caller', async () => {
  // The refresh must not block the reader. Waiting for it is what made /stats
  // hang: the cache went cold every TTL, and whoever arrived in that window
  // paid the upstream's full latency, retries included, while a perfectly good
  // value sat in memory. Staleness is cheap here; a hung request is not.
  let calls = 0;
  const get = cached(0, async () => ++calls);

  assert.strictEqual(await get(), 1, 'cold: nothing to serve but the upstream');
  assert.strictEqual(await get(), 1, 'stale: the old value, not a wait for the new one');
  await new Promise((r) => setTimeout(r, 0)); // let the background refresh land
  assert.strictEqual(await get(), 2, 'the refresh did happen');
});

test('concurrent callers share one in-flight request', async () => {
  let calls = 0;
  const get = cached(10_000, async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return calls;
  });
  const [a, b, c] = await Promise.all([get(), get(), get()]);
  assert.deepStrictEqual([a, b, c], [1, 1, 1]);
  assert.strictEqual(calls, 1);
});

test('a failed refresh keeps serving the last good value', async () => {
  let mode = 'ok';
  const get = cached(0, async () => {
    if (mode === 'boom') throw new Error('upstream down');
    return 'good';
  });
  assert.strictEqual(await get(), 'good');
  mode = 'boom';
  assert.strictEqual(await get(), 'good'); // not an error, not null
});

test('with no value ever cached, a failure propagates', async () => {
  const get = cached(1000, async () => {
    throw new Error('upstream down');
  });
  await assert.rejects(get(), /upstream down/);
});

// ── cachedByKey: one stale-while-error cache per key (feed pages) ────────────

test('cachedByKey: each key is its own cache, fed the caller\'s args', async () => {
  const calls = [];
  const get = cachedByKey(10_000, async (cursor, limit) => {
    calls.push([cursor, limit]);
    return `${cursor}/${limit}`;
  });
  assert.strictEqual(await get('a|12', 'a', 12), 'a/12');
  assert.strictEqual(await get('b|12', 'b', 12), 'b/12');
  assert.strictEqual(await get('a|12', 'a', 12), 'a/12'); // cached — no new call
  assert.deepStrictEqual(calls, [['a', 12], ['b', 12]]);
});

test('cachedByKey: a key with a good value survives a failed refresh', async () => {
  let mode = 'ok';
  const get = cachedByKey(0, async () => {
    if (mode === 'boom') throw new Error('upstream down');
    return 'good';
  });
  assert.strictEqual(await get('k'), 'good');
  mode = 'boom';
  assert.strictEqual(await get('k'), 'good');
  await assert.rejects(get('never-loaded'), /upstream down/);
});

test('cachedByKey: evicts the oldest key once past max', async () => {
  let calls = 0;
  const get = cachedByKey(10_000, async () => ++calls, { max: 2 });
  await get('a'); // calls=1
  await get('b'); // calls=2
  await get('c'); // calls=3 — evicts 'a'
  assert.strictEqual(await get('b'), 2); // still cached
  assert.strictEqual(await get('a'), 4); // evicted — refetched
  assert.strictEqual(calls, 4);
});

test('a cold failure is remembered, so every caller does not re-pay for it', async () => {
  // A dead upstream used to be rediscovered on every single request, and each
  // rediscovery cost the full retry budget. That is how a pons endpoint
  // answering 502 put 4-10 seconds on every /stats call.
  let calls = 0;
  const get = cached(60_000, async () => { calls += 1; throw new Error('upstream down'); });

  await assert.rejects(get(), /upstream down/);
  await assert.rejects(get(), /upstream down/);
  await assert.rejects(get(), /upstream down/);
  assert.strictEqual(calls, 1, 'the upstream was asked once, not once per caller');
});

test('the remembered failure expires, so recovery is noticed', async () => {
  let calls = 0;
  let broken = true;
  const get = cached(60_000, async () => { calls += 1; if (broken) throw new Error('down'); return 'back'; }, { errorTtlMs: 5 });

  await assert.rejects(get(), /down/);
  await assert.rejects(get(), /down/);
  assert.strictEqual(calls, 1);

  await new Promise((r) => setTimeout(r, 10));
  broken = false;
  assert.strictEqual(await get(), 'back', 'retries once the failure window lapses');
});

test('a failure never overwrites a value that already worked', async () => {
  let ok = true;
  const get = cached(0, async () => { if (!ok) throw new Error('down'); return 'good'; });
  assert.strictEqual(await get(), 'good');
  ok = false;
  assert.strictEqual(await get(), 'good', 'stale, but still the last good value');
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(await get(), 'good', 'a failed refresh must not blank the panel');
});

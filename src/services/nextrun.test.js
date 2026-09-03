'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { secondsUntilNext } = require('./nextrun');

// Local time throughout, because that is what node-cron schedules against —
// the deploy sets the box to UTC, so the two agree there.
const at = (h, m, s = 0) => new Date(2026, 8, 4, h, m, s);

test('hourly: counts down to the top of the next hour', () => {
  assert.strictEqual(secondsUntilNext('0 * * * *', at(13, 20)), 40 * 60);
});

test('a schedule that just fired waits a whole interval, never returns 0', () => {
  // At exactly 14:00:00 the fire has happened. Reporting 0 would leave the
  // site's countdown pinned at zero for a minute, re-fetching every tick.
  assert.strictEqual(secondsUntilNext('0 * * * *', at(14, 0)), 60 * 60);
});

test('seconds inside the current minute are counted', () => {
  assert.strictEqual(secondsUntilNext('0 * * * *', at(13, 20, 30)), 40 * 60 - 30);
});

test('every 30 minutes lands on the half hour', () => {
  assert.strictEqual(secondsUntilNext('*/30 * * * *', at(13, 20)), 10 * 60);
  assert.strictEqual(secondsUntilNext('*/30 * * * *', at(13, 40)), 20 * 60);
});

test('every 20 minutes lands on :00, :20 and :40', () => {
  assert.strictEqual(secondsUntilNext('*/20 * * * *', at(13, 5)), 15 * 60);
  assert.strictEqual(secondsUntilNext('*/20 * * * *', at(13, 45)), 15 * 60);
});

test('a step that does not divide 60 restarts each hour, and the count says so', () => {
  // */45 fires at :00 and :45 and then jumps back to :00 — a 45-minute gap
  // followed by a 15-minute one. The countdown must reflect the real gap, not
  // a tidy 45 minutes.
  assert.strictEqual(secondsUntilNext('*/45 * * * *', at(13, 50)), 10 * 60);
});

test('a list of minutes picks the nearest one ahead', () => {
  assert.strictEqual(secondsUntilNext('0,15,30,45 * * * *', at(13, 20)), 10 * 60);
});

test('a day-of-week restriction is honoured rather than firing daily', () => {
  // 2026-09-04 is a Friday. A Monday-only schedule is 3 days out.
  const out = secondsUntilNext('0 0 * * 1', at(0, 0));
  assert.strictEqual(out, 3 * 24 * 60 * 60);
});

test('nonsense is null, never a guess', () => {
  // A countdown is decoration. Inventing one for a schedule we cannot read
  // would show the site a clock that is confidently wrong.
  for (const bad of ['', 'hourly please', '0 * * *', '0 * * * * *', null, undefined, '99 * * * *']) {
    assert.strictEqual(secondsUntilNext(bad, at(13, 20)), null, `expected null for ${bad}`);
  }
});

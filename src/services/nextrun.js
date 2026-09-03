'use strict';

// How long until a cron schedule next fires.
//
// Exists so the site can show "next check in 23:14" beside the fee gauge. The
// backend is the only side that knows TRIGGER_SCHEDULE, so it is the only side
// that can answer.
//
// Deliberately NOT a dependency. `node-cron` validates an expression but will
// not tell you when it next runs, and pulling a parser into a bot that moves
// money to compute a countdown is a poor trade. This handles the standard
// five-field syntax and returns null on anything it cannot read — the frontend
// treats a missing countdown as "no clock", which is honest, where a guessed
// one would be confidently wrong.
//
// Local time throughout, matching node-cron, which schedules against local
// time. The deploy sets the box to UTC so the two agree.

// A schedule that fires less often than weekly is not something this bot has,
// and scanning further to find out costs more than the answer is worth.
const SCAN_LIMIT_MINUTES = 8 * 24 * 60;

/**
 * Pure: one cron field -> the set of values it matches, or null if unreadable.
 *
 * Handles `*`, `a`, `a-b`, `a,b,c` and a `/step` on any of those. A bare
 * `a/step` counts from `a` up to the field maximum, which is what cron means by
 * it — `5/10` in minutes is 5, 15, 25, …
 */
function expand(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    if (part === '') return null;
    const slash = part.indexOf('/');
    const range = slash === -1 ? part : part.slice(0, slash);
    const step = slash === -1 ? 1 : Number(part.slice(slash + 1));
    if (!Number.isInteger(step) || step < 1) return null;

    let lo;
    let hi;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      // `a/step` counts from a to the top of the field; a bare `a` is just a.
      hi = slash === -1 ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/**
 * Seconds from `now` until `expr` next fires, or null if it cannot be read.
 *
 * Never returns 0: a schedule sitting exactly on its fire time has just fired,
 * and the next one is a whole interval away. Returning 0 would pin the site's
 * countdown at zero and make it re-fetch on every tick for a minute.
 *
 * @param {string} expr five-field cron expression
 * @param {Date} [now]
 * @returns {number|null}
 */
function secondsUntilNext(expr, now = new Date()) {
  const fields = String(expr == null ? '' : expr).trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = expand(fields[0], 0, 59);
  const hours = expand(fields[1], 0, 23);
  const daysOfMonth = expand(fields[2], 1, 31);
  const months = expand(fields[3], 1, 12);
  const daysOfWeek = expand(fields[4], 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
  if (daysOfWeek.has(7)) daysOfWeek.add(0); // cron allows 7 for Sunday

  // Standard cron day semantics: when BOTH day fields are restricted they are
  // ORed, not ANDed. Treating them as an AND makes "the 1st or any Monday"
  // fire only on Mondays that fall on the 1st.
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';

  const t = new Date(now.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1); // the current minute has already fired

  for (let i = 0; i < SCAN_LIMIT_MINUTES; i += 1) {
    const dayOk =
      domRestricted && dowRestricted
        ? daysOfMonth.has(t.getDate()) || daysOfWeek.has(t.getDay())
        : domRestricted
          ? daysOfMonth.has(t.getDate())
          : dowRestricted
            ? daysOfWeek.has(t.getDay())
            : true;

    if (dayOk && minutes.has(t.getMinutes()) && hours.has(t.getHours()) && months.has(t.getMonth() + 1)) {
      return Math.round((t.getTime() - now.getTime()) / 1000);
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

module.exports = { secondsUntilNext, expand };

'use strict';

// Number -> base-units conversion that survives small amounts.
//
// Amounts flow through this project as JS Numbers, and `String(n)` switches to
// exponential notation below 1e-6 ("5.6e-7"), which `parseUnits` rejects
// outright with "invalid FixedNumber string value". A reward share that small
// is perfectly ordinary here — it is the holder split of one modest claim — so
// the conversion has to survive it rather than throwing mid-cycle, after the
// escrow has already been emptied.

/**
 * Expand a Number to a PLAIN decimal string — never exponential notation.
 *
 * `String(n)` (not `toFixed`) is the source of the digits on purpose: it is the
 * shortest round-trip representation, so 21.368470124 converts to exactly
 * 21368470124000000000 base units. `(21.368470124).toFixed(18)` would instead
 * expose the binary-float tail as "21.368470124000001675" and mint 1675 base
 * units the caller never had.
 *
 * @param {number} n
 * @returns {string}
 */
function toPlainDecimalString(n) {
  const s = String(n);
  if (!/e/i.test(s)) return s;

  const [mantissa, expPart] = s.split(/e/i);
  const exp = Number(expPart);
  const negative = mantissa.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? mantissa.slice(1) : mantissa).split('.');
  const digits = intPart + fracPart;
  const pointAt = intPart.length + exp; // where the decimal point lands in `digits`

  let out;
  if (pointAt <= 0) out = `0.${'0'.repeat(-pointAt)}${digits}`;
  else if (pointAt >= digits.length) out = digits + '0'.repeat(pointAt - digits.length);
  else out = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;

  return (negative ? '-' : '') + out;
}

/**
 * Truncate a decimal string to `decimals` places. Truncated, never rounded up,
 * so a conversion can never produce more than the caller actually holds.
 *
 * @param {string} decimal
 * @param {number} decimals
 * @returns {string}
 */
function truncateDecimals(decimal, decimals) {
  const dot = decimal.indexOf('.');
  if (dot < 0 || decimal.length - dot - 1 <= decimals) return decimal;
  return decimal.slice(0, dot + 1 + decimals);
}

/** Both steps together: a Number to a string `parseUnits(_, decimals)` accepts. */
function toUnitString(n, decimals) {
  const value = Number(n);
  if (!Number.isFinite(value)) throw new Error(`toUnitString: not a finite amount: ${n}`);
  if (value < 0) throw new Error(`toUnitString: negative amount: ${n}`);
  return truncateDecimals(toPlainDecimalString(value), decimals);
}

module.exports = { toPlainDecimalString, truncateDecimals, toUnitString };

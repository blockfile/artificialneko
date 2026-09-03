'use strict';

// Fetch JSON with retry on transient upstream failures.
//
// Blockscout sits behind Cloudflare and intermittently returns 520/5xx/429, and
// DexScreener rate-limits. A single blip must not blank the site's stats panel,
// so those statuses are retried with backoff; genuinely non-retryable responses
// (e.g. 404 for an unlisted token) and network errors past the retry budget throw.
//
// Every request carries a User-Agent in the standard self-identifying crawler
// form, "Mozilla/5.0 (compatible; <name>/<version>; +<homepage>)". Cloudflare
// in front of Blockscout answers requests without a UA — and, since
// 2026-08-29, a bare "<name>/<version>" UA — with a 403 JavaScript challenge
// ("Just a moment…", `cf-mitigated: challenge`); the compatible form passes
// consistently and still says who we are. A 403 is deliberately NOT retried:
// it is a policy answer, not a blip — check `cf-mitigated` before suspecting
// the code. USER_AGENT in the environment overrides the default.

const pkg = require('../../package.json');

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

// Node's fetch has NO default timeout, so a socket that opens and then goes
// quiet hangs until the OS gives up - minutes, not seconds. With retries on top
// that stacked into four unbounded waits, and /stats sat there until the
// browser gave up. A slow upstream has to look like a failed one.
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 6000;
const USER_AGENT =
  process.env.USER_AGENT ||
  `Mozilla/5.0 (compatible; ${pkg.name}/${pkg.version}${pkg.homepage ? `; +${pkg.homepage}` : ''})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET `url` and parse JSON, retrying transient failures.
 * @param {string} url
 * @param {{headers?: object, method?: string, body?: string, retries?: number, delayMs?: number,
 *          sleepFn?: (ms:number)=>Promise<void>, fetchFn?: typeof fetch,
 *          timeoutMs?: number}} [opts]
 */
async function fetchJson(url, { headers, method, body, retries = 3, delayMs = 1000, sleepFn = sleep, fetchFn = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const allHeaders = { 'user-agent': USER_AGENT, ...headers };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      // A timeout aborts into the catch below, so it retries like any other
      // network error rather than failing the whole call outright.
      res = await fetchFn(url, {
        headers: allHeaders,
        method,
        body,
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch (err) {
      lastErr = err; // network / DNS / socket error — retryable
      if (attempt === retries) throw err;
      await sleepFn(delayMs);
      continue;
    }

    if (res.ok) return res.json();

    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === retries) throw err;
    lastErr = err;
    await sleepFn(delayMs);
  }
  throw lastErr; // unreachable (loop returns or throws), kept for clarity
}

module.exports = { fetchJson, RETRYABLE_STATUS, USER_AGENT, TIMEOUT_MS };

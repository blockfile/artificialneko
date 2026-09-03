'use strict';

const express = require('express');
const cors = require('cors');

const config = require('./src/config');
const db = require('./src/db');
const { router: statsRouter } = require('./src/routes/stats');
const { router: rewardsRouter } = require('./src/routes/rewards');
const { router: burnsRouter } = require('./src/routes/burns');
const { router: tokenRouter } = require('./src/routes/token');
const { router: distributionRouter } = require('./src/routes/distribution');

const app = express();
app.disable('x-powered-by');

// These responses exist to change — a gauge filling toward its threshold, a
// feed of payouts, a market cap. Express sends an ETag and no Cache-Control by
// default, which lets a browser serve a cached copy without revalidating: the
// site's tank then sits frozen at whatever it first fetched while the API is
// happily reporting fresh numbers. Answering "no-store" is not a load concern,
// because every upstream already sits behind a TTL cache in-process.
app.disable('etag');
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
// Behind nginx — trust its X-Forwarded-* headers so req.ip is the real client.
app.set('trust proxy', 1);

// CORS allowlist — non-browser requests (no Origin) always pass; browsers are
// restricted to config.corsOrigins (or any origin if it contains "*").
const allowAll = config.corsOrigins.includes('*');
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowAll || config.corsOrigins.includes(origin)) return cb(null, true);
      const err = new Error(`origin ${origin} not allowed by CORS`);
      err.corsRejected = true; // handled quietly below — copycat sites spam this
      return cb(err);
    },
  })
);

app.get('/', (req, res) => {
  res.json({
    name: 'artificialneko-api',
    description: 'NEKO market cap, holder count, total NVDA rewarded and the live rewards feed for the Artificial Neko site',
    token: { symbol: config.tokenSymbol, address: config.tokenAddress },
    endpoints: [
      'GET /token',
      'GET /stats',
      'GET /rewards?cursor&limit',
      'GET /rewards/meter',
      'GET /burns?cursor&limit',
      'GET /distribution',
      'GET /health',
    ],
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
});

// Mounted twice so the site works whether VITE_API_BASE_URL is set to
// https://api.<site> or https://api.<site>/api.
for (const base of ['/', '/api']) {
  app.use(base, tokenRouter);
  app.use(base, statsRouter);
  app.use(base, rewardsRouter);
  app.use(base, burnsRouter);
  app.use(base, distributionRouter);
}

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Disallowed origins (copycat sites embedding this API) get a terse 403 and at
// most ONE log line per origin — not a stack trace per request.
const loggedBlockedOrigins = new Set();

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.corsRejected) {
    const origin = req.get('origin') || 'unknown';
    if (!loggedBlockedOrigins.has(origin)) {
      loggedBlockedOrigins.add(origin);
      console.warn(`[artificialneko] blocking CORS origin: ${origin}`);
    }
    return res.status(403).json({ error: 'origin not allowed' });
  }
  console.error('[artificialneko] request error:', err);
  res.status(500).json({ error: err.message });
});

let server;

// The rewards total and the payout feed come from the bot's ledger, so this
// process needs MongoDB — read-only. It deliberately does NOT load the wallet
// key or start the scheduler: that is bot.js's job, and keeping them apart
// means a compromise of this internet-facing service reaches no signing key.
async function main() {
  await db.connect();
  console.log(`[artificialneko] MongoDB connected (${config.mongoDb})`);

  server = app.listen(config.port, () => {
    console.log(`[artificialneko] listening on http://localhost:${config.port}`);
    console.log(
      `[artificialneko] token=${config.tokenSymbol} address=${config.tokenAddress || '(not set — stats will be null)'}`
    );
    console.log(`[artificialneko] cors=${config.corsOrigins.join(', ')}`);
  });
}

if (require.main === module) {
  const shutdown = async (signal) => {
    console.log(`\n[artificialneko] ${signal} received, shutting down`);
    if (server) server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  main().catch((err) => {
    console.error('[artificialneko] failed to start:', err);
    process.exit(1);
  });
}

module.exports = app;

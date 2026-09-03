// PM2 process file — starts both processes with one command:
//
//   pm2 start ecosystem.config.js
//
// `cwd` is deliberately omitted: PM2 resolves scripts relative to this file, so
// the same config works in /var/www/artificialneko and on a laptop.
//
// exec_mode is fork, NOT cluster, and instances is 1, for both. Cluster mode
// would give the API workers separate in-memory caches for no gain, and would
// run several schedulers against one wallet — each building transactions from
// the same nonce.
module.exports = {
  apps: [
    {
      name: 'artificialneko-api',
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      time: true,
      autorestart: true,
      max_memory_restart: '400M',
      // A crash loop is almost always a bad .env or an unreachable database;
      // backing off stops it filling the disk with the same error.
      restart_delay: 5000,
      max_restarts: 10,
    },
    {
      name: 'artificialneko-bot',
      script: 'bot.js',
      exec_mode: 'fork',
      instances: 1,
      time: true,
      autorestart: true,
      max_memory_restart: '400M',
      restart_delay: 5000,
      max_restarts: 10,
    },
  ],
};

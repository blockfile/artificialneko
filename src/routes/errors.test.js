'use strict';

// The public API's 500 handler must not hand internal detail to a stranger.
//
// GET /distribution with no MongoDB connection is the real path: getDb() throws
// "MongoDB not connected — call connect() first", the route calls next(err), and
// the handler used to answer with err.message verbatim. On a live box that
// message can carry the Atlas cluster hostname — infrastructure a caller has no
// business learning from an error.

process.env.DRY_RUN = 'true';
process.env.CORS_ORIGINS = '*';

const test = require('node:test');
const assert = require('node:assert');
const app = require('../../server');

async function get(path) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

test('a 500 says something went wrong, not what', async () => {
  const { status, body } = await get('/distribution');
  assert.strictEqual(status, 500);
  assert.doesNotMatch(body, /mongo/i, 'the database must not be named in the response');
  assert.doesNotMatch(body, /connect\(\)/, 'nor any internal call');
  assert.match(body, /error/i, 'but it is still a JSON error the site can render');
});

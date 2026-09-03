'use strict';

const { MongoClient } = require('mongodb');
const config = require('../config');

let client = null;
let db = null;

/** Connect once and create indexes. Safe to call repeatedly (idempotent). */
async function connect() {
  if (db) return db;
  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db(config.mongoDb);

  await Promise.all([
    db.collection('cycles').createIndex({ id: 1 }, { unique: true }),
    db.collection('steps').createIndex({ id: 1 }, { unique: true }),
    db.collection('steps').createIndex({ cycle_id: 1 }),
    // The public feed pages by descending id, and the rewarded total filters
    // by (reward_token, status) — both are served on every visitor poll.
    db.collection('airdrops').createIndex({ id: -1 }),
    db.collection('airdrops').createIndex({ reward_token: 1, status: 1 }),
  ]);

  return db;
}

function getDb() {
  if (!db) throw new Error('MongoDB not connected — call connect() first');
  return db;
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = { connect, getDb, close };

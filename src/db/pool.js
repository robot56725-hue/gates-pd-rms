'use strict';

const { Pool } = require('pg');
const env = require('../config/env');

/**
 * Single shared connection pool for the process. Routes never call
 * pool.query() directly for anything that needs RLS/audit context (see
 * middleware/dbAudit.js) -- they use the per-request client that middleware
 * attaches to req.db, so every business-logic query runs inside the
 * transaction that has `app.actor_role` set.
 */
const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.pgPoolMax,
  idleTimeoutMillis: env.pgPoolIdleTimeoutMs,
  // In production, terminate a query that hangs rather than exhausting the
  // pool one connection at a time.
  statement_timeout: env.isProduction ? 15000 : 0,
});

pool.on('error', (err) => {
  // Errors on idle clients (e.g. the DB restarting) must not crash the
  // process -- log and let the pool recycle the connection.
  // eslint-disable-next-line no-console
  console.error('Unexpected error on idle PostgreSQL client', err);
});

module.exports = pool;

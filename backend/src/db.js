'use strict';

const { Pool } = require('pg');
const logger = require('./logger');

// In production use the default NODE_EXTRA_CA_CERTS or DATABASE_SSL_CA env var.
// Disable SSL entirely only in local dev (no DATABASE_URL SSL requirement).
const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: true }        // enforce certificate validation
  : (process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : false);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  max: 20,                   // max pool size
  idleTimeoutMillis: 30000,  // close idle clients after 30 s
  connectionTimeoutMillis: 5000,
});

// Log pool errors to avoid unhandled-rejection crashes
pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message, stack: err.stack });
});

/**
 * Execute a parameterised SQL query.
 *
 * @param {string} text   - SQL string with $1, $2 … placeholders
 * @param {Array}  params - Bound parameter values
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;

  if (duration > 500) {
    logger.warn('Slow query detected', { duration, query: text });
  } else {
    logger.debug('DB query executed', { duration, rows: res.rowCount });
  }

  return res;
}

/**
 * Check out a raw client for multi-statement transactions.
 * Remember to call client.release() in a finally block.
 *
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

module.exports = { query, getClient, pool };

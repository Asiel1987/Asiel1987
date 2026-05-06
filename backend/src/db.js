'use strict';

const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    // Supabase requires SSL; rejectUnauthorized:false works with their self-signed cert.
    // For stricter setups supply the CA via ssl.ca option.
    rejectUnauthorized: false,
  },
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

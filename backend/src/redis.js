'use strict';

const Redis = require('ioredis');
const logger = require('./logger');

const client = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

client.on('connect', () => {
  logger.info('Redis client connected');
});

client.on('ready', () => {
  logger.info('Redis client ready');
});

client.on('error', (err) => {
  logger.error('Redis client error', { error: err.message });
});

client.on('close', () => {
  logger.warn('Redis connection closed');
});

client.on('reconnecting', () => {
  logger.warn('Redis reconnecting…');
});

module.exports = client;

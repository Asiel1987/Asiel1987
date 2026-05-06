'use strict';

const { createLogger, format, transports } = require('winston');

const { combine, timestamp, json, errors, colorize, simple } = format;

const isDev = process.env.NODE_ENV !== 'production';

const logger = createLogger({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  format: combine(
    errors({ stack: true }),           // include stack traces on Error objects
    timestamp({ format: 'ISO' }),      // ISO-8601 timestamp
    json()                             // structured JSON output
  ),
  defaultMeta: { service: 'asiel-farm-shop-api' },
  transports: [
    new transports.Console({
      format: isDev
        ? combine(colorize(), simple())  // human-readable in dev
        : combine(errors({ stack: true }), timestamp({ format: 'ISO' }), json()),
    }),
  ],
  exitOnError: false,
});

module.exports = logger;

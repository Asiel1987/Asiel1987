'use strict';

const express = require('express');

/**
 * Mount a router on a minimal Express app with a fake injected session.
 * Avoids needing a real Redis session store in unit tests.
 */
function makeApp(router, sessionData = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.session = sessionData;
    next();
  });
  app.use('/', router);
  // Minimal error handler so Joi 400s and explicit status errors reach the test
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || (err.isJoi || err.name === 'ValidationError' ? 400 : 500);
    res.status(status).json({ error: err.message });
  });
  return app;
}

/**
 * Build a mock transaction client returned by db.getClient().
 * queryResults is an array of return values for each sequential client.query() call.
 */
function makeMockClient(queryResults = []) {
  let callIndex = 0;
  const client = {
    query: jest.fn(() => {
      const result = queryResults[callIndex] ?? { rows: [], rowCount: 0 };
      callIndex++;
      return Promise.resolve(result);
    }),
    release: jest.fn(),
  };
  return client;
}

module.exports = { makeApp, makeMockClient };

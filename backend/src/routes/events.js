'use strict';

/**
 * Server-Sent Events (SSE) — real-time event stream
 *
 * Clients connect to GET /api/events and receive a persistent HTTP stream.
 *
 * In production this handler subscribes to a Redis pub/sub channel
 * (events:{userId}) and forwards messages as SSE events. The current
 * implementation keeps an in-process Map of active connections so that
 * other route handlers can call broadcast() to push events to specific users.
 *
 * For a multi-process / multi-server deployment, replace the in-process
 * broadcast() with a Redis pub/sub subscriber per connection.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();

// Active SSE clients: Map<userId, Set<res>>
// Each user may have multiple browser tabs open simultaneously.
const clients = new Map();

/**
 * Broadcast a typed event to ALL active connections for a given userId.
 * Exported so other route handlers can push real-time events to a user.
 *
 * @param {string} userId  - Target user's UUID
 * @param {string} type    - Event type e.g. 'order:updated', 'payment:completed'
 * @param {object} payload - Event data
 */
function broadcast(userId, type, payload = {}) {
  const conns = clients.get(String(userId));
  if (!conns || conns.size === 0) return;

  const frame = `data: ${JSON.stringify({ type, payload, ts: Date.now() })}\n\n`;

  conns.forEach((res) => {
    try {
      res.write(frame);
    } catch {
      // Client socket closed — will be cleaned up on the 'close' event
    }
  });
}

// Export broadcast so other modules can push events
module.exports.broadcast = broadcast;

/**
 * GET /api/events
 * Opens an SSE stream for the authenticated user.
 * Sends a keep-alive ping every 30 seconds.
 *
 * NOTE: In production, subscribe to Redis pub/sub channel `events:{userId}`
 * here and forward messages as SSE frames. On disconnect, unsubscribe and
 * quit the dedicated subscriber connection.
 */
router.get('/', requireAuth, (req, res) => {
  // ── SSE response headers ──────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering

  // Flush headers immediately so the browser opens the stream
  res.flushHeaders();

  const userId = String(req.session.userId);

  // Register this connection
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);

  logger.info('SSE client connected', {
    userId,
    openConnections: clients.get(userId).size,
  });

  // ── Initial connected event ───────────────────────────────────────────────
  res.write(
    `data: ${JSON.stringify({
      type: 'connected',
      payload: { userId, message: 'Asiel Farm Shop event stream connected' },
      ts: Date.now(),
    })}\n\n`
  );

  // ── Keep-alive ping every 30 s ────────────────────────────────────────────
  const timer = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'ping', ts: Date.now() })}\n\n`);
    } catch {
      clearInterval(timer);
    }
  }, 30_000);

  // ── Cleanup on client disconnect ──────────────────────────────────────────
  req.on('close', () => {
    clearInterval(timer);
    clients.get(userId)?.delete(res);
    if (clients.get(userId)?.size === 0) clients.delete(userId);
    logger.info('SSE client disconnected', { userId });
  });
});

module.exports.router = router;

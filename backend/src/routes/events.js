'use strict';

/**
 * Server-Sent Events (SSE) — real-time event stream
 *
 * Uses Redis pub/sub so all backend instances participate in broadcasting.
 * Each SSE connection subscribes to the Redis channel `sse:<userId>`.
 * broadcast() publishes to that channel; every instance forwards the message
 * to any browser tabs it is currently serving for that user.
 *
 * This replaces the previous in-process Map which broke on 2+ instances.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const redisClient = require('../redis');
const logger = require('../logger');

const router = express.Router();

// One shared subscriber Redis connection (a duplicate so it can stay in
// subscribe mode without blocking data commands on the main client).
const subscriber = redisClient.duplicate();

subscriber.on('error', (err) => {
  logger.error('SSE Redis subscriber error', { error: err.message });
});

// channel → Set<res>  (which SSE responses are listening on this channel)
const channelClients = new Map();

// Forward Redis pub/sub messages to the appropriate SSE connections
subscriber.on('message', (channel, message) => {
  const conns = channelClients.get(channel);
  if (!conns || conns.size === 0) return;
  const frame = `data: ${message}\n\n`;
  conns.forEach((res) => {
    try { res.write(frame); } catch { /* socket already gone */ }
  });
});

/**
 * Broadcast a typed event to ALL active connections for a given userId.
 * Works across multiple server instances via Redis pub/sub.
 */
function broadcast(userId, type, payload = {}) {
  const message = JSON.stringify({ type, payload, ts: Date.now() });
  redisClient.publish(`sse:${userId}`, message).catch((err) => {
    logger.error('SSE broadcast publish error', { userId, error: err.message });
  });
}

module.exports.broadcast = broadcast;

/**
 * GET /api/events
 * Opens an SSE stream for the authenticated user.
 */
router.get('/', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const userId  = String(req.session.userId);
  const channel = `sse:${userId}`;

  // Register this connection in the channel map
  if (!channelClients.has(channel)) {
    channelClients.set(channel, new Set());
    // Subscribe to Redis channel when first client connects for this user
    subscriber.subscribe(channel, (err) => {
      if (err) logger.error('SSE Redis subscribe error', { channel, error: err.message });
    });
  }
  channelClients.get(channel).add(res);

  logger.info('SSE client connected', { userId, openConnections: channelClients.get(channel).size });

  // Initial handshake event
  res.write(`data: ${JSON.stringify({ type: 'connected', payload: { userId }, ts: Date.now() })}\n\n`);

  // 30-second keep-alive ping
  const timer = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'ping', ts: Date.now() })}\n\n`);
    } catch {
      clearInterval(timer);
    }
  }, 30_000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(timer);
    const conns = channelClients.get(channel);
    conns?.delete(res);
    if (conns?.size === 0) {
      channelClients.delete(channel);
      // Unsubscribe from Redis when no more local clients for this user
      subscriber.unsubscribe(channel).catch(() => {});
    }
    logger.info('SSE client disconnected', { userId });
  });
});

module.exports.router = router;

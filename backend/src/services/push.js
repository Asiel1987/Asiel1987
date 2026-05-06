'use strict';

const webpush = require('web-push');
const db = require('../db');
const logger = require('../logger');

// VAPID keys — generate once: node -e "const wp=require('web-push'); console.log(wp.generateVAPIDKeys())"
// Then set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:hello@asiel.farm';

let _ready = false;

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  _ready = true;
} else {
  logger.warn('VAPID keys not set — push notifications disabled');
}

/**
 * Send a Web Push notification to all subscriptions for a given userId.
 * Silently removes stale/expired subscriptions (410 Gone).
 */
async function sendPush(userId, title, body, data = {}) {
  if (!_ready) return;
  const { rows } = await db.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  if (!rows.length) return;

  const payload = JSON.stringify({ title, body, data });

  await Promise.allSettled(
    rows.map(async (sub) => {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(subscription, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription expired — remove it
          await db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id])
            .catch(() => {});
        } else {
          logger.error('Push send error', { userId, endpoint: sub.endpoint, error: err.message });
        }
      }
    })
  );
}

module.exports = { sendPush, vapidPublicKey: VAPID_PUBLIC };

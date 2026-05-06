'use strict';

/**
 * USSD handler for Africa's Talking *384# shortcode
 *
 * Africa's Talking sends a POST with:
 *   sessionId, phoneNumber, networkCode, serviceCode, text
 *
 * text is a *-delimited chain of all user inputs so far, e.g. "1*2*3".
 * Respond with plain text prefixed by CON (continue) or END (terminal).
 *
 * Menu tree:
 *   0  → Main menu
 *   1  → Browse top products (5 cheapest in stock for user's country)
 *   2  → My last order status
 *   3  → My wallet / payout balance (farmers)
 *   4  → Language (SW / EN)
 *   0  → Exit (any level)
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const logger = require('../logger');

// Detect country from phone prefix
function countryFromPhone(phone) {
  if (!phone) return 'TZ';
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254')) return 'KE';
  return 'TZ';
}

const CURRENCY = { TZ: 'TZS', KE: 'KES' };
const RATE_KES = 0.04; // approx TZS → KES

function fmtPrice(tzs, country) {
  if (country === 'KE') return `KES ${Math.round(tzs * RATE_KES).toLocaleString()}`;
  return `TZS ${tzs.toLocaleString()}`;
}

async function getTopProducts(country) {
  try {
    const { rows } = await db.query(
      `SELECT name, tzs_price, unit FROM products
        WHERE country = $1 AND available = TRUE AND stock_qty > 0
        ORDER BY tzs_price ASC LIMIT 5`,
      [country]
    );
    return rows;
  } catch { return []; }
}

async function getLastOrder(phone) {
  try {
    const { rows } = await db.query(
      `SELECT o.id, o.status, o.total_tzs, o.country
         FROM orders o
         JOIN users u ON u.id = o.customer_id
        WHERE u.phone = $1
        ORDER BY o.created_at DESC LIMIT 1`,
      [phone]
    );
    return rows[0] || null;
  } catch { return null; }
}

async function getFarmerBalance(phone) {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(amount_tzs),0) AS total
         FROM payouts p
         JOIN users u ON u.id = p.farmer_id
        WHERE u.phone = $1 AND p.status = 'completed'`,
      [phone]
    );
    return rows[0]?.total || 0;
  } catch { return 0; }
}

// ── POST /api/ussd ────────────────────────────────────────────────────────────
// Africa's Talking sends application/x-www-form-urlencoded
router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  const { sessionId, phoneNumber, text = '' } = req.body;
  const country = countryFromPhone(phoneNumber);
  const parts   = text.split('*').filter(Boolean);
  const level   = parts.length;
  const last    = parts[level - 1] || '';

  logger.info('USSD', { sessionId, phoneNumber, text });

  let response = '';

  try {
    if (level === 0 || last === '0') {
      // Main menu
      response = `CON Karibu Asiel Farm Shop\n1. Angalia mazao (Browse produce)\n2. Hali ya order yangu\n3. Pato langu (Farmers)\n0. Toka (Exit)`;

    } else if (parts[0] === '1') {
      // Browse top products
      if (level === 1) {
        const products = await getTopProducts(country);
        if (!products.length) {
          response = `END Hakuna mazao sasa hivi. Jaribu tena baadaye.`;
        } else {
          const lines = products.map((p, i) =>
            `${i + 1}. ${p.name} - ${fmtPrice(p.tzs_price, country)}/${p.unit}`
          );
          response = `CON Mazao ya leo (${country}):\n${lines.join('\n')}\n\n0. Nyuma`;
        }
      } else {
        response = `END Tembelea asiel.farm kununua au piga simu +255800ASIEL`;
      }

    } else if (parts[0] === '2') {
      // Last order status
      const order = await getLastOrder(phoneNumber);
      if (!order) {
        response = `END Huna order yoyote bado. Tembelea asiel.farm kuanza kununua.`;
      } else {
        const statusMap = { available:'Inasubiri', assigned:'Imepewa rider', 'picked-up':'Inakuja', delivered:'Imefika', cancelled:'Imefutwa' };
        const statusSw  = statusMap[order.status] || order.status;
        response = `END Order ${order.id}\nHali: ${statusSw}\nJumla: ${fmtPrice(order.total_tzs, order.country)}\n\nTembelea asiel.farm kwa maelezo zaidi.`;
      }

    } else if (parts[0] === '3') {
      // Farmer balance
      const balance = await getFarmerBalance(phoneNumber);
      response = `END Pato lako jumla (mara zote):\n${fmtPrice(balance, country)}\n\nTembelea asiel.farm kwa maelezo zaidi.`;

    } else {
      response = `END Chaguo batili. Piga tena *384#`;
    }
  } catch (err) {
    logger.error('USSD handler error', { error: err.message });
    response = `END Kosa la mfumo. Tafadhali jaribu tena.`;
  }

  res.set('Content-Type', 'text/plain');
  res.send(response);
});

module.exports = router;

'use strict';

/**
 * VFD — Virtual Fiscal Device (Tanzania Revenue Authority / TRA)
 *
 * Production: POSTs to NepTech /api/vfd/issue with Basic auth.
 * NepTech bridges your API call to the TRA EFDMS and returns a signed
 * fiscal receipt number and QR code data.
 *
 * Env vars required (see .env.example):
 *   VFD_API_URL, VFD_USERNAME, VFD_PASSWORD, VFD_TIN, VFD_VRN, VFD_SERIAL
 */

const axios  = require('axios');
const crypto = require('crypto');
const logger = require('../logger');

const VFD_API_URL = process.env.VFD_API_URL;
const VFD_USER    = process.env.VFD_USERNAME;
const VFD_PASS    = process.env.VFD_PASSWORD;
const VFD_TIN     = process.env.VFD_TIN    || '000-000-000';
const VFD_VRN     = process.env.VFD_VRN    || 'XX-XXXXXXXXX-X';
const VFD_SERIAL  = process.env.VFD_SERIAL || 'SERXXXXXXXXXX';

const VAT_RATE = 0.18;

/**
 * Issue a VFD fiscal receipt for an order.
 *
 * In production, calls NepTech API which submits to TRA EFDMS.
 * Falls back to a locally-generated stub when VFD_API_URL is not set
 * (development / sandbox only — not valid for compliance).
 *
 * @param {object} opts
 * @param {string} opts.orderId
 * @param {number} opts.amount   - Total in TZS
 * @param {string} opts.country  - 'TZ' or 'KE'
 * @param {Array}  opts.items    - [{ name, qty, price }]
 * @returns {Promise<object>}
 */
async function issueReceipt({ orderId, amount, country, items }) {
  if (country !== 'TZ') {
    return { applicable: false, reason: 'VFD receipts required only for Tanzania (TZ) transactions' };
  }

  // ── Production: call NepTech API ─────────────────────────────────────────
  if (VFD_API_URL && VFD_USER && VFD_PASS) {
    return issueViaNepTech({ orderId, amount, items });
  }

  // ── Development stub (not TRA-compliant) ─────────────────────────────────
  logger.warn('VFD_API_URL not configured — generating non-compliant stub receipt', { orderId });
  return buildStubReceipt({ orderId, amount, items });
}

async function issueViaNepTech({ orderId, amount, items }) {
  const now = new Date();
  const vatAmount = Math.round(amount * VAT_RATE);
  const netAmount = amount - vatAmount;

  const payload = {
    tin:        VFD_TIN,
    vrn:        VFD_VRN,
    serial:     VFD_SERIAL,
    orderId,
    date:       now.toISOString().slice(0, 10),
    time:       now.toISOString().slice(11, 19),
    totalAmount: amount,
    netAmount,
    vatAmount,
    vatRate:    VAT_RATE * 100,
    currency:   'TZS',
    items: items.map((item, idx) => ({
      lineNo:      idx + 1,
      description: item.name,
      quantity:    item.qty,
      unitPrice:   item.price,
      lineTotal:   item.qty * item.price,
      taxCode:     'A',
    })),
  };

  logger.info('Submitting VFD receipt to NepTech', { orderId, amount });

  const { data } = await axios.post(`${VFD_API_URL}/issue`, payload, {
    auth:    { username: VFD_USER, password: VFD_PASS },
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
  });

  if (!data.success) {
    logger.error('NepTech VFD issuance failed', { orderId, response: data });
    throw new Error(`VFD error: ${data.message || 'Unknown NepTech error'}`);
  }

  logger.info('VFD receipt issued via NepTech', {
    orderId,
    fiscalNumber: data.fiscalNumber,
    receiptNumber: data.receiptNumber,
  });

  return {
    fiscalNumber:    data.fiscalNumber,
    receiptNumber:   data.receiptNumber,
    tin:             VFD_TIN,
    vrn:             VFD_VRN,
    serialNumber:    VFD_SERIAL,
    orderId,
    issuedAt:        now.toISOString(),
    currency:        'TZS',
    netAmount,
    vatRate:         `${VAT_RATE * 100}%`,
    vatAmount,
    totalAmount:     amount,
    items:           payload.items,
    qrData:          data.qrData || null,
    verificationUrl: data.verificationUrl || null,
  };
}

function buildStubReceipt({ orderId, amount, items }) {
  const now         = new Date();
  const vatAmount   = Math.round(amount * VAT_RATE);
  const netAmount   = amount - vatAmount;
  const receiptNumber = `RCT${Date.now().toString(36).toUpperCase()}`;
  const fiscalNumber  = `${VFD_TIN.replace(/-/g, '')}${crypto.randomInt(100000, 999999)}`;

  const verificationCode = crypto
    .createHash('sha256')
    .update(`${VFD_TIN}${receiptNumber}${amount}${now.toISOString()}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();

  const qrData = [VFD_TIN, VFD_VRN, receiptNumber,
    now.toISOString().replace('T', ' ').slice(0, 19),
    amount, vatAmount, verificationCode].join('|');

  return {
    fiscalNumber,
    receiptNumber,
    tin:             VFD_TIN,
    vrn:             VFD_VRN,
    serialNumber:    VFD_SERIAL,
    orderId,
    issuedAt:        now.toISOString(),
    currency:        'TZS',
    netAmount,
    vatRate:         `${VAT_RATE * 100}%`,
    vatAmount,
    totalAmount:     amount,
    items: items.map((item, idx) => ({
      lineNo: idx + 1, description: item.name,
      quantity: item.qty, unitPrice: item.price,
      lineTotal: item.qty * item.price, taxCode: 'A',
    })),
    qrData,
    verificationCode,
    verificationUrl: `https://virtual.tra.go.tz/efdmsRctVerify/verify?qr=${encodeURIComponent(qrData)}`,
    note: 'STUB — set VFD_API_URL, VFD_USERNAME, VFD_PASSWORD in .env for production',
  };
}

module.exports = { issueReceipt };

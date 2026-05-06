'use strict';

/**
 * VFD — Virtual Fiscal Device (Tanzania Revenue Authority / TRA)
 *
 * In production: POST to NepTech /api/vfd/issue with your VFD credentials.
 * NepTech acts as the intermediary between your application and the TRA EFDMS.
 *
 * The receipt object returned here matches the structure of a real TRA fiscal
 * receipt and can be presented to the customer as a valid receipt stub until
 * full VFD integration is enabled.
 */

const crypto = require('crypto');
const logger = require('../logger');

const VFD_TIN = process.env.VFD_TIN || '000-000-000';
const VFD_VRN = process.env.VFD_VRN || 'XX-XXXXXXXXX-X';
const VFD_SERIAL = process.env.VFD_SERIAL || 'SERXXXXXXXXXX';

/**
 * Issue a VFD fiscal receipt for an order.
 *
 * In production this function would POST to:
 *   POST ${process.env.VFD_API_URL}/issue
 * with Basic auth (VFD_USERNAME:VFD_PASSWORD) and the body below.
 *
 * @param {object} opts
 * @param {string} opts.orderId  - Internal order UUID
 * @param {number} opts.amount   - Total amount in TZS
 * @param {string} opts.country  - 'TZ' or 'KE'
 * @param {Array}  opts.items    - Array of { name, qty, price }
 * @returns {Promise<object>} VFD receipt object
 */
async function issueReceipt({ orderId, amount, country, items }) {
  // Tanzania VFD is only applicable for TZ transactions
  if (country !== 'TZ') {
    logger.info('VFD not required for non-TZ country', { orderId, country });
    return {
      applicable: false,
      reason: 'VFD receipts required only for Tanzania (TZ) transactions',
    };
  }

  const now = new Date();

  // Fiscal number: TIN + sequential number (in production this comes from TRA EFDMS)
  const fiscalNumber = `${VFD_TIN.replace(/-/g, '')}${String(
    Math.floor(Math.random() * 900000) + 100000
  )}`;

  const receiptNumber = `RCT${Date.now().toString(36).toUpperCase()}`;

  // TRA uses 18% VAT (standard rate)
  const vatRate = 0.18;
  const vatAmount = Math.round(amount * vatRate);
  const netAmount = amount - vatAmount;

  // QR data per TRA specification:
  // <TIN>|<VRN>|<ReceiptNumber>|<Date>|<Amount>|<VATAmount>|<Verification>
  const verificationCode = crypto
    .createHash('sha256')
    .update(`${VFD_TIN}${receiptNumber}${amount}${now.toISOString()}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();

  const dateStr = now.toISOString().replace('T', ' ').slice(0, 19);

  const qrData = [
    VFD_TIN,
    VFD_VRN,
    receiptNumber,
    dateStr,
    amount,
    vatAmount,
    verificationCode,
  ].join('|');

  const receipt = {
    fiscalNumber,
    receiptNumber,
    tin: VFD_TIN,
    vrn: VFD_VRN,
    serialNumber: VFD_SERIAL,
    orderId,
    issuedAt: now.toISOString(),
    currency: 'TZS',
    netAmount,
    vatRate: `${vatRate * 100}%`,
    vatAmount,
    totalAmount: amount,
    items: items.map((item, idx) => ({
      lineNo: idx + 1,
      description: item.name,
      quantity: item.qty,
      unitPrice: item.price,
      lineTotal: item.qty * item.price,
      taxCode: 'A', // Standard rate
    })),
    qrData,
    verificationCode,
    // In production this URL would be a TRA-hosted verification page
    verificationUrl: `https://virtual.tra.go.tz/efdmsRctVerify/verify?qr=${encodeURIComponent(qrData)}`,
    note: 'STUB — integrate NepTech VFD API for production fiscal receipts',
  };

  logger.info('VFD receipt generated (stub)', {
    orderId,
    receiptNumber,
    fiscalNumber,
    totalAmount: amount,
  });

  return receipt;
}

module.exports = { issueReceipt };

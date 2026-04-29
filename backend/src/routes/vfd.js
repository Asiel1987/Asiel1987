'use strict';

const express         = require('express');
const Joi             = require('joi');
const { requireAuth } = require('../middleware/auth');
const vfdService      = require('../services/vfd');
const logger          = require('../logger');

const router = express.Router();

const vfdSchema = Joi.object({
  orderId: Joi.string().required(),
  amount:  Joi.number().integer().min(1).required(),
  country: Joi.string().valid('TZ','KE').required(),
  items:   Joi.array().items(Joi.object({
    name:     Joi.string().required(),
    qty:      Joi.number().required(),
    price:    Joi.number().required(),
  })).min(1).required(),
});

// POST /api/vfd — issue TRA VFD fiscal receipt (Tanzania only)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { error, value } = vfdSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    if (value.country !== 'TZ') return res.status(400).json({ error: 'VFD is only available for Tanzania (TZ)' });

    const receipt = await vfdService.issueReceipt(value);
    logger.info('VFD receipt issued', { orderId: value.orderId, fiscalNumber: receipt.fiscalNumber });
    res.json({ receipt });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

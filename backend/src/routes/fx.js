'use strict';

const express = require('express');
const axios   = require('axios');
const redis   = require('../redis');
const logger  = require('../logger');

const router = express.Router();
const CACHE_KEY = 'fx:rates';
const CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds

const SEED_FX = {
  KES:0.0465, USD:0.000358, EUR:0.000330, GBP:0.000281, CNY:0.002593,
  NGN:0.542,  GHS:0.00537,  ETB:0.0199,  EGP:0.01126,  ZAR:0.00666,
  RWF:0.414,  UGX:1.285,    XOF:0.2162,  MAD:0.00358,
};

// GET /api/fx
router.get('/', async (_req, res, next) => {
  try {
    // Check cache first
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      return res.json(parsed);
    }

    // Fetch from Open Exchange Rates (base USD; we convert to TZS base)
    const appId = process.env.OPENEXCHANGERATES_APP_ID;
    if (!appId) {
      logger.warn('OPENEXCHANGERATES_APP_ID not set — returning seed rates');
      return res.json({ base: 'TZS', rates: SEED_FX, source: 'seed', updatedAt: new Date().toISOString() });
    }

    const { data } = await axios.get(`https://openexchangerates.org/api/latest.json?app_id=${appId}&base=USD`, { timeout: 8000 });
    const usdToTzs = data.rates.TZS;
    const rates = {};
    for (const [code, usdRate] of Object.entries(data.rates)) {
      if (SEED_FX[code] !== undefined) {
        // Convert: 1 TZS = (1/usdToTzs) USD = (usdRate/usdToTzs) target
        rates[code] = usdRate / usdToTzs;
      }
    }

    const payload = { base: 'TZS', rates, source: 'live', updatedAt: new Date().toISOString() };
    await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(payload));
    res.json(payload);
  } catch (err) {
    logger.warn('FX fetch failed — returning seed rates', { error: err.message });
    res.json({ base: 'TZS', rates: SEED_FX, source: 'seed', updatedAt: new Date().toISOString() });
  }
});

module.exports = router;

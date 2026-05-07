'use strict';

/**
 * HerdPass API
 *
 * POST /api/herd/sync    — batch upsert animals/events/leases from IndexedDB
 * GET  /api/herd/animals — list caller's animals (with summary stats)
 * GET  /api/herd/animals/:id/events — list events for one animal
 *
 * Admin / lender extras:
 * GET  /api/herd/admin/portfolio — all leases (admin only)
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();
const db      = require('../db');
const logger  = require('../logger');

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Allowed species + statuses (mirror client-side constants)
const VALID_SPECIES  = new Set(['cow','goat','sheep','fish']);
const VALID_STATUSES = new Set(['active','dry','pregnant','empty','sold','culled']);
const VALID_EV_TYPES = new Set(['health','repro','production']);
const VALID_FREQS    = new Set(['monthly','quarterly','bi-annual','annual']);

// ── POST /api/herd/sync ─────────────────────────────────────────────────────────────
// Client sends arrays of unsynced animals/events/leases/payments.
// We upsert each batch inside a transaction and return counts.
router.post('/sync', requireAuth, async (req, res, next) => {
  const userId = req.session.userId;
  const { animals = [], events = [], leases = [] } = req.body || {};

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // ── Animals ────────────────────────────────────────────────────────────────────
    let animalCount = 0;
    for (const a of animals) {
      if (!a.id || !a.tagNumber) continue;
      if (a.species && !VALID_SPECIES.has(a.species)) continue;
      if (a.status  && !VALID_STATUSES.has(a.status))  continue;

      await client.query(
        `INSERT INTO herd_animals
           (id, user_id, species, category, tag_number, name, breed, sex, dob, entry_date,
            entry_method, status, lactation_no, weight_kg, colour, notes, synced, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,TRUE,NOW())
         ON CONFLICT (id) DO UPDATE SET
           species       = EXCLUDED.species,
           category      = EXCLUDED.category,
           tag_number    = EXCLUDED.tag_number,
           name          = EXCLUDED.name,
           breed         = EXCLUDED.breed,
           sex           = EXCLUDED.sex,
           dob           = EXCLUDED.dob,
           entry_date    = EXCLUDED.entry_date,
           entry_method  = EXCLUDED.entry_method,
           status        = EXCLUDED.status,
           lactation_no  = EXCLUDED.lactation_no,
           weight_kg     = EXCLUDED.weight_kg,
           colour        = EXCLUDED.colour,
           notes         = EXCLUDED.notes,
           updated_at    = NOW()
         WHERE herd_animals.user_id = $2`,
        [
          a.id, userId,
          a.species || 'cow',
          a.category || 'dairy',
          a.tagNumber,
          a.name    || null,
          a.breed   || null,
          a.sex     || null,
          a.dob     || null,
          a.entryDate   || null,
          a.entryMethod || null,
          a.status  || 'active',
          a.lactationNo ? parseInt(a.lactationNo, 10) : null,
          a.weightKg    ? parseFloat(a.weightKg)      : null,
          a.colour  || null,
          a.notes   || null,
        ]
      );
      animalCount++;
    }

    // ── Events ────────────────────────────────────────────────────────────────────
    let eventCount = 0;
    for (const ev of events) {
      if (!ev.id || !ev.animalId || !ev.type || !ev.date) continue;
      if (!VALID_EV_TYPES.has(ev.type)) continue;

      // Verify animal belongs to this user
      const own = await client.query(
        'SELECT id FROM herd_animals WHERE id=$1 AND user_id=$2', [ev.animalId, userId]
      );
      if (!own.rows.length) continue;

      await client.query(
        `INSERT INTO herd_events
           (id, animal_id, user_id, type, subtype, date, value, unit, session,
            vaccine, drug, drug_name, next_due, vet, cost, bull_semen,
            expected_date, offspring_count, calving_outcome, milk_quality, bcs,
            checkup_type, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT (id) DO NOTHING`,
        [
          ev.id, ev.animalId, userId,
          ev.type, ev.subtype || ev.type,
          ev.date,
          ev.value        ? parseFloat(ev.value)         : null,
          ev.unit         || null,
          ev.session      || null,
          ev.vaccine      || null,
          ev.drug         || null,
          ev.drugName     || null,
          ev.nextDue      || null,
          ev.vet          || null,
          ev.cost         ? parseInt(ev.cost, 10)        : null,
          ev.bullSemen    || null,
          ev.expectedDate || null,
          ev.offspringCount ? parseInt(ev.offspringCount, 10) : null,
          ev.calvingOutcome || null,
          ev.milkQuality  || null,
          ev.bcs          ? parseFloat(ev.bcs)           : null,
          ev.checkupType  || null,
          ev.notes        || null,
        ]
      );
      eventCount++;
    }

    // ── Leases ────────────────────────────────────────────────────────────────────
    let leaseCount = 0;
    for (const l of leases) {
      if (!l.id || !l.animalId || !l.lenderName) continue;
      if (l.frequency && !VALID_FREQS.has(l.frequency)) continue;

      const own = await client.query(
        'SELECT id FROM herd_animals WHERE id=$1 AND user_id=$2', [l.animalId, userId]
      );
      if (!own.rows.length) continue;

      await client.query(
        `INSERT INTO herd_leases
           (id, animal_id, user_id, lender_name, principal_tzs, interest_rate,
            total_instalments, instalment_amount_tzs, start_date, frequency,
            contract_ref, notes, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (id) DO UPDATE SET
           lender_name           = EXCLUDED.lender_name,
           principal_tzs         = EXCLUDED.principal_tzs,
           interest_rate         = EXCLUDED.interest_rate,
           total_instalments     = EXCLUDED.total_instalments,
           instalment_amount_tzs = EXCLUDED.instalment_amount_tzs,
           start_date            = EXCLUDED.start_date,
           frequency             = EXCLUDED.frequency,
           contract_ref          = EXCLUDED.contract_ref,
           notes                 = EXCLUDED.notes,
           updated_at            = NOW()
         WHERE herd_leases.user_id = $3`,
        [
          l.id, l.animalId, userId,
          l.lenderName,
          l.principalTzs         ? parseInt(l.principalTzs, 10)         : 0,
          l.interestRate         ? parseFloat(l.interestRate)           : null,
          l.totalInstalments     ? parseInt(l.totalInstalments, 10)     : null,
          l.instalmentAmountTzs  ? parseInt(l.instalmentAmountTzs, 10)  : null,
          l.startDate     || null,
          l.frequency     || 'monthly',
          l.contractRef   || null,
          l.notes         || null,
        ]
      );

      // Upsert payments attached to this lease
      for (const p of (l.payments || [])) {
        if (!p.id || !p.amountTzs || !p.payDate) continue;
        await client.query(
          `INSERT INTO herd_lease_payments
             (id, lease_id, user_id, amount_tzs, pay_date, method, ref, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO NOTHING`,
          [
            p.id, l.id, userId,
            parseInt(p.amountTzs, 10),
            p.payDate,
            p.method || null,
            p.ref    || null,
            p.notes  || null,
          ]
        );
      }
      leaseCount++;
    }

    await client.query('COMMIT');

    logger.info('HerdPass sync', { userId, animalCount, eventCount, leaseCount });
    return res.json({ ok: true, synced: { animals: animalCount, events: eventCount, leases: leaseCount } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ── GET /api/herd/animals ──────────────────────────────────────────────────────────
router.get('/animals', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*,
              COUNT(e.id)                                        AS event_count,
              COUNT(e.id) FILTER (WHERE e.type = 'health')      AS health_count,
              COUNT(e.id) FILTER (WHERE e.type = 'repro')       AS repro_count,
              COUNT(e.id) FILTER (WHERE e.type = 'production')  AS prod_count,
              l.id                                              AS lease_id,
              l.lender_name, l.principal_tzs, l.instalment_amount_tzs
         FROM herd_animals a
    LEFT JOIN herd_events  e ON e.animal_id = a.id
    LEFT JOIN herd_leases  l ON l.animal_id = a.id
        WHERE a.user_id = $1
        GROUP BY a.id, l.id, l.lender_name, l.principal_tzs, l.instalment_amount_tzs
        ORDER BY a.updated_at DESC`,
      [req.session.userId]
    );
    return res.json({ animals: rows });
  } catch (err) { next(err); }
});

// ── GET /api/herd/animals/:id/events ──────────────────────────────────────────────
router.get('/animals/:id/events', requireAuth, async (req, res, next) => {
  try {
    const { rows: animal } = await db.query(
      'SELECT id FROM herd_animals WHERE id=$1 AND user_id=$2',
      [req.params.id, req.session.userId]
    );
    if (!animal.length) return res.status(404).json({ error: 'Animal not found' });

    const { rows } = await db.query(
      'SELECT * FROM herd_events WHERE animal_id=$1 ORDER BY date DESC, created_at DESC',
      [req.params.id]
    );
    return res.json({ events: rows });
  } catch (err) { next(err); }
});

// ── GET /api/herd/admin/portfolio ─────────────────────────────────────────────────
// Returns all active AF Lease hire-purchase records with payment progress — for lender dashboard
router.get('/admin/portfolio', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT l.*,
              u.phone, u.name AS farmer_name, u.country,
              a.species, a.category, a.breed, a.tag_number, a.name AS animal_name, a.status AS animal_status,
              COALESCE(SUM(p.amount_tzs), 0)  AS paid_tzs,
              COUNT(p.id)                      AS payment_count
         FROM herd_leases l
         JOIN herd_animals a ON a.id = l.animal_id
         JOIN users        u ON u.id = l.user_id
    LEFT JOIN herd_lease_payments p ON p.lease_id = l.id
        GROUP BY l.id, u.phone, u.name, u.country,
                 a.species, a.category, a.breed, a.tag_number, a.name, a.status
        ORDER BY l.created_at DESC`
    );
    return res.json({ portfolio: rows });
  } catch (err) { next(err); }
});

module.exports = router;

-- Migration 004: add charged_tzs to orders + fix status CHECK constraint
-- Run with: psql $DATABASE_URL -f migrations/004_orders_charged_tzs_status_fix.sql

-- ── charged_tzs column ────────────────────────────────────────────────────────
-- Stores the amount actually charged to the payment processor after loyalty
-- point redemption. total_tzs remains the gross (pre-discount) figure.
-- Default to total_tzs for any existing rows (no loyalty discount applied).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS charged_tzs INTEGER
    NOT NULL DEFAULT 0
    CHECK (charged_tzs >= 0);

-- Back-fill existing rows: charged amount equals gross total
UPDATE orders SET charged_tzs = total_tzs WHERE charged_tzs = 0;

-- ── status CHECK constraint ───────────────────────────────────────────────────
-- The original constraint used 'in_transit'; all application code uses
-- 'picked-up'. Add 'picked-up' to the allowed set and keep 'in_transit' for
-- backward compatibility with any existing rows.
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
    CHECK (status IN (
      'pending', 'paid', 'confirmed', 'preparing',
      'assigned', 'picked-up', 'in_transit',
      'delivered', 'cancelled', 'refunded'
    ));

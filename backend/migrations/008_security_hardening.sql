-- =============================================================================
-- Asiel Farm Shop — Security hardening migration
-- Migration: 008_security_hardening.sql
--
-- Addresses audit findings:
--   M12 — interest_rate: cap to realistic range (0–100%)
--   M13 — non-negative checks on herd_events.cost and offspring_count
--   M14 — missing performance/query indexes
--   C5  — PostgreSQL Row-Level Security for user-scoped tables
--   L7  — orders.total_tzs must be > 0 (idempotent ALTER)
-- =============================================================================

-- ── M12: Cap interest rate ────────────────────────────────────────────────────
ALTER TABLE herd_leases
  DROP CONSTRAINT IF EXISTS herd_leases_interest_rate_check;
ALTER TABLE herd_leases
  ADD CONSTRAINT herd_leases_interest_rate_check
    CHECK (interest_rate IS NULL OR (interest_rate >= 0 AND interest_rate <= 100));

-- ── M13: Non-negative event cost and offspring_count ─────────────────────────
ALTER TABLE herd_events
  DROP CONSTRAINT IF EXISTS herd_events_cost_check;
ALTER TABLE herd_events
  ADD CONSTRAINT herd_events_cost_check
    CHECK (cost IS NULL OR cost >= 0);

ALTER TABLE herd_events
  DROP CONSTRAINT IF EXISTS herd_events_offspring_count_check;
ALTER TABLE herd_events
  ADD CONSTRAINT herd_events_offspring_count_check
    CHECK (offspring_count IS NULL OR offspring_count >= 0);

-- ── M14: Missing indexes ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_created_at
  ON orders(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_herd_lease_payments_pay_date
  ON herd_lease_payments(pay_date DESC);

CREATE INDEX IF NOT EXISTS idx_herd_animals_user_updated
  ON herd_animals(user_id, updated_at DESC);

-- ── L7: orders.total_tzs must be positive (> 0) ──────────────────────────────
-- Drop the old >= 0 constraint and replace with > 0.
-- The name used in 001_initial.sql is the auto-generated one; use IF EXISTS guards.
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_total_tzs_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_total_tzs_check CHECK (total_tzs > 0);

-- ── C5: Row-Level Security ────────────────────────────────────────────────────
-- Enable RLS on user-scoped tables so queries without a matching policy return
-- zero rows instead of leaking data on misconfigured joins.
--
-- Policy design: the application connects as the "app" role.  Each table owner
-- has a permissive policy for the authenticated application user plus an admin
-- bypass.  Adjust role names to match your actual Postgres setup.

-- herd_animals
ALTER TABLE herd_animals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS herd_animals_owner ON herd_animals;
CREATE POLICY herd_animals_owner ON herd_animals
  USING (user_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_role', true) = 'admin');

-- herd_events
ALTER TABLE herd_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS herd_events_owner ON herd_events;
CREATE POLICY herd_events_owner ON herd_events
  USING (user_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_role', true) = 'admin');

-- herd_leases
ALTER TABLE herd_leases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS herd_leases_owner ON herd_leases;
CREATE POLICY herd_leases_owner ON herd_leases
  USING (user_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_role', true) = 'admin');

-- herd_lease_payments
ALTER TABLE herd_lease_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS herd_lease_payments_owner ON herd_lease_payments;
CREATE POLICY herd_lease_payments_owner ON herd_lease_payments
  USING (user_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_role', true) = 'admin');

-- farmer_profiles — protect GPS coordinates (M15)
ALTER TABLE farmer_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS farmer_profiles_owner ON farmer_profiles;
CREATE POLICY farmer_profiles_owner ON farmer_profiles
  USING (user_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_role', true) = 'admin');

-- Track migration
INSERT INTO schema_migrations (filename) VALUES ('008_security_hardening.sql')
  ON CONFLICT DO NOTHING;

-- =============================================================================
-- Asiel Farm Shop — Initial Database Schema
-- Migration: 001_initial.sql
-- Compatible with: PostgreSQL 14+ / Supabase
--
-- Run with:  psql $DATABASE_URL -f migrations/001_initial.sql
--        or: npm run migrate
-- =============================================================================

-- Enable pgcrypto for gen_random_uuid() (already enabled on Supabase; idempotent)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Migration tracking ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (filename) VALUES ('001_initial.sql')
  ON CONFLICT DO NOTHING;

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       VARCHAR(20) UNIQUE NOT NULL,
  role        VARCHAR(20) NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer', 'farmer', 'rider', 'inspector', 'admin')),
  country     CHAR(2)     NOT NULL DEFAULT 'TZ'
                CHECK (country IN ('TZ', 'KE')),
  loyalty_pts INTEGER     NOT NULL DEFAULT 0 CHECK (loyalty_pts >= 0),
  name        VARCHAR(100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- ── Products ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id    UUID         REFERENCES users(id) ON DELETE SET NULL,
  name         VARCHAR(200) NOT NULL,
  tzs_price    INTEGER      NOT NULL CHECK (tzs_price > 0),
  stock_qty    INTEGER      NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  unit         VARCHAR(20)  NOT NULL DEFAULT 'KG',
  country      CHAR(2)      NOT NULL CHECK (country IN ('TZ', 'KE')),
  organic      BOOLEAN      NOT NULL DEFAULT false,
  hub_ready    BOOLEAN      NOT NULL DEFAULT false,
  harvest_date DATE,
  available    BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_country_available ON products(country, available);
CREATE INDEX IF NOT EXISTS idx_products_farmer            ON products(farmer_id);

-- ── Orders ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID        REFERENCES users(id) ON DELETE RESTRICT,
  rider_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
  status           VARCHAR(30) NOT NULL DEFAULT 'pending'
                     CHECK (status IN (
                       'pending', 'paid', 'confirmed', 'preparing',
                       'assigned', 'in_transit', 'delivered',
                       'cancelled', 'refunded'
                     )),
  total_tzs        INTEGER     NOT NULL CHECK (total_tzs > 0),
  delivery_fee     INTEGER     NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  discount         INTEGER     NOT NULL DEFAULT 0 CHECK (discount >= 0),
  country          CHAR(2)     NOT NULL CHECK (country IN ('TZ', 'KE')),
  delivery_address TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_rider_id    ON orders(rider_id);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_country     ON orders(country);

-- ── Order Items ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  tzs_price  INTEGER NOT NULL CHECK (tzs_price > 0)   -- price snapshot at order time
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);

-- ── Payments ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID         NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  method       VARCHAR(30)  NOT NULL
                 CHECK (method IN (
                   'mpesa', 'tigopesa', 'selcom', 'airtel', 'mtn',
                   'card', 'bank'
                 )),
  ref          VARCHAR(100) UNIQUE NOT NULL,    -- our internal UUID reference
  provider_ref VARCHAR(200),                    -- provider's transaction / checkout ID
  status       VARCHAR(20)  NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  amount_tzs   INTEGER      NOT NULL CHECK (amount_tzs > 0),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_ref      ON payments(ref);
CREATE INDEX        IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX        IF NOT EXISTS idx_payments_status   ON payments(status);

-- ── Reviews ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID      REFERENCES orders(id) ON DELETE SET NULL,
  farmer_id   UUID      REFERENCES users(id)  ON DELETE CASCADE,
  customer_id UUID      REFERENCES users(id)  ON DELETE CASCADE,
  rating      SMALLINT  NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  country     CHAR(2)   CHECK (country IN ('TZ', 'KE')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_farmer_id   ON reviews(farmer_id);
CREATE INDEX IF NOT EXISTS idx_reviews_customer_id ON reviews(customer_id);

-- ── auto updated_at trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_users_updated_at') THEN
    CREATE TRIGGER set_users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_orders_updated_at') THEN
    CREATE TRIGGER set_orders_updated_at
      BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_payments_updated_at') THEN
    CREATE TRIGGER set_payments_updated_at
      BEFORE UPDATE ON payments
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

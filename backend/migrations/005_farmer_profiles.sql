-- Migration 005: farmer_profiles table
-- Moves farmer onboarding data from Redis (volatile) to PostgreSQL (durable).
-- Run with: psql $DATABASE_URL -f migrations/005_farmer_profiles.sql

CREATE TABLE IF NOT EXISTS farmer_profiles (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name        TEXT        NOT NULL,
  farm_name        TEXT        NOT NULL,
  region           TEXT        NOT NULL,
  farm_size        VARCHAR(10) NOT NULL CHECK (farm_size IN ('small','medium','large')),
  lat              NUMERIC(9,6),
  lng              NUMERIC(9,6),
  crops            TEXT[]      NOT NULL DEFAULT '{}',
  farming_method   VARCHAR(20) NOT NULL CHECK (farming_method IN ('organic','conventional','mixed')),
  year_round       BOOLEAN     NOT NULL DEFAULT FALSE,
  can_hub_deliver  BOOLEAN     NOT NULL DEFAULT FALSE,
  has_cold_storage BOOLEAN     NOT NULL DEFAULT FALSE,
  max_weekly_kg    INTEGER     NOT NULL CHECK (max_weekly_kg >= 1),
  payout_method    VARCHAR(10) NOT NULL CHECK (payout_method IN ('mpesa','tigo','airtel','bank')),
  payout_phone     TEXT        NOT NULL DEFAULT '',
  status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected')),
  reviewed_by      UUID        REFERENCES users(id),
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farmer_profiles_status  ON farmer_profiles (status);
CREATE INDEX IF NOT EXISTS idx_farmer_profiles_user_id ON farmer_profiles (user_id);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION set_farmer_profiles_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'set_farmer_profiles_updated_at'
  ) THEN
    CREATE TRIGGER set_farmer_profiles_updated_at
      BEFORE UPDATE ON farmer_profiles
      FOR EACH ROW EXECUTE FUNCTION set_farmer_profiles_updated_at();
  END IF;
END;
$$;

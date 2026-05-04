-- =============================================================================
-- Asiel Farm Shop — Social Auth Migration
-- Migration: 002_social_auth.sql
-- Adds Google and Apple sign-in support to the users table.
--
-- Run with:  psql $DATABASE_URL -f migrations/002_social_auth.sql
-- =============================================================================

-- Allow social users who have no phone number (OTP users still have one)
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

-- Social identity columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS email        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Partial unique indices: PostgreSQL allows multiple NULLs in a unique index,
-- so these only enforce uniqueness when the value is present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email      ON users(email)     WHERE email     IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id  ON users(google_id) WHERE google_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_id   ON users(apple_id)  WHERE apple_id  IS NOT NULL;

-- Migration 003: push subscriptions, referral codes, saved delivery addresses
-- Run with: psql $DATABASE_URL -f migrations/003_push_referrals_addresses.sql

-- ── Push subscriptions ────────────────────────────────────────────────────────
-- Stores Web Push API subscription objects per user/device.
-- One user can have multiple devices (multiple rows).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL,
  p256dh        TEXT NOT NULL,  -- client public key (base64url)
  auth          TEXT NOT NULL,  -- auth secret (base64url)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id);

-- ── Referral codes ────────────────────────────────────────────────────────────
-- Each user gets one referral code. A referee entry is created when someone
-- uses a code; reward_paid is set true after the referee's first sale.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_code  TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS referred_by_id UUID REFERENCES users(id);

CREATE TABLE IF NOT EXISTS referrals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referee_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_tzs      INTEGER NOT NULL DEFAULT 5000,
  reward_paid     BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (referee_id)   -- one referrer per referee
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_id);

-- ── Saved delivery addresses ──────────────────────────────────────────────────
-- Up to 3 saved addresses per user with a free-text nickname.
CREATE TABLE IF NOT EXISTS saved_addresses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname    TEXT NOT NULL,            -- "Home", "Office", "Mum's place"
  address     TEXT NOT NULL,
  country     CHAR(2) NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_addr_user ON saved_addresses (user_id);

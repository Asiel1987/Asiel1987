-- AF Lease application tables (KYC + Business Appraisal + Referee forms)

CREATE TABLE IF NOT EXISTS afl_applications (
  id              TEXT        PRIMARY KEY,          -- client-generated UUID
  referee_token   TEXT        UNIQUE,               -- shareable token for referee link
  referee_count   SMALLINT    NOT NULL DEFAULT 0,   -- how many referee forms received
  data            JSONB       NOT NULL DEFAULT '{}', -- full form payload
  submitted_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_afl_apps_submitted ON afl_applications(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_afl_apps_token     ON afl_applications(referee_token);

CREATE TABLE IF NOT EXISTS afl_referees (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_token       TEXT        NOT NULL UNIQUE,      -- matches afl_applications.referee_token; one submission per link
  data            JSONB       NOT NULL DEFAULT '{}',
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_afl_refs_token ON afl_referees(app_token);

INSERT INTO schema_migrations(filename) VALUES('007_afl_applications.sql')
  ON CONFLICT DO NOTHING;

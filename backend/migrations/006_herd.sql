-- HerdPass livestock management tables
-- Mirrors the IndexedDB schema on the client for sync and lender dashboards

CREATE TABLE IF NOT EXISTS herd_animals (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species       VARCHAR(20)  NOT NULL CHECK (species IN ('cow','goat','sheep','fish')),
  category      VARCHAR(20)  NOT NULL DEFAULT 'dairy',
  tag_number    VARCHAR(80)  NOT NULL,
  name          VARCHAR(120),
  breed         VARCHAR(120),
  sex           VARCHAR(20)  CHECK (sex IN ('female','male','castrated')),
  dob           DATE,
  entry_date    DATE,
  entry_method  VARCHAR(60),
  status        VARCHAR(20)  NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','dry','pregnant','empty','sold','culled')),
  lactation_no  SMALLINT,
  weight_kg     NUMERIC(7,2),
  colour        VARCHAR(80),
  notes         TEXT,
  synced        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_herd_animals_user    ON herd_animals(user_id);
CREATE INDEX IF NOT EXISTS idx_herd_animals_species ON herd_animals(user_id, species);
CREATE INDEX IF NOT EXISTS idx_herd_animals_status  ON herd_animals(user_id, status);

-- Unique tag per user (tags can be reused across farms)
CREATE UNIQUE INDEX IF NOT EXISTS idx_herd_animals_tag_user
  ON herd_animals(user_id, tag_number)
  WHERE status != 'sold' AND status != 'culled';

CREATE TABLE IF NOT EXISTS herd_events (
  id            UUID PRIMARY KEY,
  animal_id     UUID NOT NULL REFERENCES herd_animals(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          VARCHAR(20)  NOT NULL CHECK (type IN ('health','repro','production')),
  subtype       VARCHAR(80)  NOT NULL,
  date          DATE         NOT NULL,
  value         NUMERIC(10,3),
  unit          VARCHAR(20),
  session       VARCHAR(20),
  vaccine       VARCHAR(80),
  drug          VARCHAR(80),
  drug_name     VARCHAR(80),
  next_due      DATE,
  vet           VARCHAR(120),
  cost          INTEGER,                   -- TZS
  bull_semen    VARCHAR(120),
  expected_date DATE,
  offspring_count SMALLINT,
  calving_outcome VARCHAR(60),
  milk_quality  VARCHAR(60),
  bcs           NUMERIC(3,1),
  checkup_type  VARCHAR(80),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_herd_events_animal ON herd_events(animal_id);
CREATE INDEX IF NOT EXISTS idx_herd_events_user   ON herd_events(user_id);
CREATE INDEX IF NOT EXISTS idx_herd_events_date   ON herd_events(date DESC);
CREATE INDEX IF NOT EXISTS idx_herd_events_type   ON herd_events(animal_id, type);

CREATE TABLE IF NOT EXISTS herd_leases (
  id                    UUID PRIMARY KEY,
  animal_id             UUID NOT NULL REFERENCES herd_animals(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lender_name           VARCHAR(120) NOT NULL,
  principal_tzs         INTEGER      NOT NULL,
  interest_rate         NUMERIC(5,2),
  total_instalments     SMALLINT,
  instalment_amount_tzs INTEGER,
  start_date            DATE,
  frequency             VARCHAR(20) CHECK (frequency IN ('monthly','quarterly','bi-annual','annual')),
  contract_ref          VARCHAR(120),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_herd_leases_animal ON herd_leases(animal_id);
CREATE INDEX IF NOT EXISTS idx_herd_leases_user   ON herd_leases(user_id);
CREATE INDEX IF NOT EXISTS idx_herd_leases_lender ON herd_leases(lender_name);

CREATE TABLE IF NOT EXISTS herd_lease_payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id      UUID NOT NULL REFERENCES herd_leases(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_tzs    INTEGER NOT NULL,
  pay_date      DATE    NOT NULL,
  method        VARCHAR(40),
  ref           VARCHAR(120),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_herd_payments_lease ON herd_lease_payments(lease_id);
CREATE INDEX IF NOT EXISTS idx_herd_payments_user  ON herd_lease_payments(user_id);

-- Auto-update herd_animals.updated_at
CREATE OR REPLACE FUNCTION set_herd_animals_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_herd_animals_updated_at ON herd_animals;
CREATE TRIGGER trg_herd_animals_updated_at
  BEFORE UPDATE ON herd_animals
  FOR EACH ROW EXECUTE FUNCTION set_herd_animals_updated_at();

-- Auto-update herd_leases.updated_at
CREATE OR REPLACE FUNCTION set_herd_leases_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_herd_leases_updated_at ON herd_leases;
CREATE TRIGGER trg_herd_leases_updated_at
  BEFORE UPDATE ON herd_leases
  FOR EACH ROW EXECUTE FUNCTION set_herd_leases_updated_at();

-- Track migration
INSERT INTO schema_migrations(filename) VALUES('006_herd.sql')
  ON CONFLICT DO NOTHING;

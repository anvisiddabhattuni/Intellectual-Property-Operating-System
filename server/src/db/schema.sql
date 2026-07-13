-- IPOS R0 schema: thin walking-skeleton slice, tenant-scoped from day one
-- so multi-tenancy (R1+, REQ-005) does not require a retrofit.

CREATE TABLE IF NOT EXISTS tenants (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('author', 'tenant_admin', 'super_admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mock publishing-platform sales data (R0 uses seeded data; real platform
-- integrations replace the seed in R1 without changing this shape).
CREATE TABLE IF NOT EXISTS sales (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  platform    TEXT NOT NULL,
  title       TEXT NOT NULL,
  sale_date   DATE NOT NULL,
  units       INTEGER NOT NULL CHECK (units >= 0),
  revenue     NUMERIC(10,2) NOT NULL CHECK (revenue >= 0),
  royalty     NUMERIC(10,2) NOT NULL CHECK (royalty >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per platform/title/day so daily refreshes upsert instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS sales_daily_unique
  ON sales (tenant_id, platform, title, sale_date);

-- STORY-004: every scheduler/manual refresh is recorded here (read-model for
-- the dashboard freshness display and the admin data-ops panel).
CREATE TABLE IF NOT EXISTS refresh_runs (
  id          SERIAL PRIMARY KEY,
  trigger     TEXT NOT NULL CHECK (trigger IN ('schedule', 'boot-catchup', 'manual')),
  status      TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  detail      JSONB NOT NULL DEFAULT '{}'
);

-- STORY-004: failed refreshes raise an alert for manual intervention.
CREATE TABLE IF NOT EXISTS alerts (
  id          SERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  message     TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}',
  resolved    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit log (TBI: Transparent + Observability).
-- No UPDATE/DELETE is ever issued by the app; triggers enforce append-only.
CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  tenant_id  INTEGER REFERENCES tenants(id),
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

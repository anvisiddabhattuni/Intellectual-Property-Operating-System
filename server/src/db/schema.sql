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

-- STORY-005: predefined contractual terms — the source of truth for royalty
-- math. Platform-reported royalty (sales.royalty) is kept separately; the
-- calculated figure below is what authors are actually owed.
CREATE TABLE IF NOT EXISTS contracts (
  id             SERIAL PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id),
  title          TEXT NOT NULL,
  platform       TEXT NOT NULL,
  royalty_rate   NUMERIC(5,4) NOT NULL CHECK (royalty_rate > 0 AND royalty_rate <= 1),
  effective_from DATE NOT NULL DEFAULT '2000-01-01',
  UNIQUE (tenant_id, title, platform, effective_from)
);

-- STORY-005: calculated royalty statements, one line per
-- tenant/month/title/platform. Recalculation upserts (idempotent read-model).
CREATE TABLE IF NOT EXISTS royalty_calculations (
  id               SERIAL PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id),
  period_start     DATE NOT NULL,
  title            TEXT NOT NULL,
  platform         TEXT NOT NULL,
  units            INTEGER NOT NULL,
  revenue          NUMERIC(12,2) NOT NULL,
  royalty_rate     NUMERIC(5,4),
  royalty_amount   NUMERIC(12,2),
  missing_contract BOOLEAN NOT NULL DEFAULT false,
  calculated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start, title, platform)
);

-- STORY-006: author payouts with an approval gate. A payout above the
-- configured threshold is HELD (pending_approval) until a human decides;
-- the full lifecycle stays in this one table so history is never lost.
CREATE TABLE IF NOT EXISTS payouts (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  period_start  DATE NOT NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status        TEXT NOT NULL CHECK (status IN
                  ('pending_approval', 'paid', 'rejected', 'failed')),
  threshold     NUMERIC(12,2) NOT NULL,
  requested_by  TEXT NOT NULL,
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  provider_ref  TEXT,
  detail        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live payout per tenant-month; rejected/failed attempts may be retried.
CREATE UNIQUE INDEX IF NOT EXISTS payouts_one_live_per_period
  ON payouts (tenant_id, period_start)
  WHERE status IN ('pending_approval', 'paid');

-- STORY-007: AI revenue forecasts. Each forecast is held for human review
-- (approval gate) before authors can see and act on it.
CREATE TABLE IF NOT EXISTS forecasts (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  method        TEXT NOT NULL,
  horizon_days  INTEGER NOT NULL,
  confidence    NUMERIC(4,3) NOT NULL DEFAULT 0.95,
  status        TEXT NOT NULL CHECK (status IN ('pending_review', 'approved', 'rejected')),
  input_summary JSONB NOT NULL,
  points        JSONB NOT NULL,
  total         NUMERIC(12,2) NOT NULL,
  total_lower   NUMERIC(12,2) NOT NULL,
  total_upper   NUMERIC(12,2) NOT NULL,
  generated_by  TEXT NOT NULL,
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- STORY-008: detected revenue anomalies. Born 'open' and routed to a human
-- (escalation) — the system never acts on an anomaly by itself.
CREATE TABLE IF NOT EXISTS anomalies (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
  method       TEXT NOT NULL,
  metric       TEXT NOT NULL,
  platform     TEXT,
  day          DATE NOT NULL,
  observed     NUMERIC(12,2) NOT NULL,
  expected     JSONB NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  reviewed_by  TEXT,
  reviewed_at  TIMESTAMPTZ,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT: platform is NULL for whole-tenant metrics, and a
  -- re-scan must not re-flag the same day (plain UNIQUE treats NULLs as
  -- always-distinct).
  UNIQUE NULLS NOT DISTINCT (tenant_id, method, metric, platform, day)
);

-- STORY-009: AI marketing recommendations. Same approval gate as forecasts:
-- authors only ever see recommendations a human approved.
CREATE TABLE IF NOT EXISTS marketing_recommendations (
  id             SERIAL PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id),
  provider       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending_review', 'approved', 'rejected')),
  recommendations JSONB NOT NULL,
  filtered_out   INTEGER NOT NULL DEFAULT 0,
  input_summary  JSONB NOT NULL,
  generated_by   TEXT NOT NULL,
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

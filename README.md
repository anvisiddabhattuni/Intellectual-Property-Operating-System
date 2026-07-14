# IPOS — Intellectual Property Operating System

Multi-tenant platform that helps authors manage and grow their book revenue.
Built story-by-story from the Basecamp backlog (Colaberry internship project).

**Shipped so far:**
- **R0 — Walking Skeleton:** a thin end-to-end slice: React dashboard →
  Node/Express API (JWT auth + RBAC) → PostgreSQL, with an append-only audit
  log as the first Trust-Before-Intelligence (TBI) control. Sales data is
  seeded mock data for *Trust Before Intelligence*; real platform
  integrations arrive with STORY-001..003.
- **STORY-008 — Revenue Anomaly Detection:** two transparent detectors run
  automatically after every data refresh (so findings land well inside the
  24-hour bar): `robust-zscore-v1` flags daily-revenue outliers against the
  tenant's own history (median + MAD, |z| > 3.5), and `royalty-gap-v1`
  flags months where the platform-reported royalty differs from the
  contract-calculated figure by >1% (>5% = critical). Findings are stored
  `open` and **escalate to a human** — admins get an in-app alert and a
  review panel (mark reviewed / dismiss); the system never acts on an
  anomaly by itself. Every scan and decision is audit-logged with method
  and data. Also hardened the API: async route errors now return 500
  instead of crashing the server process.
- **STORY-007 — AI Revenue Forecasts:** the AI Insights Agent fits a
  transparent trend model (`ols-trend-v1`) to daily revenue and produces a
  30-day forecast with a true 95% prediction interval (t-distribution,
  per-day bounds that widen with distance from the data). Forecasts are
  born `pending_review` — an admin approves or rejects, and **authors only
  ever see approved forecasts** (dashboard chart: actuals solid, forecast
  dashed, interval band, hover tooltips). Every generation is audit-logged
  with the input summary, model coefficients, confidence level, and interval.
  The math is isolated behind `generateForecast()` so a heavier model can
  swap in without touching API/storage/approval.
- **STORY-006 — Payout Processing with Approval Gates:** payouts of a
  month's calculated royalties are initiated by an admin; any amount above
  the configurable threshold (`PAYOUT_APPROVAL_THRESHOLD`, default $1,000)
  is HELD as `pending_approval` until a human approves or rejects it in the
  dashboard. Approval processes the payment through the provider adapter —
  real Stripe when `STRIPE_SECRET_KEY` is set, otherwise a clearly-labeled
  simulated provider (`sim_` references, "simulated" chip in the UI).
  Guards: no duplicate live payout per month (rejected attempts may be
  retried), no paying a month with unpriced statement lines, no deciding a
  payout that isn't pending. Every transition (`payout.held`, `.approved`,
  `.rejected`, `.processed`, `.failed`) is audit-logged with actor and amount.
- **STORY-005 — Royalty Calculation Automation:** a `contracts` table holds
  the predefined terms (rate per title × platform); the calculation engine
  applies them to sales and materializes monthly statements in
  `royalty_calculations` (idempotent upsert), recalculated automatically
  after every successful data refresh. Statements with per-title breakdowns
  render on the dashboard (`GET /api/royalties`); sales lines with no
  contract terms are flagged and raise an alert rather than being priced by
  a default rate. Every calculation writes an audit entry with inputs,
  per-line results, and timestamp. Verified exact against an independent
  SQL cross-check (0.00 error, criterion is ±0.5%).
- **STORY-004 — Daily Data Refresh Scheduler:** a cron-driven refresh engine
  (daily at 02:00, `REFRESH_CRON` to override) pulls from every registered
  platform connector and upserts into Postgres. A boot catch-up run fires if
  the last successful refresh is >24h old. Every run is recorded in
  `refresh_runs` + the audit log; failures raise an alert for manual
  intervention. Admins get a data-ops panel (run history, freshness,
  "Refresh now", simulated-failure demo); everyone sees data freshness.

## Stack

- **Frontend:** React 18 + Vite + Material-UI (`client/`)
- **Backend:** Node.js 22 + Express, JWT auth, role-based access control (`server/`)
- **Database:** PostgreSQL 17 (tenant-scoped schema from day one)
- **Containers:** Docker Compose (db + api + web)

## Run it — Docker (one command)

```bash
docker compose up --build
```

Then open http://localhost:5173.

## Run it — local dev (no Docker)

Requires Node 22+ and PostgreSQL running locally with a `ipos` role/database:

```bash
createuser ipos --pwprompt        # password: ipos_dev_password
createdb -O ipos ipos
```

```bash
# 1. API (terminal 1)
cd server && npm install
npm run db:init                   # applies schema + seeds demo data
npm start                         # http://localhost:4000

# 2. Web (terminal 2)
cd client && npm install
npm run dev                       # http://localhost:5173
```

## Demo script (R0 acceptance)

1. Open http://localhost:5173 — you get the sign-in screen.
2. Sign in as the author: `ram@ipos.demo` / `author123`.
   The dashboard shows 30 days of sales for *Trust Before Intelligence*
   across Amazon KDP, Barnes & Noble, and Kobo — units, revenue, and
   royalties — served by the API from PostgreSQL.
3. Sign out. Sign in as the admin: `admin@ipos.demo` / `admin123`.
   Same dashboard **plus** the audit-log panel (admin-only — this is RBAC
   working: authors get HTTP 403 on `/api/audit`).
4. Trust check: the audit log shows every login and every sales read
   (who / what / when). The table is append-only — `UPDATE`/`DELETE` are
   rejected by a database trigger.

### API quick check

```bash
curl -s localhost:4000/api/health
TOKEN=$(curl -s -X POST localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ram@ipos.demo","password":"author123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:4000/api/sales -H "Authorization: Bearer $TOKEN"
curl -s localhost:4000/api/audit -H "Authorization: Bearer $TOKEN"   # 403 — author role
```

## Trust (TBI) controls

| Control | Implementation |
|---|---|
| Audit log | `audit_log` table, append-only (trigger-enforced), written on login, failed login, every sales read, every refresh run, and every alert raised |
| Permitted (RBAC) | JWT carries role; `/api/audit` and `POST /api/refresh` require `tenant_admin`/`super_admin` |
| Alerting / escalation | Failed refreshes insert an `alerts` row surfaced to admins in the UI (manual intervention path) |
| Tenant isolation (seeded early) | Every table carries `tenant_id`; queries filter by the caller's tenant |

## STORY-004 demo script

1. Sign in as `admin@ipos.demo` — note the freshness banner ("Data last
   refreshed X min ago") and the **Data operations** panel with run history.
2. Click **Refresh now** — a new `manual` run appears as `succeeded`,
   freshness resets, and the audit log gains `refresh.manual` + `refresh.run`.
3. Click **Simulate Kobo failure** — the run shows `failed`
   (Amazon ✓ · B&N ✓ · Kobo ✗), a red alert banner appears
   ("manual intervention required"), and the audit log gains
   `refresh.error` + `alert.raised`.
4. The daily schedule itself: the server logs
   `Refresh scheduler active (cron: "0 2 * * *")` on boot, and a
   `boot-catchup` run fires automatically whenever the last success is >24h
   old (so a laptop asleep at 02:00 still meets the 24h freshness promise).

## Repo layout

```
client/   React + Vite + MUI dashboard
server/   Express API, schema, seed, audit writer
docker-compose.yml
```

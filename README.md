# IPOS — Intellectual Property Operating System

Multi-tenant platform that helps authors manage and grow their book revenue.
Built story-by-story from the Basecamp backlog (Colaberry internship project).

**Shipped so far:**
- **R0 — Walking Skeleton:** a thin end-to-end slice: React dashboard →
  Node/Express API (JWT auth + RBAC) → PostgreSQL, with an append-only audit
  log as the first Trust-Before-Intelligence (TBI) control. Sales data is
  seeded mock data for *Trust Before Intelligence*; real platform
  integrations arrive with STORY-001..003.
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

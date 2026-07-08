# IPOS — Intellectual Property Operating System

Multi-tenant platform that helps authors manage and grow their book revenue.
Built story-by-story from the Basecamp backlog (Colaberry internship project).

**Current release: R0 — Walking Skeleton.** A thin end-to-end slice:
React dashboard → Node/Express API (JWT auth + RBAC) → PostgreSQL, with an
append-only audit log as the first Trust-Before-Intelligence (TBI) control.
Sales data is seeded mock data for *Trust Before Intelligence*; real platform
integrations arrive in R1.

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

## Trust (TBI) controls in R0

| Control | Implementation |
|---|---|
| Audit log | `audit_log` table, append-only (trigger-enforced), written on login, failed login, and every sales read |
| Permitted (RBAC) | JWT carries role; `/api/audit` requires `tenant_admin`/`super_admin` |
| Tenant isolation (seeded early) | Every table carries `tenant_id`; queries filter by the caller's tenant |

## Repo layout

```
client/   React + Vite + MUI dashboard
server/   Express API, schema, seed, audit writer
docker-compose.yml
```

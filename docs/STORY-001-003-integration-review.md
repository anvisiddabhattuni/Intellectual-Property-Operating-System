# Review — STORY-001 / 002 / 003: Platform Sales & Royalty Integrations

**Stories:** Integrate Amazon (001), Barnes & Noble (002), Kobo (003) sales and royalty data.
**Owner agent:** Data Integration Specialist · **Fulfills:** REQ-001, REQ-002
**Status:** Not started — held for a data-access decision (this review is the input to that decision).
**Reviewer:** Claude Code · **Date:** 2026-07-14

---

## TL;DR

All three stories are the *same* story pointed at three platforms: connect to the platform,
pull sales + royalty data daily (≤24h latency), validate it, store it, show it. **The pipeline
they plug into already exists** — it was built in R1 (STORY-004..010): a connector registry with
a stable contract, a daily scheduler, validation and audit surfaces, alerting, and per-tenant
isolation. Swapping the current mock connectors for real ones is the whole job.

The blocker is **not** engineering effort — it's **data access**. As of current knowledge, none of
Amazon KDP, Barnes & Noble Press, or Kobo Writing Life expose a public, real-time, per-author
**sales API**. Authors get their numbers through **dashboard report exports** (CSV/XLSX), and in
some cases scheduled email reports. So the literal acceptance premise — *"Given the system is
connected to \<platform\>'s API"* — cannot be met the way the ticket assumes for the author persona.

**Recommendation:** build one **report-ingestion connector** (upload/drop a platform's exported
sales report → parse → validate → store through the existing pipeline). It satisfies all three
stories' real intent (author's revenue appears in the unified dashboard, daily, validated,
audited), needs **no external credentials to start**, and is the path real author-analytics tools
actually use. Decision needed from Ram: confirm this direction and the per-platform data source.

---

## 1. What these three stories actually ask for

Identical Gherkin across all three (platform name swapped):

- **Successful integration** — *Given* connected to \<platform\>'s API; *When* the agent fetches
  sales + royalty data; *Then* it's shown in the unified dashboard with ≤24-hour latency.
- **Data integrity check** — *Given* data is fetched; *When* processed; *Then* it's verified for
  accuracy and completeness before display.
- **Trust (TBI):** audit-log the fetch actions; log the integrity checks.

## 2. Readiness — what's already built that these plug into

R1 deliberately built the aggregation pipeline platform-agnostic, so the integrations are a
drop-in. Mapping each acceptance requirement to existing infrastructure:

| Requirement in 001–003 | Already built | Where |
|---|---|---|
| A connector per platform | Connector **registry + contract** (`{ platform, fetchDaily(tenantId) → SaleRow[] }`); Amazon/B&N/Kobo mocks implement it today | `server/src/connectors/` |
| Pull daily, ≤24h latency | **Daily cron scheduler** + boot catch-up if data >24h old | `server/src/scheduler.js`, `refresh.js` |
| Store in PostgreSQL | Idempotent upsert into `sales` (unique on tenant/platform/title/date) | `refresh.js` |
| Validate before display | Numeric/'>=0' **column constraints**; per-run result recorded; failed platforms don't land | `schema.sql`, `refresh.js` |
| Audit the fetch | Every run writes `refresh.run` / `refresh.error` to the append-only audit log | `refresh.js`, `audit.js` |
| Alert on failure | Failed fetch → `alerts` row + admin banner | `refresh.js` |
| Per-tenant isolation | Each tenant's connector fetches only that tenant's catalog; RLS backstop | `connectors/mock.js`, STORY-010 |
| Show in dashboard | Sales/royalty views, per-platform totals | `client/src/Dashboard.jsx` |

**So the remaining work per platform is narrow:** (a) obtain the data, (b) map that platform's
fields to `SaleRow`, (c) add platform-specific validation, (d) surface a per-fetch integrity log.

## 3. Feasibility per platform (the real blocker)

The acceptance criteria assume a live "\<platform\> API." For the **author** persona, that
assumption does not hold as of current knowledge:

| Platform | Real-time per-author sales API? | How authors actually get data | Practical ingestion path |
|---|---|---|---|
| **Amazon KDP** | No public author sales API | KDP dashboard + downloadable reports (sales/royalty exports; KDP Reports) | Scheduled CSV/XLSX export upload |
| **Barnes & Noble Press** | No public API | B&N Press dashboard sales reports (export) | CSV export upload |
| **Kobo Writing Life** | No public author API (partner feeds exist for aggregators, not individual authors) | KWL dashboard CSV exports | CSV export upload |

Consequence: a demo that claims "connected to Amazon's API" would be misleading. The honest,
buildable equivalent that satisfies the *intent* is **report ingestion**.

## 4. Recommended approach — a report-ingestion connector

Build a generic **report ingestion** path that plugs into the existing connector registry:

1. **Upload/drop** — an admin uploads a platform's exported sales report (CSV/XLSX), or drops it
   in a per-tenant watched folder / emails it to a per-tenant address (phase 2).
2. **Parse + map** — a platform-specific parser maps that report's columns to `SaleRow`
   (`title, sale_date, units, revenue, royalty`).
3. **Validate** — reject rows failing integrity checks (negative/absent units or revenue,
   duplicate rows, dates outside the report window); record a per-file integrity summary.
4. **Store + audit** — upsert through the existing refresh pipeline (idempotent, so re-uploading
   the same report is safe); write `integration.ingest` + integrity results to the audit log.
5. **Display** — no dashboard change needed; the data flows into the existing views.

This reuses ~90% of what STORY-004..010 already built and is exactly how real author-analytics
products (e.g. royalty dashboards) ingest KDP/B&N/Kobo data today.

## 5. Options for Ram (the decision)

| Option | What it means | Effort | External deps | Recommendation |
|---|---|---|---|---|
| **A. Report-ingestion connectors (CSV)** | Upload/parse each platform's exported report | ~1–2 stories of work; reuses the pipeline | None to start | ✅ **Recommended** — buildable now, honest, matches how the data really flows |
| **B. Wait for real APIs / partnerships** | Pursue official data-feed access per platform | Unknown; depends on the platforms | Business agreements, credentials | Park — pursue in parallel if the platforms offer author feeds |
| **C. Hybrid** | Ship A now; swap a platform to a real feed if/when one is granted (the connector contract makes this a drop-in) | A now + later | Later | Good default: A gives value now, C keeps the door open |

Because the connector contract is stable, **choosing A does not foreclose B** — a real feed later
is a one-file connector swap, no pipeline change.

## 6. Risks

- **Report format drift** — platforms change their export columns. Mitigation: per-platform
  parser with a validation layer that fails loudly (audit + alert) rather than storing garbage.
- **Currency / royalty semantics** — platforms report royalties differently (some pre-tax, some
  net). Mitigation: store the platform-*reported* figure separately from our *contract-calculated*
  royalty (already the STORY-005 design) so discrepancies surface via anomaly detection (STORY-008).
- **Manual upload friction** — phase 1 requires an admin to upload exports. Mitigation: phase 2
  automation (email-in / SFTP / watched folder) once the parsers are proven.
- **"API" wording in acceptance** — the ticket says "connected to the API." Recommend Ram approve
  re-reading acceptance as "connected to the platform's sales data" so the demo is truthful.

## 7. If approved — proposed build order

1. `csvConnector(platform, parserSpec)` implementing the registry contract, + an admin
   `POST /api/integrations/:platform/upload` endpoint (RBAC: admin only).
2. Amazon KDP parser + validation + integrity log → **STORY-001**.
3. Barnes & Noble parser → **STORY-002**. 4. Kobo parser → **STORY-003**.
5. Test suite: sample-report fixtures → assert parsed/validated rows; a malformed-report fixture
   → assert rejection + alert.

Each is small because the pipeline, storage, audit, alerting, dashboard, and multi-tenant
isolation already exist.

## 8. Traceability

- REQ-001 (aggregate ≥3 platforms, ≤24h) — pipeline done (STORY-004); connectors are the
  remaining piece (001–003).
- REQ-002 (royalty accuracy + breakdown) — done (STORY-005); consumes whatever these connectors
  land.
- Trust (TBI) — audit + validation + alerting surfaces already exist; the integrity-check log is
  the new per-story addition.

---

*This review is a decision input, not a completed story. No integration code has been written;
the three stories remain open pending Ram's direction on Section 5.*

// Mock connector: simulates a platform's daily sales report until the real
// integrations (STORY-001..003) land. Returns rows for yesterday and today,
// like a real daily report pull would.
//
// Tenant-aware: a real platform connector fetches the books that belong to
// THIS tenant's account. The mock mirrors that by looking up the tenant's own
// title, so a refresh never writes one tenant's book into another's data
// (multi-tenant isolation, STORY-010).
//
// Set FAIL_PLATFORMS="Kobo,Barnes & Noble" (or pass simulateFailure to the
// refresh engine) to force a fetch error and demo the alerting path.
import pool from '../db/pool.js';

const failList = (process.env.FAIL_PLATFORMS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

export function mockConnector(platform, unitPrice) {
  return {
    platform,
    async fetchDaily(tenantId) {
      if (failList.includes(platform)) {
        throw new Error(`${platform}: upstream API unavailable (simulated via FAIL_PLATFORMS)`);
      }
      // The tenant's own catalog — never a hardcoded title.
      const { rows: [book] } = await pool.query(
        `SELECT title FROM sales WHERE tenant_id = $1 ORDER BY sale_date DESC LIMIT 1`,
        [tenantId]
      );
      const title = book?.title || 'Untitled';

      const rows = [];
      for (const daysAgo of [1, 0]) {
        const d = new Date();
        d.setDate(d.getDate() - daysAgo);
        const units = 3 + Math.floor(Math.random() * 12);
        const revenue = +(units * unitPrice).toFixed(2);
        rows.push({
          title,
          sale_date: d.toISOString().slice(0, 10),
          units,
          revenue,
          royalty: +(revenue * 0.7).toFixed(2)
        });
      }
      return rows;
    }
  };
}

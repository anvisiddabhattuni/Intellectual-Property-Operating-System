import pool from './db/pool.js';
import { audit } from './audit.js';

// Royalty Calculation Agent (STORY-005).
//
// Applies contractual terms (contracts table) to sales data and materializes
// monthly statements in royalty_calculations. The platform-reported royalty
// on sales rows is ignored here on purpose: the contract is the source of
// truth for what the author is owed.
//
// Rounding policy: each line (month x title x platform) is rounded to the
// cent; totals are sums of rounded lines, so displayed figures always add up.
export async function recalcRoyalties(tenantId, { trigger = 'manual' } = {}) {
  // One line per month/title/platform, joined to the newest contract whose
  // effective_from is on or before the month. No contract -> rate is NULL.
  const { rows: lines } = await pool.query(
    `SELECT date_trunc('month', s.sale_date)::date AS period_start,
            s.title, s.platform,
            SUM(s.units)::int AS units,
            SUM(s.revenue)::numeric(12,2) AS revenue,
            c.royalty_rate,
            ROUND(SUM(s.revenue) * c.royalty_rate, 2) AS royalty_amount
     FROM sales s
     LEFT JOIN LATERAL (
       SELECT royalty_rate FROM contracts c
       WHERE c.tenant_id = s.tenant_id AND c.title = s.title
         AND c.platform = s.platform
         AND c.effective_from <= s.sale_date
       ORDER BY c.effective_from DESC LIMIT 1
     ) c ON true
     WHERE s.tenant_id = $1
     GROUP BY 1, 2, 3, c.royalty_rate
     ORDER BY 1 DESC, 2, 3`,
    [tenantId]
  );

  for (const l of lines) {
    await pool.query(
      `INSERT INTO royalty_calculations
         (tenant_id, period_start, title, platform, units, revenue,
          royalty_rate, royalty_amount, missing_contract, calculated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (tenant_id, period_start, title, platform)
       DO UPDATE SET units = EXCLUDED.units, revenue = EXCLUDED.revenue,
                     royalty_rate = EXCLUDED.royalty_rate,
                     royalty_amount = EXCLUDED.royalty_amount,
                     missing_contract = EXCLUDED.missing_contract,
                     calculated_at = now()`,
      [tenantId, l.period_start, l.title, l.platform, l.units, l.revenue,
       l.royalty_rate, l.royalty_amount, l.royalty_rate == null]
    );
  }

  const missing = lines.filter((l) => l.royalty_rate == null);
  await audit({
    tenantId,
    actor: 'royalty-agent',
    action: 'royalty.calculated',
    detail: {
      trigger,
      input: { salesLines: lines.length, months: new Set(lines.map((l) => String(l.period_start))).size },
      results: lines.map((l) => ({
        period: l.period_start, title: l.title, platform: l.platform,
        revenue: l.revenue, rate: l.royalty_rate, royalty: l.royalty_amount
      })),
      missingContracts: missing.length
    }
  });

  // Money must never be computed from a guess: unpriced lines raise an alert
  // for manual intervention instead of falling back to a default rate.
  if (missing.length > 0) {
    await pool.query(
      `INSERT INTO alerts (source, message, detail) VALUES ('royalty', $1, $2)`,
      [
        `Royalty calculation found ${missing.length} sales line(s) with no contract terms — manual intervention required`,
        JSON.stringify({ tenantId, lines: missing.map((l) => ({ period: l.period_start, title: l.title, platform: l.platform })) })
      ]
    );
    await audit({ tenantId, actor: 'royalty-agent', action: 'alert.raised', detail: { reason: 'missing contract terms', count: missing.length } });
  }

  return { lines: lines.length, missingContracts: missing.length };
}

export async function recalcAllTenants({ trigger } = {}) {
  const { rows: tenants } = await pool.query('SELECT id FROM tenants');
  for (const t of tenants) await recalcRoyalties(t.id, { trigger });
}

// Read-model: monthly statements with per-title breakdown lines.
export async function royaltyStatements(tenantId) {
  const { rows } = await pool.query(
    `SELECT period_start, title, platform, units, revenue,
            royalty_rate, royalty_amount, missing_contract, calculated_at
     FROM royalty_calculations
     WHERE tenant_id = $1
     ORDER BY period_start DESC, title, platform`,
    [tenantId]
  );
  return rows;
}

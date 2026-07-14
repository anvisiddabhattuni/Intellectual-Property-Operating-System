import pool from './db/pool.js';
import { audit } from './audit.js';

// AI Insights Agent — anomaly detection (STORY-008).
//
// Two transparent detectors, both explainable to an auditor:
//   1. robust-zscore-v1  — daily total revenue vs the tenant's own history,
//      using median + MAD so an outlier can't mask itself by skewing the mean.
//      |modified z| > 3.5 flags (warning), > 5 is critical.
//   2. royalty-gap-v1    — platform-REPORTED royalty vs contract-CALCULATED
//      royalty per statement month. Relative gap > 1% flags (warning),
//      > 5% is critical. This is money misreported, so it matters most.
//
// Escalation (TBI): anomalies are stored 'open' and require a human decision
// (reviewed/dismissed). Detection never triggers any automatic action.

const Z_FLAG = 3.5, Z_CRIT = 5, GAP_FLAG = 0.01, GAP_CRIT = 0.05;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function revenueOutliers(tenantId) {
  const { rows } = await pool.query(
    `SELECT sale_date::date::text AS day, SUM(revenue)::float AS revenue
     FROM sales WHERE tenant_id = $1
       AND sale_date >= CURRENT_DATE - INTERVAL '365 days'
     GROUP BY 1 ORDER BY 1`,
    [tenantId]
  );
  if (rows.length < 14) return [];

  const values = rows.map((r) => r.revenue);
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  if (mad === 0) return []; // perfectly uniform history — nothing to compare against

  return rows.flatMap((r) => {
    const z = (0.6745 * (r.revenue - med)) / mad;
    if (Math.abs(z) <= Z_FLAG) return [];
    return [{
      method: 'robust-zscore-v1',
      metric: 'daily_revenue',
      platform: null,
      day: r.day,
      observed: r.revenue.toFixed(2),
      expected: { median: +med.toFixed(2), mad: +mad.toFixed(2), zScore: +z.toFixed(2), flagAbove: Z_FLAG },
      severity: Math.abs(z) > Z_CRIT ? 'critical' : 'warning'
    }];
  });
}

async function royaltyGaps(tenantId) {
  const { rows } = await pool.query(
    `SELECT rc.period_start::text AS period_start, rc.platform, rc.royalty_amount AS calculated,
            SUM(s.royalty)::numeric(12,2) AS reported
     FROM royalty_calculations rc
     JOIN sales s ON s.tenant_id = rc.tenant_id AND s.platform = rc.platform
       AND s.title = rc.title AND date_trunc('month', s.sale_date)::date = rc.period_start
     WHERE rc.tenant_id = $1 AND NOT rc.missing_contract
     GROUP BY 1, 2, rc.royalty_amount`,
    [tenantId]
  );
  return rows.flatMap((r) => {
    const gap = (Number(r.reported) - Number(r.calculated)) / Number(r.calculated);
    if (Math.abs(gap) <= GAP_FLAG) return [];
    return [{
      method: 'royalty-gap-v1',
      metric: 'reported_vs_calculated_royalty',
      platform: r.platform,
      day: r.period_start,
      observed: r.reported,
      expected: { calculatedFromContract: r.calculated, relativeGap: +(gap * 100).toFixed(2) + '%', flagAbovePct: GAP_FLAG * 100 },
      severity: Math.abs(gap) > GAP_CRIT ? 'critical' : 'warning'
    }];
  });
}

export async function detectAnomalies(tenantId, { trigger = 'manual' } = {}) {
  const found = [...await revenueOutliers(tenantId), ...await royaltyGaps(tenantId)];

  let fresh = 0;
  for (const a of found) {
    const { rowCount } = await pool.query(
      `INSERT INTO anomalies (tenant_id, method, metric, platform, day, observed, expected, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, method, metric, platform, day) DO NOTHING`,
      [tenantId, a.method, a.metric, a.platform, a.day, a.observed, JSON.stringify(a.expected), a.severity]
    );
    fresh += rowCount;
  }

  await audit({
    tenantId, actor: 'ai-insights-agent', action: 'anomaly.scan',
    detail: { trigger, methods: ['robust-zscore-v1', 'royalty-gap-v1'], found: found.length, new: fresh, anomalies: found }
  });

  // Escalation: new findings raise an in-app alert for the humans to review.
  if (fresh > 0) {
    await pool.query(
      `INSERT INTO alerts (source, message, detail) VALUES ('anomaly', $1, $2)`,
      [`${fresh} new revenue anomal${fresh === 1 ? 'y' : 'ies'} detected — human review required`,
       JSON.stringify({ tenantId, trigger, count: fresh })]
    );
    await audit({ tenantId, actor: 'ai-insights-agent', action: 'alert.raised', detail: { reason: 'anomalies detected', count: fresh } });
  }

  return { found: found.length, new: fresh };
}

// Human decision on an open anomaly (escalation resolution).
export async function reviewAnomaly({ anomalyId, action, reviewedBy }) {
  const { rows: [anomaly] } = await pool.query(
    `UPDATE anomalies SET status = $1, reviewed_by = $2, reviewed_at = now()
     WHERE id = $3 AND status = 'open' RETURNING *`,
    [action, reviewedBy, anomalyId]
  );
  if (!anomaly) return { error: 'Anomaly not found or already handled' };
  await audit({
    tenantId: anomaly.tenant_id, actor: reviewedBy, action: `anomaly.${action}`,
    detail: { anomalyId: anomaly.id, method: anomaly.method, platform: anomaly.platform, day: anomaly.day }
  });
  return { anomaly };
}

export async function listAnomalies(tenantId) {
  const { rows } = await pool.query(
    `SELECT * FROM anomalies WHERE tenant_id = $1
     ORDER BY status = 'open' DESC, severity = 'critical' DESC, day DESC LIMIT 100`,
    [tenantId]
  );
  return rows;
}

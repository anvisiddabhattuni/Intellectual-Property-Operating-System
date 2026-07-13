import pool from './db/pool.js';
import { audit } from './audit.js';

// AI Insights Agent — revenue forecasting (STORY-007).
//
// Method: ordinary-least-squares trend on daily revenue with a true 95%
// prediction interval (t-distribution, per-day standard error that widens
// with distance from the observed data). Deliberately transparent — every
// number is explainable — and isolated behind generateForecast() so a
// heavier model (ARIMA/Prophet/NN) can replace the math without touching
// the API, storage, or approval flow.

// Two-sided 95% critical values of Student's t by degrees of freedom.
const T_95 = [
  [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447],
  [7, 2.365], [8, 2.306], [9, 2.262], [10, 2.228], [12, 2.179], [15, 2.131],
  [20, 2.086], [25, 2.060], [30, 2.042], [40, 2.021], [60, 2.000], [120, 1.980]
];
const tCrit = (df) => {
  let t = 1.96;
  for (const [d, v] of T_95) if (df <= d) return v; else t = v;
  return Math.min(t, 1.96 + (2.042 - 1.96) * (120 / Math.max(df, 120)));
};

const MIN_DAYS = 14;

export async function generateForecast({ tenantId, horizonDays = 30, requestedBy }) {
  // Input: up to a year of daily revenue, summed across platforms.
  const { rows: series } = await pool.query(
    `SELECT sale_date::date AS day, SUM(revenue)::float AS revenue
     FROM sales
     WHERE tenant_id = $1 AND sale_date >= CURRENT_DATE - INTERVAL '365 days'
     GROUP BY 1 ORDER BY 1`,
    [tenantId]
  );
  if (series.length < MIN_DAYS) {
    return { error: `Need at least ${MIN_DAYS} days of sales history (have ${series.length})` };
  }

  // OLS fit: revenue = a + b * dayIndex
  const n = series.length;
  const xs = series.map((_, i) => i);
  const ys = series.map((r) => r.revenue);
  const xBar = xs.reduce((a, b) => a + b, 0) / n;
  const yBar = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - xBar) ** 2, 0);
  const sxy = xs.reduce((a, x, i) => a + (x - xBar) * (ys[i] - yBar), 0);
  const b = sxy / sxx;
  const a = yBar - b * xBar;
  const sse = ys.reduce((acc, y, i) => acc + (y - (a + b * xs[i])) ** 2, 0);
  const df = n - 2;
  const s = Math.sqrt(sse / df);
  const t = tCrit(df);

  // Per-day 95% prediction interval, widening with distance from the data.
  const lastDay = new Date(series[n - 1].day);
  const points = [];
  for (let h = 1; h <= horizonDays; h++) {
    const x0 = n - 1 + h;
    const yHat = a + b * x0;
    const se = s * Math.sqrt(1 + 1 / n + ((x0 - xBar) ** 2) / sxx);
    const d = new Date(lastDay);
    d.setDate(d.getDate() + h);
    points.push({
      date: d.toISOString().slice(0, 10),
      revenue: +Math.max(0, yHat).toFixed(2),
      lower: +Math.max(0, yHat - t * se).toFixed(2),
      upper: +Math.max(0, yHat + t * se).toFixed(2)
    });
  }

  const sum = (k) => +points.reduce((acc, p) => acc + p[k], 0).toFixed(2);
  const inputSummary = {
    daysObserved: n,
    from: String(series[0].day).slice(0, 10),
    to: String(series[n - 1].day).slice(0, 10),
    observedTotal: +ys.reduce((x, y) => x + y, 0).toFixed(2),
    model: { intercept: +a.toFixed(4), slopePerDay: +b.toFixed(4), residualSd: +s.toFixed(4), tCritical: t },
    totalBounds: 'conservative (sum of per-day bounds)'
  };

  const { rows: [forecast] } = await pool.query(
    `INSERT INTO forecasts (tenant_id, method, horizon_days, confidence, status,
                            input_summary, points, total, total_lower, total_upper, generated_by)
     VALUES ($1, 'ols-trend-v1', $2, 0.95, 'pending_review', $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [tenantId, horizonDays, JSON.stringify(inputSummary), JSON.stringify(points),
     sum('revenue'), sum('lower'), sum('upper'), requestedBy]
  );

  await audit({
    tenantId, actor: 'ai-insights-agent', action: 'forecast.generated',
    detail: {
      forecastId: forecast.id, confidence: 0.95, horizonDays,
      input: inputSummary, total: forecast.total,
      interval: [forecast.total_lower, forecast.total_upper]
    }
  });

  return { forecast };
}

// Human decision on a pending forecast — the approval gate. Only approved
// forecasts are shown to authors for decision-making.
export async function decideForecast({ forecastId, approve, decidedBy }) {
  const { rows: [forecast] } = await pool.query(
    `UPDATE forecasts SET status = $1, reviewed_by = $2, reviewed_at = now()
     WHERE id = $3 AND status = 'pending_review' RETURNING *`,
    [approve ? 'approved' : 'rejected', decidedBy, forecastId]
  );
  if (!forecast) return { error: 'Forecast not found or not pending review' };
  await audit({
    tenantId: forecast.tenant_id, actor: decidedBy,
    action: approve ? 'forecast.approved' : 'forecast.rejected',
    detail: { forecastId: forecast.id, total: forecast.total }
  });
  return { forecast };
}

// Read-model. Admins see everything (to review); authors see only the
// latest approved forecast — unreviewed AI output never reaches them.
export async function listForecasts(tenantId, { includeUnapproved }) {
  const { rows } = await pool.query(
    includeUnapproved
      ? `SELECT * FROM forecasts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`
      : `SELECT * FROM forecasts WHERE tenant_id = $1 AND status = 'approved'
         ORDER BY created_at DESC LIMIT 1`,
    [tenantId]
  );
  return rows;
}

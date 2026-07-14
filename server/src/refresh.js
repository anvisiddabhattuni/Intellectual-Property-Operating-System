import pool from './db/pool.js';
import connectors from './connectors/index.js';
import { audit } from './audit.js';
import { recalcAllTenants } from './royalty.js';
import { detectAnomalies } from './anomaly.js';

// Runs one refresh cycle across all registered platform connectors.
// Records the run in refresh_runs, audits every step, and raises an alert
// on any connector failure (STORY-004 acceptance #2). A partial failure
// still upserts the platforms that succeeded.
export async function runRefresh({ trigger, simulateFailure = [] } = {}) {
  const { rows: [run] } = await pool.query(
    `INSERT INTO refresh_runs (trigger, status) VALUES ($1, 'running') RETURNING id`,
    [trigger]
  );

  const { rows: tenants } = await pool.query('SELECT id FROM tenants');
  const results = [];
  const errors = [];

  for (const connector of connectors) {
    try {
      if (simulateFailure.includes(connector.platform)) {
        throw new Error(`${connector.platform}: upstream API unavailable (simulated)`);
      }
      let upserted = 0;
      for (const tenant of tenants) {
        const rows = await connector.fetchDaily(tenant.id);
        for (const r of rows) {
          await pool.query(
            `INSERT INTO sales (tenant_id, platform, title, sale_date, units, revenue, royalty)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (tenant_id, platform, title, sale_date)
             DO UPDATE SET units = EXCLUDED.units, revenue = EXCLUDED.revenue, royalty = EXCLUDED.royalty`,
            [tenant.id, connector.platform, r.title, r.sale_date, r.units, r.revenue, r.royalty]
          );
          upserted++;
        }
      }
      results.push({ platform: connector.platform, ok: true, upserted });
    } catch (err) {
      errors.push({ platform: connector.platform, error: err.message });
      results.push({ platform: connector.platform, ok: false, error: err.message });
    }
  }

  const status = errors.length === 0 ? 'succeeded' : 'failed';
  await pool.query(
    `UPDATE refresh_runs SET status = $1, finished_at = now(), detail = $2 WHERE id = $3`,
    [status, JSON.stringify({ trigger, results }), run.id]
  );
  await audit({
    actor: 'scheduler',
    action: status === 'succeeded' ? 'refresh.run' : 'refresh.error',
    detail: { runId: run.id, trigger, results }
  });

  // Fresh sales data invalidates royalty statements — recalculate them
  // automatically (STORY-005), then scan the new data for anomalies
  // (STORY-008). Both run on every ingest, which keeps the "flagged within
  // 24 hours" promise as long as the daily refresh itself runs.
  if (results.some((r) => r.ok)) {
    await recalcAllTenants({ trigger: `refresh:${trigger}` });
    const { rows: tenants } = await pool.query('SELECT id FROM tenants');
    for (const t of tenants) {
      await detectAnomalies(t.id, { trigger: `refresh:${trigger}` });
    }
  }

  if (errors.length > 0) {
    await pool.query(
      `INSERT INTO alerts (source, message, detail)
       VALUES ('refresh', $1, $2)`,
      [
        `Data refresh failed for ${errors.map((e) => e.platform).join(', ')} — manual intervention required`,
        JSON.stringify({ runId: run.id, trigger, errors })
      ]
    );
    await audit({ actor: 'scheduler', action: 'alert.raised', detail: { runId: run.id, errors } });
  }

  return { runId: run.id, status, results };
}

// Freshness read-model for the dashboard.
export async function refreshStatus() {
  const { rows: runs } = await pool.query(
    `SELECT id, trigger, status, started_at, finished_at, detail
     FROM refresh_runs ORDER BY started_at DESC LIMIT 20`
  );
  const { rows: [last] } = await pool.query(
    `SELECT finished_at FROM refresh_runs WHERE status = 'succeeded'
     ORDER BY finished_at DESC LIMIT 1`
  );
  const { rows: alerts } = await pool.query(
    `SELECT id, source, message, detail, created_at FROM alerts
     WHERE resolved = false ORDER BY created_at DESC`
  );
  return {
    lastSuccessfulRefresh: last?.finished_at || null,
    staleHours: last ? (Date.now() - new Date(last.finished_at)) / 36e5 : null,
    runs,
    openAlerts: alerts
  };
}

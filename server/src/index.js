import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pool from './db/pool.js';
import { signToken, requireAuth, requireRole } from './auth.js';
import { audit } from './audit.js';
import { runRefresh, refreshStatus } from './refresh.js';
import { startScheduler } from './scheduler.js';
import { recalcRoyalties, royaltyStatements } from './royalty.js';
import { initiatePayout, decidePayout, listPayouts, APPROVAL_THRESHOLD } from './payout.js';
import { generateForecast, decideForecast, listForecasts } from './forecast.js';
import { detectAnomalies, reviewAnomaly, listAnomalies } from './anomaly.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Express 4 does not catch errors thrown in async handlers — without this,
// one failed query kills the whole server process. Route every rejection
// into the error middleware at the bottom instead.
for (const method of ['get', 'post', 'put', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) =>
    handlers.length === 0
      ? original(path) // app.get('setting') config lookups pass through
      : original(path, ...handlers.map((fn) =>
          (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
        ));
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) {
    await audit({ actor: email, action: 'auth.login.failed', detail: { reason: 'bad credentials' } });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  await audit({ tenantId: user.tenant_id, actor: user.email, action: 'auth.login', detail: { role: user.role } });
  res.json({
    token: signToken(user),
    user: { email: user.email, name: user.name, role: user.role }
  });
});

// Sales for the caller's tenant only — tenant scoping enforced server-side.
app.get('/api/sales', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT platform, title, sale_date, units, revenue, royalty
     FROM sales WHERE tenant_id = $1
     ORDER BY sale_date DESC, platform`,
    [req.user.tenantId]
  );
  const { rows: totals } = await pool.query(
    `SELECT platform,
            SUM(units)::int AS units,
            SUM(revenue)::numeric(12,2) AS revenue,
            SUM(royalty)::numeric(12,2) AS royalty
     FROM sales WHERE tenant_id = $1
     GROUP BY platform ORDER BY platform`,
    [req.user.tenantId]
  );
  await audit({ tenantId: req.user.tenantId, actor: req.user.email, action: 'sales.read', detail: { rows: rows.length } });
  res.json({ sales: rows, totals });
});

// Audit trail is admin-only (RBAC demo: authors get 403 here).
app.get('/api/audit', requireAuth, requireRole('tenant_admin', 'super_admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT actor, action, detail, created_at
     FROM audit_log WHERE tenant_id = $1 OR tenant_id IS NULL
     ORDER BY created_at DESC LIMIT 50`,
    [req.user.tenantId]
  );
  res.json({ audit: rows });
});

// Royalty statements for the caller's tenant (STORY-005 read-model).
app.get('/api/royalties', requireAuth, async (req, res) => {
  res.json({ statements: await royaltyStatements(req.user.tenantId) });
});

// Manual recalculation (admin-only); normally runs automatically after
// every successful data refresh.
app.post('/api/royalties/calculate', requireAuth, requireRole('tenant_admin', 'super_admin'), async (req, res) => {
  await audit({ tenantId: req.user.tenantId, actor: req.user.email, action: 'royalty.recalc.manual', detail: {} });
  res.json(await recalcRoyalties(req.user.tenantId, { trigger: 'manual' }));
});

// Anomalies (STORY-008). Analyst-facing: admins review; the system only
// ever escalates — it takes no automatic action on an anomaly.
app.get('/api/anomalies', requireAuth, requireRole('tenant_admin', 'super_admin'), async (req, res) => {
  res.json({ anomalies: await listAnomalies(req.user.tenantId) });
});

app.post('/api/anomalies/detect', requireAuth, requireRole('tenant_admin', 'super_admin'), async (req, res) => {
  await audit({ tenantId: req.user.tenantId, actor: req.user.email, action: 'anomaly.scan.manual', detail: {} });
  res.json(await detectAnomalies(req.user.tenantId, { trigger: 'manual' }));
});

app.post('/api/anomalies/:id/:action(reviewed|dismissed)', requireAuth, requireRole('tenant_admin', 'super_admin'), async (req, res) => {
  const result = await reviewAnomaly({
    anomalyId: Number(req.params.id), action: req.params.action, reviewedBy: req.user.email
  });
  res.status(result.error ? 409 : 200).json(result);
});

// Forecasts (STORY-007). Authors receive only approved forecasts; admins
// also see pending/rejected ones so they can review.
app.get('/api/forecasts', requireAuth, async (req, res) => {
  const includeUnapproved = ['tenant_admin', 'super_admin'].includes(req.user.role);
  res.json({ forecasts: await listForecasts(req.user.tenantId, { includeUnapproved }) });
});

app.post('/api/forecasts', requireAuth, requireRole('tenant_admin', 'super_admin'), async (req, res) => {
  const horizonDays = Math.min(Math.max(Number(req.body?.horizonDays) || 30, 7), 90);
  const result = await generateForecast({
    tenantId: req.user.tenantId, horizonDays, requestedBy: req.user.email
  });
  res.status(result.error ? 409 : 201).json(result);
});

// The approval gate: unreviewed AI output never reaches authors.
app.post('/api/forecasts/:id/:decision(approve|reject)', requireAuth, requireRole('tenant_admin', 'super_admin'), async (req, res) => {
  const result = await decideForecast({
    forecastId: Number(req.params.id),
    approve: req.params.decision === 'approve',
    decidedBy: req.user.email
  });
  res.status(result.error ? 409 : 200).json(result);
});

// Payout history + the active approval threshold (STORY-006 read-model).
app.get('/api/payouts', requireAuth, async (req, res) => {
  res.json({ payouts: await listPayouts(req.user.tenantId), threshold: APPROVAL_THRESHOLD });
});

// Initiate a payout for one statement month (admin-only). Above-threshold
// amounts are held for approval; below-threshold process immediately.
app.post('/api/payouts', requireAuth, requireRole('tenant_admin', 'super_admin'), async (req, res) => {
  const { periodStart } = req.body || {};
  if (!periodStart) return res.status(400).json({ error: 'periodStart required (YYYY-MM-DD)' });
  const result = await initiatePayout({
    tenantId: req.user.tenantId, periodStart, requestedBy: req.user.email
  });
  res.status(result.error ? 409 : 201).json(result);
});

// Human decision on a held payout (admin-only): the approval gate itself.
app.post('/api/payouts/:id/:decision(approve|reject)', requireAuth, requireRole('tenant_admin', 'super_admin'), async (req, res) => {
  const result = await decidePayout({
    payoutId: Number(req.params.id),
    approve: req.params.decision === 'approve',
    decidedBy: req.user.email
  });
  res.status(result.error ? 409 : 200).json(result);
});

// Data freshness + run history; any authenticated user can see freshness,
// full run detail and alerts power the admin data-ops panel.
app.get('/api/refresh/status', requireAuth, async (_req, res) => {
  res.json(await refreshStatus());
});

// Manual refresh trigger (admin-only). Body: { "simulateFailure": ["Kobo"] }
// lets the demo exercise the error/alert path without breaking anything.
app.post('/api/refresh', requireAuth, requireRole('tenant_admin', 'super_admin'), async (req, res) => {
  const simulateFailure = Array.isArray(req.body?.simulateFailure) ? req.body.simulateFailure : [];
  await audit({ tenantId: req.user.tenantId, actor: req.user.email, action: 'refresh.manual', detail: { simulateFailure } });
  const result = await runRefresh({ trigger: 'manual', simulateFailure });
  res.status(result.status === 'succeeded' ? 200 : 502).json(result);
});

app.use((err, _req, res, _next) => {
  console.error('request failed:', err.message);
  res.status(500).json({ error: 'Internal error' });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`IPOS API listening on :${port}`);
  startScheduler();
});

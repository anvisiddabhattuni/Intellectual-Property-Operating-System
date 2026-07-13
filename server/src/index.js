import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pool from './db/pool.js';
import { signToken, requireAuth, requireRole } from './auth.js';
import { audit } from './audit.js';
import { runRefresh, refreshStatus } from './refresh.js';
import { startScheduler } from './scheduler.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`IPOS API listening on :${port}`);
  startScheduler();
});

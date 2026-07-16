// STORY-010 acceptance: tenant data isolation.
// Two layers are proven here:
//   1. Database-level (Row-Level Security) — always runs. Proves that even a
//      query with NO tenant filter cannot cross tenants, and that a tenant
//      cannot write into another tenant's data.
//   2. API-level (cross-tenant) — runs if the server is up on :4000. Proves
//      the running app returns only the caller's tenant data.
//
// Run: `npm test` (start the server first for the API-level checks).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const cfg = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'ipos',
  password: process.env.PGPASSWORD || 'ipos_dev_password',
  database: process.env.PGDATABASE || 'ipos'
};
const API = process.env.API_URL || 'http://localhost:4000';

let client;
let tenants; // [{id, name}]

before(async () => {
  client = new pg.Client(cfg);
  await client.connect();
  // No app.current_tenant set => platform-wide read, so we can learn the ids.
  const { rows } = await client.query('SELECT id, name FROM tenants ORDER BY id');
  tenants = rows;
  assert.ok(tenants.length >= 2, 'need at least two tenants seeded — run `npm run db:init`');
});

const setTenant = (id) => client.query("SELECT set_config('app.current_tenant', $1, false)", [String(id)]);
const clearTenant = () => client.query("SELECT set_config('app.current_tenant', '', false)");

test('RLS confines reads to the active tenant (no WHERE clause)', async () => {
  for (const tn of tenants) {
    await setTenant(tn.id);
    // Deliberately no WHERE tenant_id — RLS must scope it anyway.
    const { rows } = await client.query('SELECT DISTINCT tenant_id FROM sales ORDER BY tenant_id');
    assert.deepEqual(rows.map((r) => r.tenant_id), [tn.id],
      `tenant ${tn.id} saw rows from other tenants`);
  }
  await clearTenant();
});

test('RLS confines the tenant across every business table', async () => {
  const tables = ['users', 'contracts', 'royalty_calculations', 'payouts',
    'forecasts', 'anomalies', 'marketing_recommendations'];
  await setTenant(tenants[0].id);
  for (const table of tables) {
    const { rows } = await client.query(`SELECT DISTINCT tenant_id FROM ${table}`);
    const others = rows.filter((r) => r.tenant_id !== tenants[0].id);
    assert.equal(others.length, 0, `${table} leaked another tenant's rows`);
  }
  await clearTenant();
});

test('RLS blocks writing a row into another tenant', async () => {
  await setTenant(tenants[0].id);
  await assert.rejects(
    () => client.query(
      `INSERT INTO sales (tenant_id, platform, title, sale_date, units, revenue, royalty)
       VALUES ($1, 'Amazon KDP', 'Injected', CURRENT_DATE, 1, 1.00, 0.70)`,
      [tenants[1].id] // tenant A trying to write tenant B's data
    ),
    /row-level security/i,
    'a tenant was able to insert data for another tenant'
  );
  await clearTenant();
});

test('no tenant context = platform-wide (background jobs, seed)', async () => {
  await clearTenant();
  const { rows: [{ n }] } = await client.query('SELECT COUNT(DISTINCT tenant_id)::int AS n FROM sales');
  assert.ok(n >= 2, 'system context should see all tenants');
});

// ---- API-level cross-tenant checks (guarded-live) ----

async function apiUp() {
  try {
    const r = await fetch(`${API}/api/health`);
    return r.ok;
  } catch { return false; }
}

async function login(email, password) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.ok(r.ok, `login failed for ${email}`);
  return (await r.json()).token;
}

const get = async (path, token) =>
  (await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })).json();

test('API returns only the caller\'s tenant data', async (t) => {
  if (!(await apiUp())) return t.skip('server not running on :4000');

  const ramToken = await login('ram@ipos.demo', 'author123');
  const mayaToken = await login('maya@ipos.demo', 'author123');

  const ram = await get('/api/sales', ramToken);
  const maya = await get('/api/sales', mayaToken);

  const ramTitles = new Set(ram.sales.map((s) => s.title));
  const mayaTitles = new Set(maya.sales.map((s) => s.title));

  assert.deepEqual([...ramTitles], ['Trust Before Intelligence']);
  assert.deepEqual([...mayaTitles], ['The Long Game']);
  // No title appears in both tenants' results.
  for (const title of ramTitles) assert.ok(!mayaTitles.has(title), 'cross-tenant title leak');

  const ramRev = ram.totals.reduce((a, p) => a + Number(p.revenue), 0);
  const mayaRev = maya.totals.reduce((a, p) => a + Number(p.revenue), 0);
  assert.notEqual(ramRev, mayaRev, 'both tenants returned identical totals — suspicious');
});

test('cleanup', async () => { await client.end(); });

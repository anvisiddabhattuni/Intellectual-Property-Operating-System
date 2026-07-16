import pg from 'pg';
import dotenv from 'dotenv';
import { tenantContext } from './context.js';

dotenv.config();

const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'ipos',
  password: process.env.PGPASSWORD || 'ipos_dev_password',
  database: process.env.PGDATABASE || 'ipos'
});

// Tenant-aware query (STORY-010). When a request is running inside a tenant
// context, every statement is scoped to that tenant via a transaction-local
// Postgres setting that Row-Level Security policies read (see schema.sql).
// The app-layer `WHERE tenant_id = $1` filters are still there; RLS is the
// database-enforced backstop that catches a query that ever forgets one.
//
// No context (background jobs, the seed, and the pre-auth login lookup) runs
// the query directly: RLS treats an unset tenant as "platform-wide", which is
// exactly what those code paths need.
async function query(text, params) {
  const store = tenantContext.getStore();
  if (!store || store.tenantId == null) {
    return pool.query(text, params);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // is_local=true => SET LOCAL: auto-resets at COMMIT, so a pooled
    // connection never carries one tenant's setting into another's request.
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [String(store.tenantId)]);
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default {
  query,
  connect: () => pool.connect(),
  end: () => pool.end(),
  pool
};

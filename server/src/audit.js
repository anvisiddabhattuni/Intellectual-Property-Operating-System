import pool from './db/pool.js';

// Append-only audit writer (TBI trust control). Never updates or deletes.
export async function audit({ tenantId = null, actor, action, detail = {} }) {
  await pool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, detail)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, actor, action, JSON.stringify(detail)]
  );
}

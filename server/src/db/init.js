// Applies schema.sql and seeds the R0 demo data (idempotent).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bcrypt from 'bcryptjs';
import pool from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

const DEMO_USERS = [
  { email: 'ram@ipos.demo',   name: 'Ram Katamaraja', role: 'author',       password: 'author123' },
  { email: 'admin@ipos.demo', name: 'Tenant Admin',   role: 'tenant_admin', password: 'admin123' }
];

// Mock sales for "Trust Before Intelligence" across the three platforms
// named in REQ-001. Real integrations replace this seed in R1.
const PLATFORMS = ['Amazon KDP', 'Barnes & Noble', 'Kobo'];

async function seed() {
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const tenant = await pool.query(
    `INSERT INTO tenants (name) VALUES ('Ram Katamaraja')
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`
  );
  const tenantId = tenant.rows[0].id;

  for (const u of DEMO_USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO NOTHING`,
      [tenantId, u.email, hash, u.name, u.role]
    );
  }

  const { rows: [{ count }] } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM sales WHERE tenant_id = $1', [tenantId]
  );
  if (count === 0) {
    const today = new Date();
    for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
      const d = new Date(today);
      d.setDate(d.getDate() - daysAgo);
      const date = d.toISOString().slice(0, 10);
      for (const platform of PLATFORMS) {
        const units = 3 + Math.floor(Math.random() * 12);
        const price = platform === 'Amazon KDP' ? 24.99 : 22.99;
        const revenue = +(units * price).toFixed(2);
        const royalty = +(revenue * 0.7).toFixed(2);
        await pool.query(
          `INSERT INTO sales (tenant_id, platform, title, sale_date, units, revenue, royalty)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, platform, 'Trust Before Intelligence', date, units, revenue, royalty]
        );
      }
    }
  }

  await pool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, detail)
     VALUES ($1, 'system', 'db.seed', $2)`,
    [tenantId, JSON.stringify({ users: DEMO_USERS.length, platforms: PLATFORMS })]
  );

  console.log('Database initialized and seeded.');
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});

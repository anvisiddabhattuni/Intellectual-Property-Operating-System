// Applies schema.sql and seeds demo data (idempotent).
// Seeds TWO tenants so tenant isolation (STORY-010) is demonstrable.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bcrypt from 'bcryptjs';
import pool from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

const PLATFORMS = ['Amazon KDP', 'Barnes & Noble', 'Kobo'];

// Each tenant is a self-contained author account: its own users, its own book,
// its own contract terms and sales scale. Two tenants make isolation testable.
const TENANTS = [
  {
    name: 'Ram Katamaraja',
    title: 'Trust Before Intelligence',
    priceAmazon: 24.99,
    priceOther: 22.99,
    unitsBase: 3, unitsSpread: 12,
    users: [
      { email: 'ram@ipos.demo',   name: 'Ram Katamaraja', role: 'author',       password: 'author123' },
      { email: 'admin@ipos.demo', name: 'Tenant Admin',   role: 'tenant_admin', password: 'admin123' }
    ],
    contracts: [['Amazon KDP', 0.70], ['Barnes & Noble', 0.65], ['Kobo', 0.72]]
  },
  {
    name: 'Maya Chen',
    title: 'The Long Game',
    priceAmazon: 14.99,
    priceOther: 12.99,
    unitsBase: 6, unitsSpread: 20,
    users: [
      { email: 'maya@ipos.demo',   name: 'Maya Chen',      role: 'author',       password: 'author123' },
      { email: 'admin2@ipos.demo', name: 'Tenant Admin 2', role: 'tenant_admin', password: 'admin123' }
    ],
    contracts: [['Amazon KDP', 0.60], ['Barnes & Noble', 0.55], ['Kobo', 0.63]]
  }
];

async function seedTenant(t) {
  const { rows: [{ id: tenantId }] } = await pool.query(
    `INSERT INTO tenants (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [t.name]
  );

  for (const u of t.users) {
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
        const units = t.unitsBase + Math.floor(Math.random() * t.unitsSpread);
        const price = platform === 'Amazon KDP' ? t.priceAmazon : t.priceOther;
        const revenue = +(units * price).toFixed(2);
        const royalty = +(revenue * 0.7).toFixed(2); // platform-reported figure
        await pool.query(
          `INSERT INTO sales (tenant_id, platform, title, sale_date, units, revenue, royalty)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, platform, t.title, date, units, revenue, royalty]
        );
      }
    }
  }

  for (const [platform, rate] of t.contracts) {
    await pool.query(
      `INSERT INTO contracts (tenant_id, title, platform, royalty_rate)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, title, platform, effective_from) DO NOTHING`,
      [tenantId, t.title, platform, rate]
    );
  }

  await pool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, detail)
     VALUES ($1, 'system', 'db.seed', $2)`,
    [tenantId, JSON.stringify({ title: t.title, users: t.users.length, contracts: t.contracts.length })]
  );

  return tenantId;
}

async function seed() {
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  await pool.query(schema);

  for (const t of TENANTS) {
    const id = await seedTenant(t);
    console.log(`Seeded tenant #${id}: ${t.name} — "${t.title}"`);
  }

  console.log('Database initialized and seeded (2 tenants, RLS enforced).');
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});

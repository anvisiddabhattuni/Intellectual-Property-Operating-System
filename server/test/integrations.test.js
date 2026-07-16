// STORY-001/002/003 acceptance: platform report ingestion.
// Proves each platform's exported report is parsed, integrity-checked, and
// landed in the unified dashboard — and that bad rows are rejected, not stored.
// Guarded-live: runs against the server on :4000 (start it first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const API = process.env.API_URL || 'http://localhost:4000';
const fixture = (name) => readFileSync(join(here, '..', 'fixtures', name), 'utf8');

async function apiUp() {
  try { return (await fetch(`${API}/api/health`)).ok; } catch { return false; }
}
async function login(email, password) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.ok(r.ok, `login failed for ${email}`);
  return (await r.json()).token;
}
const upload = (slug, csv, token) => fetch(`${API}/api/integrations/${slug}/upload`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ csv })
});

test('authors cannot upload platform reports (admin only)', async (t) => {
  if (!(await apiUp())) return t.skip('server not running on :4000');
  const authorToken = await login('ram@ipos.demo', 'author123');
  const r = await upload('amazon-kdp', fixture('amazon-kdp-sample.csv'), authorToken);
  assert.equal(r.status, 403);
});

test('valid reports ingest for all three platforms', async (t) => {
  if (!(await apiUp())) return t.skip('server not running on :4000');
  const admin = await login('admin@ipos.demo', 'admin123');

  for (const [slug, file, platform] of [
    ['amazon-kdp', 'amazon-kdp-sample.csv', 'Amazon KDP'],
    ['barnes-noble', 'barnes-noble-sample.csv', 'Barnes & Noble'],
    ['kobo', 'kobo-sample.csv', 'Kobo']
  ]) {
    const r = await upload(slug, fixture(file), admin);
    assert.equal(r.status, 201, `${platform} upload should succeed`);
    const { summary } = await r.json();
    assert.equal(summary.platform, platform);
    assert.equal(summary.rowsAccepted, 4, `${platform}: all 4 rows accepted`);
    assert.equal(summary.rowsRejected, 0, `${platform}: no rejects`);
    assert.deepEqual(summary.titles, ['Trust Before Intelligence']);
  }
});

test('integrity check rejects bad rows, keeps good ones', async (t) => {
  if (!(await apiUp())) return t.skip('server not running on :4000');
  const admin = await login('admin@ipos.demo', 'admin123');
  const r = await upload('amazon-kdp', fixture('amazon-kdp-malformed.csv'), admin);
  assert.equal(r.status, 201);
  const { summary } = await r.json();
  // 1 valid row; 3 bad (bad date, missing title, negative units).
  assert.equal(summary.rowsAccepted, 1);
  assert.equal(summary.rowsRejected, 3);
  assert.equal(summary.rejects.length, 3);
});

test('ingested platform data appears in the unified dashboard', async (t) => {
  if (!(await apiUp())) return t.skip('server not running on :4000');
  const admin = await login('admin@ipos.demo', 'admin123');
  const sales = await (await fetch(`${API}/api/sales`, { headers: { Authorization: `Bearer ${admin}` } })).json();
  const platforms = new Set(sales.totals.map((p) => p.platform));
  for (const p of ['Amazon KDP', 'Barnes & Noble', 'Kobo']) {
    assert.ok(platforms.has(p), `${p} should be visible in the dashboard totals`);
  }
});

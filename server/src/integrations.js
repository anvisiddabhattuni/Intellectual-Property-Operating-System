import pool from './db/pool.js';
import { audit } from './audit.js';

// Platform report ingestion (STORY-001 Amazon, 002 Barnes & Noble, 003 Kobo).
//
// None of these platforms expose a public per-author sales API, so authors get
// their numbers as exported sales reports (CSV). This ingests those reports:
// parse -> validate for accuracy & completeness -> aggregate -> store through
// the same `sales` read-model the dashboard already displays. It reuses the
// STORY-004 pipeline, so a real API connector is a drop-in later.
//
// Each acceptance criterion maps here:
//   "displayed in the unified dashboard, <=24h"  -> upsert into sales (shown live)
//   "verified for accuracy and completeness"     -> validate(); rejects are logged
//   Trust (TBI): audit the fetch + the integrity check; alert on rejects.

// URL slug -> the platform name used everywhere else (sales.platform, contracts).
export const PLATFORM_BY_SLUG = {
  'amazon-kdp': 'Amazon KDP',
  'barnes-noble': 'Barnes & Noble',
  'kobo': 'Kobo'
};

const num = (v) => Number(String(v ?? '').replace(/[$,\s]/g, ''));

// Each platform exports different columns; a spec maps them to our SaleRow.
const SPECS = {
  'Amazon KDP': {
    date: 'Royalty Date', title: 'Title', units: 'Units Sold',
    revenue: (r) => num(r['Units Sold']) * num(r['List Price']),
    royalty: 'Royalty'
  },
  'Barnes & Noble': {
    date: 'Sale Date', title: 'Title', units: 'Units',
    revenue: 'Net Revenue', royalty: 'Royalty Earned'
  },
  'Kobo': {
    date: 'Transaction Date', title: 'Title', units: 'Quantity',
    revenue: 'Amount', royalty: 'Royalty'
  }
};

// Minimal RFC-4180-ish CSV parser (handles quoted fields containing commas).
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') pushRow();
    else field += c;
  }
  if (field.length || row.length) pushRow();
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// Normalize YYYY-MM-DD or MM/DD/YYYY -> YYYY-MM-DD; null if unparseable.
function normalizeDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

// Integrity check: a row is accepted only if it is accurate and complete.
function validateRow(mapped) {
  const problems = [];
  if (!mapped.title) problems.push('missing title');
  if (!mapped.sale_date) problems.push('invalid date');
  if (!Number.isFinite(mapped.units) || !Number.isInteger(mapped.units) || mapped.units < 0)
    problems.push('invalid units');
  if (!Number.isFinite(mapped.revenue) || mapped.revenue < 0) problems.push('invalid revenue');
  if (!Number.isFinite(mapped.royalty) || mapped.royalty < 0) problems.push('invalid royalty');
  return problems;
}

export async function ingestReport({ tenantId, platform, csv, actor }) {
  const spec = SPECS[platform];
  if (!spec) return { error: `Unknown platform: ${platform}` };

  const records = parseCsv(csv);
  if (records.length === 0) return { error: 'Report is empty or has no data rows' };

  const accepted = [];
  const rejected = [];
  for (const [i, r] of records.entries()) {
    const mapped = {
      title: (r[spec.title] || '').trim(),
      sale_date: normalizeDate(r[spec.date]),
      units: num(r[spec.units]),
      revenue: typeof spec.revenue === 'function' ? +spec.revenue(r).toFixed(2) : +num(r[spec.revenue]).toFixed(2),
      royalty: +num(r[spec.royalty]).toFixed(2)
    };
    const problems = validateRow(mapped);
    if (problems.length) rejected.push({ line: i + 2, problems }); // +2: header + 1-index
    else accepted.push(mapped);
  }

  // Aggregate accepted rows to one authoritative daily total per title/date.
  const byKey = new Map();
  for (const a of accepted) {
    const k = `${a.title}|${a.sale_date}`;
    const agg = byKey.get(k) || { ...a, units: 0, revenue: 0, royalty: 0 };
    agg.units += a.units; agg.revenue = +(agg.revenue + a.revenue).toFixed(2);
    agg.royalty = +(agg.royalty + a.royalty).toFixed(2);
    byKey.set(k, agg);
  }

  for (const s of byKey.values()) {
    await pool.query(
      `INSERT INTO sales (tenant_id, platform, title, sale_date, units, revenue, royalty)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, platform, title, sale_date)
       DO UPDATE SET units = EXCLUDED.units, revenue = EXCLUDED.revenue, royalty = EXCLUDED.royalty`,
      [tenantId, platform, s.title, s.sale_date, s.units, s.revenue, s.royalty]
    );
  }

  const titles = [...new Set(accepted.map((a) => a.title))];
  const summary = {
    platform, rowsParsed: records.length,
    rowsAccepted: accepted.length, rowsRejected: rejected.length,
    daysUpserted: byKey.size, titles, rejects: rejected
  };

  await audit({
    tenantId, actor: actor || 'data-integration-agent',
    action: 'integration.ingest', detail: summary
  });

  // Trust: incomplete/inaccurate rows never silently land — they alert.
  if (rejected.length > 0) {
    await pool.query(
      `INSERT INTO alerts (source, message, detail) VALUES ('integration', $1, $2)`,
      [`${platform} report: ${rejected.length} row(s) failed integrity checks and were not imported`,
       JSON.stringify({ tenantId, platform, rejects: rejected })]
    );
    await audit({ tenantId, actor: 'data-integration-agent', action: 'alert.raised',
      detail: { reason: 'report integrity', platform, rejected: rejected.length } });
  }

  return { summary };
}

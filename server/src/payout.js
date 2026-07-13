import pool from './db/pool.js';
import { audit } from './audit.js';
import { paymentProvider } from './payments.js';

// Payout Processing Agent (STORY-006).
//
// Approval gate: a payout above the threshold is HELD for a human decision
// ("AI proposes, human approves"). Below the threshold it processes
// immediately. Every transition is audited.

export const APPROVAL_THRESHOLD = Number(process.env.PAYOUT_APPROVAL_THRESHOLD || 1000);

async function process_(payout, actor) {
  try {
    const { ref, provider } = await paymentProvider.createPayout({
      amountCents: Math.round(Number(payout.amount) * 100),
      description: `IPOS royalties ${String(payout.period_start).slice(0, 7)} tenant ${payout.tenant_id}`,
      idempotencyKey: `payout_${payout.id}`
    });
    const { rows: [updated] } = await pool.query(
      `UPDATE payouts SET status = 'paid', provider_ref = $1,
              detail = detail || $2 WHERE id = $3 RETURNING *`,
      [ref, JSON.stringify({ provider }), payout.id]
    );
    await audit({
      tenantId: payout.tenant_id, actor, action: 'payout.processed',
      detail: { payoutId: payout.id, amount: payout.amount, provider, ref }
    });
    return updated;
  } catch (err) {
    const { rows: [updated] } = await pool.query(
      `UPDATE payouts SET status = 'failed', detail = detail || $1
       WHERE id = $2 RETURNING *`,
      [JSON.stringify({ error: err.message }), payout.id]
    );
    await audit({
      tenantId: payout.tenant_id, actor, action: 'payout.failed',
      detail: { payoutId: payout.id, amount: payout.amount, error: err.message }
    });
    return updated;
  }
}

// Command: initiate a payout of one month's calculated royalties.
export async function initiatePayout({ tenantId, periodStart, requestedBy }) {
  const { rows: [sum] } = await pool.query(
    `SELECT COALESCE(SUM(royalty_amount), 0)::numeric(12,2) AS amount,
            COUNT(*) FILTER (WHERE missing_contract) AS unpriced
     FROM royalty_calculations
     WHERE tenant_id = $1 AND period_start = $2`,
    [tenantId, periodStart]
  );
  if (Number(sum.amount) <= 0) {
    return { error: 'No calculated royalties for that period' };
  }
  if (Number(sum.unpriced) > 0) {
    // Refuse to pay a month whose statement is incomplete — resolve the
    // missing-contract alert first, then initiate.
    return { error: `Statement has ${sum.unpriced} unpriced line(s) — resolve contracts first` };
  }

  const held = Number(sum.amount) > APPROVAL_THRESHOLD;
  let payout;
  try {
    ({ rows: [payout] } = await pool.query(
      `INSERT INTO payouts (tenant_id, period_start, amount, status, threshold, requested_by)
       VALUES ($1, $2, $3, 'pending_approval', $4, $5) RETURNING *`,
      [tenantId, periodStart, sum.amount, APPROVAL_THRESHOLD, requestedBy]
    ));
  } catch (err) {
    if (err.code === '23505') return { error: 'A payout for that period is already pending or paid' };
    throw err;
  }

  await audit({
    tenantId, actor: requestedBy, action: held ? 'payout.held' : 'payout.initiated',
    detail: { payoutId: payout.id, amount: sum.amount, threshold: APPROVAL_THRESHOLD, held }
  });

  // Below the threshold there is nothing to gate — process immediately.
  return { payout: held ? payout : await process_(payout, 'payout-agent') };
}

// Command: human decision on a held payout.
export async function decidePayout({ payoutId, approve, decidedBy }) {
  const { rows: [payout] } = await pool.query(
    `UPDATE payouts SET status = $1, decided_by = $2, decided_at = now()
     WHERE id = $3 AND status = 'pending_approval' RETURNING *`,
    [approve ? 'pending_approval' : 'rejected', decidedBy, payoutId]
  );
  if (!payout) return { error: 'Payout not found or not awaiting approval' };

  await audit({
    tenantId: payout.tenant_id, actor: decidedBy,
    action: approve ? 'payout.approved' : 'payout.rejected',
    detail: { payoutId: payout.id, amount: payout.amount }
  });

  return { payout: approve ? await process_(payout, decidedBy) : payout };
}

// Read-model: payout history for the tenant.
export async function listPayouts(tenantId) {
  const { rows } = await pool.query(
    `SELECT id, period_start, amount, status, threshold, requested_by,
            decided_by, decided_at, provider_ref, detail, created_at
     FROM payouts WHERE tenant_id = $1
     ORDER BY period_start DESC, created_at DESC`,
    [tenantId]
  );
  return rows;
}

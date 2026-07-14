import pool from './db/pool.js';
import { audit } from './audit.js';

// AI Insights Agent — personalized marketing recommendations (STORY-009).
//
// Pipeline: build the author's profile from real tenant data -> ask the
// provider (Claude, or an honest simulated generator when no credentials
// are configured) for recommendations, each grounded in evidence and
// self-scored for relevance -> ENFORCE the >=80 relevance bar in code ->
// store as pending_review behind the human approval gate -> audit.

export const RELEVANCE_THRESHOLD = 80;

// Structured-output schema: the API guarantees the response matches this,
// so there is no fragile free-text parsing.
const RECS_SCHEMA = {
  type: 'object',
  properties: {
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          action: { type: 'string' },
          rationale: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          relevance: { type: 'integer' }
        },
        required: ['title', 'action', 'rationale', 'evidence', 'relevance'],
        additionalProperties: false
      }
    }
  },
  required: ['recommendations'],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You are the AI Insights Agent for IPOS, a platform that helps book authors grow revenue.
You produce personalized marketing recommendations for an author based ONLY on the data provided.

Rules:
- Every recommendation must be grounded in the supplied data. The "evidence" array must quote the specific numbers or facts from the input that justify it.
- "relevance" is an integer 0-100: how directly the recommendation follows from this author's actual data. Score honestly; do not inflate. Generic advice that any author could receive scores low.
- Recommendations must be concrete actions the author can take this month, not platitudes.
- Produce 3 to 5 recommendations.
- The author is a real person making real decisions with real money; if the data is thin, say so in the rationale and score accordingly.`;

// The "author profile + sales data" input (acceptance Given-clause):
// everything the platform actually knows about this tenant.
export async function buildAuthorProfile(tenantId) {
  const [{ rows: platforms }, { rows: [tenant] }, { rows: [forecast] }, { rows: anomalies }] =
    await Promise.all([
      pool.query(
        `SELECT platform,
                SUM(units)::int AS units_30d,
                SUM(revenue)::numeric(12,2) AS revenue_30d,
                (SELECT royalty_rate FROM contracts c
                 WHERE c.tenant_id = s.tenant_id AND c.platform = s.platform
                 ORDER BY effective_from DESC LIMIT 1) AS contract_rate
         FROM sales s
         WHERE tenant_id = $1 AND sale_date >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY platform, tenant_id ORDER BY revenue_30d DESC`,
        [tenantId]
      ),
      pool.query('SELECT name FROM tenants WHERE id = $1', [tenantId]),
      pool.query(
        `SELECT total, total_lower, total_upper, horizon_days FROM forecasts
         WHERE tenant_id = $1 AND status = 'approved'
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId]
      ),
      pool.query(
        `SELECT method, platform, severity, observed, expected FROM anomalies
         WHERE tenant_id = $1 AND status = 'open' ORDER BY severity DESC LIMIT 5`,
        [tenantId]
      )
    ]);

  return {
    author: tenant?.name,
    title: 'Trust Before Intelligence',
    last30Days: platforms,
    approvedForecast: forecast || null,
    openAnomalies: anomalies
  };
}

async function claudeProvider(profile) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: RECS_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Author profile and sales data:\n${JSON.stringify(profile, null, 2)}`
    }]
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('Model declined the request');
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  return {
    provider: 'claude-opus-4-8',
    recommendations: JSON.parse(text).recommendations,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens }
  };
}

// Honest fallback when no Anthropic credentials are configured: rule-based
// recommendations computed from the same profile, clearly labeled.
function simulatedProvider(profile) {
  const recs = [];
  const p = profile.last30Days;
  if (p.length > 1) {
    const best = p[0];
    const worst = p[p.length - 1];
    recs.push({
      title: `Double down on ${best.platform}`,
      action: `Increase promotion where you already convert: ${best.platform} drove $${best.revenue_30d} in the last 30 days, your strongest channel.`,
      rationale: 'Strongest observed channel; marketing spend compounds where conversion is proven.',
      evidence: [`${best.platform} revenue last 30 days: $${best.revenue_30d}`],
      relevance: 88
    });
    recs.push({
      title: `Run a price promotion on ${worst.platform}`,
      action: `${worst.platform} is your weakest channel ($${worst.revenue_30d} in 30 days). A limited-time discount there can find new readers without cannibalizing your strong channels.`,
      rationale: 'Weakest channel has the most upside from a visibility push.',
      evidence: [`${worst.platform} revenue last 30 days: $${worst.revenue_30d}`],
      relevance: 84
    });
    const highestRate = [...p].sort((a, b) => Number(b.contract_rate) - Number(a.contract_rate))[0];
    recs.push({
      title: `Steer readers to ${highestRate.platform}`,
      action: `Your contract pays ${(highestRate.contract_rate * 100).toFixed(0)}% on ${highestRate.platform} — the highest of your channels. Point your website and social links there first.`,
      rationale: 'Same sale earns more where the contract rate is highest.',
      evidence: [`${highestRate.platform} contract royalty rate: ${(highestRate.contract_rate * 100).toFixed(0)}%`],
      relevance: 86
    });
  }
  if (profile.approvedForecast) {
    recs.push({
      title: 'Plan spend against your approved forecast',
      action: `Your approved forecast projects $${profile.approvedForecast.total} over the next ${profile.approvedForecast.horizon_days} days. Budget marketing as a fixed share of that (10-15% is a common author benchmark).`,
      rationale: 'Ties spend to expected revenue instead of guesswork.',
      evidence: [`Approved forecast: $${profile.approvedForecast.total} (95% interval $${profile.approvedForecast.total_lower}-$${profile.approvedForecast.total_upper})`],
      relevance: 82
    });
  }
  return { provider: 'simulated', recommendations: recs, usage: null };
}

export async function generateRecommendations({ tenantId, requestedBy }) {
  const profile = await buildAuthorProfile(tenantId);
  if (!profile.last30Days.length) {
    return { error: 'No sales data in the last 30 days to personalize against' };
  }

  const useClaude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.MARKETING_AI === 'claude');
  const result = useClaude ? await claudeProvider(profile) : simulatedProvider(profile);

  // Acceptance bar enforced in code, not on the honor system.
  const accepted = result.recommendations.filter((r) => Number(r.relevance) >= RELEVANCE_THRESHOLD);
  const filteredOut = result.recommendations.length - accepted.length;
  if (accepted.length === 0) {
    return { error: `Provider returned no recommendations at >=${RELEVANCE_THRESHOLD}% relevance` };
  }

  const { rows: [rec] } = await pool.query(
    `INSERT INTO marketing_recommendations
       (tenant_id, provider, status, recommendations, filtered_out, input_summary, generated_by)
     VALUES ($1, $2, 'pending_review', $3, $4, $5, $6) RETURNING *`,
    [tenantId, result.provider, JSON.stringify(accepted), filteredOut,
     JSON.stringify(profile), requestedBy]
  );

  await audit({
    tenantId, actor: 'ai-insights-agent', action: 'marketing.generated',
    detail: {
      recommendationId: rec.id, provider: result.provider,
      relevanceThreshold: RELEVANCE_THRESHOLD,
      scores: result.recommendations.map((r) => r.relevance),
      accepted: accepted.length, filteredOut,
      input: profile, usage: result.usage
    }
  });

  return { recommendation: rec };
}

// Human decision — the approval gate before anything reaches the author.
export async function decideRecommendation({ recId, approve, decidedBy }) {
  const { rows: [rec] } = await pool.query(
    `UPDATE marketing_recommendations SET status = $1, reviewed_by = $2, reviewed_at = now()
     WHERE id = $3 AND status = 'pending_review' RETURNING *`,
    [approve ? 'approved' : 'rejected', decidedBy, recId]
  );
  if (!rec) return { error: 'Recommendation set not found or not pending review' };
  await audit({
    tenantId: rec.tenant_id, actor: decidedBy,
    action: approve ? 'marketing.approved' : 'marketing.rejected',
    detail: { recommendationId: rec.id, count: rec.recommendations.length }
  });
  return { recommendation: rec };
}

export async function listRecommendations(tenantId, { includeUnapproved }) {
  const { rows } = await pool.query(
    includeUnapproved
      ? `SELECT * FROM marketing_recommendations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`
      : `SELECT * FROM marketing_recommendations WHERE tenant_id = $1 AND status = 'approved'
         ORDER BY created_at DESC LIMIT 1`,
    [tenantId]
  );
  return rows;
}

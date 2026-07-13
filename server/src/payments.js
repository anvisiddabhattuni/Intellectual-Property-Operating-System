// Payment provider adapter (STORY-006).
//
// With STRIPE_SECRET_KEY set, payouts go through the real Stripe API
// (test-mode keys make this safe end-to-end). Without a key we run a
// SIMULATED provider that mirrors the same contract and is loudly honest
// about it — references are prefixed "sim_" and detail carries
// provider: "simulated" so a fake transfer can never pass as a real one.
//
// Contract: createPayout({ amountCents, currency, description, idempotencyKey })
//   -> { ref, provider }  on success; throws on failure.

function simulatedProvider() {
  return {
    name: 'simulated',
    async createPayout({ amountCents, idempotencyKey }) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        throw new Error('invalid payout amount');
      }
      return { ref: `sim_${idempotencyKey}`, provider: 'simulated' };
    }
  };
}

async function stripeProvider(key) {
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(key);
  return {
    name: 'stripe',
    async createPayout({ amountCents, currency = 'usd', description, idempotencyKey }) {
      const payout = await stripe.payouts.create(
        { amount: amountCents, currency, description },
        { idempotencyKey }
      );
      return { ref: payout.id, provider: 'stripe' };
    }
  };
}

export const paymentProvider = process.env.STRIPE_SECRET_KEY
  ? await stripeProvider(process.env.STRIPE_SECRET_KEY)
  : simulatedProvider();

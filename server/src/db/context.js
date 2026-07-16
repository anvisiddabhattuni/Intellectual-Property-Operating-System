import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request tenant context (STORY-010). Authenticated requests run inside
// tenantContext.run({ tenantId }), so every db query issued while handling
// that request can discover which tenant it belongs to — without threading a
// tenantId argument through every function. Background jobs (scheduler, seed)
// run with no context and operate platform-wide.
export const tenantContext = new AsyncLocalStorage();

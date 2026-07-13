// Platform connector registry (STORY-004).
//
// The refresh engine iterates this list; it does not care how a connector
// gets its data. STORY-001/002/003 replace these mocks with real Amazon KDP /
// Barnes & Noble / Kobo API clients that implement the same contract:
//
//   { platform: string, fetchDaily(tenantId) -> Promise<SaleRow[]> }
//   SaleRow = { title, sale_date (YYYY-MM-DD), units, revenue, royalty }
import { mockConnector } from './mock.js';

const connectors = [
  mockConnector('Amazon KDP', 24.99),
  mockConnector('Barnes & Noble', 22.99),
  mockConnector('Kobo', 22.99)
];

export default connectors;

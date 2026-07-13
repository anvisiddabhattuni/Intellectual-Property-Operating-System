// Mock connector: simulates a platform's daily sales report until the real
// integrations (STORY-001..003) land. Returns rows for yesterday and today,
// like a real daily report pull would.
//
// Set FAIL_PLATFORMS="Kobo,Barnes & Noble" (or pass simulateFailure to the
// refresh engine) to force a fetch error and demo the alerting path.
const failList = (process.env.FAIL_PLATFORMS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

export function mockConnector(platform, unitPrice) {
  return {
    platform,
    async fetchDaily() {
      if (failList.includes(platform)) {
        throw new Error(`${platform}: upstream API unavailable (simulated via FAIL_PLATFORMS)`);
      }
      const rows = [];
      for (const daysAgo of [1, 0]) {
        const d = new Date();
        d.setDate(d.getDate() - daysAgo);
        const units = 3 + Math.floor(Math.random() * 12);
        const revenue = +(units * unitPrice).toFixed(2);
        rows.push({
          title: 'Trust Before Intelligence',
          sale_date: d.toISOString().slice(0, 10),
          units,
          revenue,
          royalty: +(revenue * 0.7).toFixed(2)
        });
      }
      return rows;
    }
  };
}

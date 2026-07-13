import cron from 'node-cron';
import pool from './db/pool.js';
import { runRefresh } from './refresh.js';

// Daily schedule (default 02:00 server time; override with REFRESH_CRON).
const SCHEDULE = process.env.REFRESH_CRON || '0 2 * * *';

export function startScheduler() {
  cron.schedule(SCHEDULE, async () => {
    try {
      await runRefresh({ trigger: 'schedule' });
    } catch (err) {
      // runRefresh handles per-connector failures itself; this catches
      // infrastructure-level failures (e.g. DB down) so the cron loop survives.
      console.error('scheduled refresh crashed:', err.message);
    }
  });
  console.log(`Refresh scheduler active (cron: "${SCHEDULE}")`);

  // Boot catch-up: guarantee the <=24h freshness promise even if the box was
  // asleep at the scheduled hour (laptops, restarted containers).
  bootCatchup().catch((err) => console.error('boot catch-up failed:', err.message));
}

async function bootCatchup() {
  const { rows: [last] } = await pool.query(
    `SELECT finished_at FROM refresh_runs WHERE status = 'succeeded'
     ORDER BY finished_at DESC LIMIT 1`
  );
  const ageHours = last ? (Date.now() - new Date(last.finished_at)) / 36e5 : Infinity;
  if (ageHours >= 24) {
    console.log('Last successful refresh >24h ago — running boot catch-up refresh.');
    await runRefresh({ trigger: 'boot-catchup' });
  }
}

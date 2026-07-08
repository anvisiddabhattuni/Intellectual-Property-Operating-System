import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'ipos',
  password: process.env.PGPASSWORD || 'ipos_dev_password',
  database: process.env.PGDATABASE || 'ipos'
});

export default pool;

import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || 'postgres://hubsync:hubsync@localhost:5432/hubsync';
const isRenderDatabase = String(connectionString).includes('render.com');
const shouldUseSsl = process.env.PGSSL === 'true' || (process.env.NODE_ENV === 'production' && isRenderDatabase);

export const pool = new Pool({
  connectionString,
  ssl: shouldUseSsl ? { rejectUnauthorized: false } : false,
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withClient(callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

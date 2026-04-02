import { query, pool } from './db.js';
import crypto from 'node:crypto';

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    person_number TEXT NOT NULL DEFAULT '',
    last_sync_at TIMESTAMPTZ NOT NULL,
    renewal_due_at TIMESTAMPTZ NOT NULL,
    renewal_period_days INTEGER NOT NULL DEFAULT 15,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS person_number TEXT NOT NULL DEFAULT '';
  ALTER TABLE assets
    ALTER COLUMN person_number TYPE TEXT USING person_number::TEXT;
`;

const seedSql = `
  INSERT INTO assets (name, person_number, last_sync_at, renewal_due_at, renewal_period_days)
  SELECT * FROM UNNEST ($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::int[])
  WHERE NOT EXISTS (SELECT 1 FROM assets LIMIT 1);
`;

const userSeedSql = `
  INSERT INTO users (username, email, password_hash)
  VALUES ($1, $2, $3)
  ON CONFLICT (email) DO NOTHING;
`;

const syncSql = `
  UPDATE assets AS a
  SET person_number = data.person_number,
      last_sync_at = data.last_sync_at,
      renewal_due_at = data.renewal_due_at,
      renewal_period_days = data.renewal_period_days,
      updated_at = NOW()
  FROM (
    SELECT * FROM UNNEST ($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::int[])
      AS t(name, person_number, last_sync_at, renewal_due_at, renewal_period_days)
  ) AS data
  WHERE a.name = data.name;
`;

const names = ['SARAH LEITE', 'Mateus Lessa', 'ANDREW LEITE'];
const personNumbers = ['(11) 99876-1234', '(11) 98765-4321', '(11) 97654-3210'];
const now = new Date();
const lastSyncDates = names.map(() => now.toISOString());
const dueDates = names.map((_, index) => {
  const date = new Date(now);
  date.setDate(date.getDate() + 15);
  return date.toISOString();
});
const periods = names.map(() => 15);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  await query(schema);
  await query(userSeedSql, ['Administrador', 'admin@hubsync.local', hashPassword('123456')]);
  await query(syncSql, [names, personNumbers, lastSyncDates, dueDates, periods]);
  await query(seedSql, [names, personNumbers, lastSyncDates, dueDates, periods]);
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});

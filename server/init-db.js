import { query, pool } from './db.js';
import crypto from 'node:crypto';

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'normal',
    reset_token_hash TEXT,
    reset_token_expires_at TIMESTAMPTZ,
    email_verify_token_hash TEXT,
    email_verify_token_expires_at TIMESTAMPTZ,
    email_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    person_number TEXT NOT NULL DEFAULT '',
    renewal_email TEXT,
    environment TEXT NOT NULL DEFAULT 'producao',
    last_sync_at TIMESTAMPTZ NOT NULL,
    renewal_due_at TIMESTAMPTZ NOT NULL,
    renewal_period_days INTEGER NOT NULL DEFAULT 15,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    notify_new_asset BOOLEAN NOT NULL DEFAULT TRUE,
    notify_due_soon BOOLEAN NOT NULL DEFAULT TRUE,
    notify_overdue BOOLEAN NOT NULL DEFAULT TRUE,
    due_soon_days INTEGER NOT NULL DEFAULT 7,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id SERIAL PRIMARY KEY,
    actor_user_id INTEGER,
    actor_email TEXT,
    target_user_id INTEGER,
    target_email TEXT,
    event_type TEXT NOT NULL,
    event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS notification_events (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, asset_id, event_key)
  );
  CREATE INDEX IF NOT EXISTS idx_assets_renewal_due_at ON assets (renewal_due_at);
  CREATE INDEX IF NOT EXISTS idx_assets_name_lower ON assets ((LOWER(name)));
  CREATE INDEX IF NOT EXISTS idx_users_email_verified_at ON users (email_verified_at);
  CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notification_events_created_at ON notification_events (created_at DESC);
  ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS person_number TEXT NOT NULL DEFAULT '';
  ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS renewal_email TEXT;
  ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'producao';
  ALTER TABLE assets
    ALTER COLUMN person_number TYPE TEXT USING person_number::TEXT;
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'normal';
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verify_token_hash TEXT;
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verify_token_expires_at TIMESTAMPTZ;
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
  ALTER TABLE user_notification_preferences
    ADD COLUMN IF NOT EXISTS due_soon_days INTEGER NOT NULL DEFAULT 7;
`;

const seedSql = `
  INSERT INTO assets (name, person_number, renewal_email, last_sync_at, renewal_due_at, renewal_period_days)
  SELECT * FROM UNNEST ($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::int[])
  WHERE NOT EXISTS (SELECT 1 FROM assets LIMIT 1);
`;

const userSeedSql = `
  INSERT INTO users (username, email, password_hash, role)
  VALUES ($1, $2, $3, 'admin')
  ON CONFLICT (email) DO UPDATE
  SET username = EXCLUDED.username,
      password_hash = EXCLUDED.password_hash,
      role = 'admin',
      email_verified_at = COALESCE(users.email_verified_at, NOW());
`;

const userSeedVerificationSql = `
  UPDATE users
  SET email_verified_at = COALESCE(email_verified_at, NOW()),
      email_verify_token_hash = NULL,
      email_verify_token_expires_at = NULL
  WHERE email = $1;
`;

const notificationSeedSql = `
  INSERT INTO user_notification_preferences (user_id)
  SELECT id FROM users
  ON CONFLICT (user_id) DO NOTHING;
`;

const syncSql = `
  UPDATE assets AS a
  SET person_number = data.person_number,
      renewal_email = data.renewal_email,
      last_sync_at = data.last_sync_at,
      renewal_due_at = data.renewal_due_at,
      renewal_period_days = data.renewal_period_days,
      updated_at = NOW()
  FROM (
    SELECT * FROM UNNEST ($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::int[])
      AS t(name, person_number, renewal_email, last_sync_at, renewal_due_at, renewal_period_days)
  ) AS data
  WHERE a.name = data.name;
`;

const names = ['SARAH LEITE', 'Mateus Lessa', 'ANDREW LEITE'];
const personNumbers = ['(11) 99876-1234', '(11) 98765-4321', '(11) 97654-3210'];
const renewalEmails = ['sarah.leite@empresa.com', 'mateus.lessa@empresa.com', 'andrew.leite@empresa.com'];
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
  await query(userSeedVerificationSql, ['admin@hubsync.local']);
  await query(notificationSeedSql);
  await query(syncSql, [names, personNumbers, renewalEmails, lastSyncDates, dueDates, periods]);
  await query(seedSql, [names, personNumbers, renewalEmails, lastSyncDates, dueDates, periods]);
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});

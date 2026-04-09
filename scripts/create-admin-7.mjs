import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;

const pool = new Pool({
  connectionString: 'postgres://hubsync:hubsync@localhost:5433/hubsync',
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  const username = 'admin_teste_7';
  const email = 'admin.teste7@hublocal.com';
  const password = 'TesteAdmin7!';
  const passwordHash = hashPassword(password);

  const sql = `
    INSERT INTO users (username, email, password_hash, role, email_verified_at)
    VALUES ($1, $2, $3, 'admin', NOW())
    ON CONFLICT (email)
    DO UPDATE SET
      username = EXCLUDED.username,
      password_hash = EXCLUDED.password_hash,
      role = 'admin',
      email_verified_at = COALESCE(users.email_verified_at, NOW())
    RETURNING id, username, email, role, email_verified_at
  `;

  const result = await pool.query(sql, [username, email, passwordHash]);

  console.log(JSON.stringify({
    ok: true,
    user: result.rows[0],
    credentials: {
      email,
      password,
    },
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

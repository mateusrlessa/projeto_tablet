import dotenv from 'dotenv';
import crypto from 'node:crypto';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || 'postgres://hubsync:hubsync@localhost:5432/hubsync';

const pool = new Pool({
  connectionString,
  ssl: false,
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function createAdminUser() {
  try {
    const username = 'admin';
    const email = 'admin@local.test';
    const password = 'Admin123!@#';

    const passwordHash = hashPassword(password);

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, email_verified_at)
       VALUES ($1, $2, $3, 'admin', NOW())
       ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = $3
       RETURNING id, username, email, role`,
      [username, email, passwordHash]
    );

    const user = result.rows[0];
    console.log('\n✅ Usuário admin criado/atualizado com sucesso!\n');
    console.log('📧 E-mail:', email);
    console.log('🔐 Senha:', password);
    console.log('👤 Username:', username);
    console.log('🎯 Role:', user.role);
    console.log('\n💡 Use essas credenciais para fazer login no site local!\n');

  } catch (error) {
    console.error('Erro ao criar usuário admin:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

createAdminUser();

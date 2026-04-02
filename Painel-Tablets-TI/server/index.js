import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { query, pool } from './db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === 'production';
const distPath = path.resolve(__dirname, '..', 'dist');
const authSecret = process.env.AUTH_SECRET || 'hubsync-dev-secret';

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

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

async function ensureSchema() {
  await query(schema);
}

function calculateDaysRemaining(renewalDueAt) {
  const milliseconds = new Date(renewalDueAt).getTime() - Date.now();
  return Math.ceil(milliseconds / (1000 * 60 * 60 * 24));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, storedHash] = String(stored || '').split(':');
  if (!salt || !storedHash) return false;
  const candidateHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(candidateHash, 'hex'));
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function createAuthToken(user) {
  const payload = {
    userId: user.id,
    email: user.email,
    exp: Date.now() + 1000 * 60 * 60 * 12,
  };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', authSecret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function readAuthToken(token) {
  const [encodedPayload, signature] = String(token || '').split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = crypto.createHmac('sha256', authSecret).update(encodedPayload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatBrazilPhone(value) {
  const digits = normalizePhone(value);
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return value;
}

function mapAsset(row) {
  const daysRemaining = calculateDaysRemaining(row.renewal_due_at);
  const status = daysRemaining < 0 ? 'vencido' : daysRemaining <= 7 ? 'atencao' : 'ok';

  return {
    id: row.id,
    name: row.name,
    personNumber: row.person_number,
    lastSyncAt: row.last_sync_at,
    renewalDueAt: row.renewal_due_at,
    renewalPeriodDays: row.renewal_period_days,
    daysRemaining,
    status,
  };
}

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
  };
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const payload = readAuthToken(token);

    if (!payload) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const result = await query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    req.user = mapUser(result.rows[0]);
    return next();
  } catch (error) {
    return next(error);
  }
}

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username) return res.status(400).json({ error: 'username-required' });
    if (!email.includes('@')) return res.status(400).json({ error: 'email-invalid' });
    if (password.length < 6) return res.status(400).json({ error: 'password-too-short' });

    const exists = await query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'email-already-registered' });

    const passwordHash = hashPassword(password);
    const result = await query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING *',
      [username, email, passwordHash],
    );

    const user = mapUser(result.rows[0]);
    const token = createAuthToken(user);
    res.status(201).json({ user, token });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'invalid-credentials' });
    }

    const userRow = result.rows[0];
    if (!verifyPassword(password, userRow.password_hash)) {
      return res.status(401).json({ error: 'invalid-credentials' });
    }

    const user = mapUser(userRow);
    const token = createAuthToken(user);
    res.json({ user, token });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/users', requireAuth, async (_req, res, next) => {
  try {
    const result = await query('SELECT id, username, email, created_at FROM users ORDER BY id ASC');
    res.json(result.rows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      createdAt: row.created_at,
    })));
  } catch (error) {
    next(error);
  }
});

app.post('/api/users', requireAuth, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username) return res.status(400).json({ error: 'username-required' });
    if (!email.includes('@')) return res.status(400).json({ error: 'email-invalid' });
    if (password.length < 6) return res.status(400).json({ error: 'password-too-short' });

    const exists = await query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'email-already-registered' });

    const passwordHash = hashPassword(password);
    const result = await query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, created_at',
      [username, email, passwordHash],
    );

    const row = result.rows[0];
    res.status(201).json({
      id: row.id,
      username: row.username,
      email: row.email,
      createdAt: row.created_at,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'database-unavailable' });
  }
});

app.get('/api/summary', requireAuth, async (_req, res, next) => {
  try {
    const result = await query('SELECT * FROM assets ORDER BY name ASC');
    const assets = result.rows.map(mapAsset);
    const summary = {
      totalMonitored: assets.length,
      onlineOk: assets.filter((asset) => asset.status === 'ok').length,
      attention: assets.filter((asset) => asset.status === 'atencao').length,
      overdue: assets.filter((asset) => asset.status === 'vencido').length,
    };

    res.json({ summary, assets });
  } catch (error) {
    next(error);
  }
});

app.get('/api/assets', requireAuth, async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const result = search
      ? await query('SELECT * FROM assets WHERE LOWER(name) LIKE LOWER($1) ORDER BY name ASC', [`%${search}%`])
      : await query('SELECT * FROM assets ORDER BY name ASC');

    res.json(result.rows.map(mapAsset));
  } catch (error) {
    next(error);
  }
});

app.post('/api/assets', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const personNumber = String(req.body.personNumber || '').trim();
    const renewalPeriodDays = 15;

    if (!name) {
      return res.status(400).json({ error: 'name-required' });
    }

    const digits = normalizePhone(personNumber);
    if (digits.length !== 10 && digits.length !== 11) {
      return res.status(400).json({ error: 'person-number-required' });
    }

    const now = new Date();
    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + renewalPeriodDays);

    const result = await query(
      `INSERT INTO assets (name, person_number, last_sync_at, renewal_due_at, renewal_period_days)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, formatBrazilPhone(digits), now.toISOString(), dueDate.toISOString(), renewalPeriodDays],
    );

    res.status(201).json(mapAsset(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.post('/api/assets/:id/renew', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const resultCurrent = await query('SELECT * FROM assets WHERE id = $1', [id]);

    if (resultCurrent.rowCount === 0) {
      return res.status(404).json({ error: 'asset-not-found' });
    }

    const current = resultCurrent.rows[0];
    const now = new Date();
    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + current.renewal_period_days);

    const result = await query(
      `UPDATE assets
       SET last_sync_at = $1, renewal_due_at = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [now.toISOString(), dueDate.toISOString(), id],
    );

    res.json(mapAsset(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.put('/api/assets/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    const personNumber = String(req.body.personNumber || '').trim();
    const renewalPeriodDays = Number(req.body.renewalPeriodDays);

    if (!name) {
      return res.status(400).json({ error: 'name-required' });
    }

    const digits = normalizePhone(personNumber);
    if (digits.length !== 10 && digits.length !== 11) {
      return res.status(400).json({ error: 'person-number-required' });
    }

    if (!Number.isInteger(renewalPeriodDays) || renewalPeriodDays < 15) {
      return res.status(400).json({ error: 'renewal-period-invalid' });
    }

    const currentResult = await query('SELECT * FROM assets WHERE id = $1', [id]);
    if (currentResult.rowCount === 0) {
      return res.status(404).json({ error: 'asset-not-found' });
    }

    const current = currentResult.rows[0];
    const lastSyncAt = new Date(current.last_sync_at);
    const dueDate = new Date(lastSyncAt);
    dueDate.setDate(dueDate.getDate() + renewalPeriodDays);

    const result = await query(
      `UPDATE assets
       SET name = $1, person_number = $2, renewal_period_days = $3, renewal_due_at = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [name, formatBrazilPhone(digits), renewalPeriodDays, dueDate.toISOString(), id],
    );

    res.json(mapAsset(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.post('/api/assets/resolve-overdue', requireAuth, async (_req, res, next) => {
  try {
    const overdue = await query('SELECT * FROM assets WHERE renewal_due_at < NOW()');
    const updated = [];

    for (const asset of overdue.rows) {
      const now = new Date();
      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + asset.renewal_period_days);

      const result = await query(
        `UPDATE assets
         SET last_sync_at = $1, renewal_due_at = $2, updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [now.toISOString(), dueDate.toISOString(), asset.id],
      );
      updated.push(mapAsset(result.rows[0]));
    }

    res.json({ updatedCount: updated.length, assets: updated });
  } catch (error) {
    next(error);
  }
});

app.get('/api/assets/export.xlsx', requireAuth, async (_req, res, next) => {
  try {
    const result = await query('SELECT * FROM assets ORDER BY name ASC');
    const assets = result.rows.map(mapAsset);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Ativos');
    sheet.columns = [
      { header: 'Nome', key: 'name', width: 28 },
      { header: 'Ultima sincronizacao', key: 'lastSyncAt', width: 22 },
      { header: 'Vencimento', key: 'renewalDueAt', width: 22 },
      { header: 'Dias restantes', key: 'daysRemaining', width: 15 },
      { header: 'Status', key: 'status', width: 14 },
    ];
    sheet.addRows(assets.map((asset) => ({
      name: asset.name,
      lastSyncAt: new Date(asset.lastSyncAt).toLocaleDateString('pt-BR'),
      renewalDueAt: new Date(asset.renewalDueAt).toLocaleDateString('pt-BR'),
      daysRemaining: asset.daysRemaining,
      status: asset.status,
    })));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=ativos-hubsync.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, '..', 'dist')));

app.get('*', (_req, res) => {
  if (isProduction) {
    res.sendFile(path.join(distPath, 'index.html'));
    return;
  }

  res.status(404).send('Frontend nao carregado. Rode npm run dev no ambiente de desenvolvimento.');
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'internal-server-error' });
});

async function start() {
  await ensureSchema();

  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

start().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
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
const frontendBaseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
const notificationScanIntervalMinutes = Number(process.env.NOTIFICATION_SCAN_INTERVAL_MINUTES || 60);
const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || frontendBaseUrl)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const isAuthSecretWeak = !authSecret || authSecret === 'hubsync-dev-secret' || authSecret.length < 32;
const smtpHost = process.env.SMTP_HOST || '';
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecure = process.env.SMTP_SECURE === 'true';
const smtpFrom = process.env.SMTP_FROM || smtpUser || 'no-reply@hubsync.local';

let notificationScanRunning = false;

const mailer = smtpHost && smtpUser && smtpPass
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    })
  : null;

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!isProduction) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('cors-not-allowed'));
  },
  credentials: false,
}));

app.use(express.json({ limit: '200kb' }));
app.use(morgan('dev'));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too-many-auth-requests' },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too-many-requests' },
});

app.use('/api', apiLimiter);

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
    email_verify_code_hash TEXT,
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
    ADD COLUMN IF NOT EXISTS email_verify_code_hash TEXT;
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verify_token_expires_at TIMESTAMPTZ;
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
  ALTER TABLE user_notification_preferences
    ADD COLUMN IF NOT EXISTS due_soon_days INTEGER NOT NULL DEFAULT 7;
`;

async function ensureSchema() {
  await query(schema);
}

function calculateDaysRemaining(renewalDueAt) {
  const milliseconds = new Date(renewalDueAt).getTime() - Date.now();
  return Math.ceil(milliseconds / (1000 * 60 * 60 * 24));
}

function hashSha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  const value = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validatePasswordStrength(password) {
  const value = String(password || '');
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasDigit = /\d/.test(value);
  const hasSymbol = /[^A-Za-z0-9]/.test(value);

  if (value.length < 10) return 'password-too-short';
  if (!hasUpper) return 'password-missing-uppercase';
  if (!hasLower) return 'password-missing-lowercase';
  if (!hasDigit) return 'password-missing-digit';
  if (!hasSymbol) return 'password-missing-symbol';
  return null;
}

function extractRequestIp(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwardedFor || req.ip || null;
}

async function sendMail({ to, subject, html }) {
  if (!mailer) {
    console.log('[mail-disabled]', { to, subject });
    return false;
  }

  await mailer.sendMail({
    from: smtpFrom,
    to,
    subject,
    html,
  });

  return true;
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

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'admin') {
    return 'admin';
  }

  if (role === 'normal' || role === 'viewer') {
    return 'normal';
  }

  return null;
}

function publicRole(role) {
  return String(role || '').toLowerCase() === 'admin' ? 'admin' : 'normal';
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
    renewalEmail: row.renewal_email || '',
    environment: row.environment || 'producao',
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
    role: publicRole(row.role),
    emailVerified: Boolean(row.email_verified_at),
    emailVerifiedAt: row.email_verified_at || null,
  };
}

function mapNotificationPreferences(row) {
  return {
    notifyNewAsset: row.notify_new_asset,
    notifyDueSoon: row.notify_due_soon,
    notifyOverdue: row.notify_overdue,
    dueSoonDays: row.due_soon_days,
    updatedAt: row.updated_at,
  };
}

async function ensureNotificationPreferences(userId) {
  await query(
    'INSERT INTO user_notification_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
}

async function getNotificationPreferences(userId) {
  await ensureNotificationPreferences(userId);
  const result = await query('SELECT * FROM user_notification_preferences WHERE user_id = $1', [userId]);
  return result.rows[0];
}

async function logAuditEvent({ actorUser, targetUserId, targetEmail, eventType, payload, req }) {
  await query(
    `INSERT INTO audit_events (actor_user_id, actor_email, target_user_id, target_email, event_type, event_payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      actorUser?.id || null,
      actorUser?.email || null,
      targetUserId || null,
      targetEmail || null,
      eventType,
      JSON.stringify({
        ...(payload || {}),
        requestIp: extractRequestIp(req),
        userAgent: String(req?.headers?.['user-agent'] || ''),
      }),
    ],
  );
}

function buildHubLocalEmailHtml({
  title,
  subtitle,
  greeting,
  contentHtml,
  ctaLabel,
  ctaUrl,
  noteHtml,
}) {
  const logoUrl = String(process.env.EMAIL_LOGO_URL || '').trim();
  const logoBlock = logoUrl
    ? `<img src="${logoUrl}" alt="HubLocal" style="display:block;max-width:170px;height:auto;border:0;" />`
    : `<div style="font-size:34px;font-weight:800;letter-spacing:0.3px;color:#ffffff;">HubLocal</div>`;

  const socialButtons = [
    { label: 'TikTok', url: 'https://www.tiktok.com/@hublocal' },
    { label: 'YouTube', url: 'https://www.youtube.com/channel/UC_r-VTrVBOgEDMjvJ94o8-A/featured' },
    { label: 'Instagram', url: 'https://www.instagram.com/hublocalbr/' },
  ]
    .map(
      (item) => `
        <a href="${item.url}" style="display:inline-block;padding:8px 12px;border:1px solid rgba(255,255,255,0.22);border-radius:10px;color:#ffffff;text-decoration:none;font-size:12px;font-weight:700;letter-spacing:0.2px;">${item.label}</a>
      `,
    )
    .join('');

  const ctaHtml = ctaLabel && ctaUrl
    ? `
      <p style="margin:24px 0 16px;">
        <a href="${ctaUrl}" style="display:inline-block;padding:13px 22px;border-radius:12px;background:linear-gradient(135deg,#3a79ff,#1d4fe0);color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;">${ctaLabel}</a>
      </p>
      <div style="padding:14px 16px;border-radius:12px;background:#f8fbff;border:1px solid #dbeafe;font-size:13px;color:#334155;line-height:1.65;">
        Se o botão não funcionar, copie e cole este link no navegador:<br />
        <a href="${ctaUrl}" style="word-break:break-all;color:#1d4ed8;text-decoration:none;">${ctaUrl}</a>
      </div>
    `
    : '';

  return `
    <div style="margin:0;padding:24px 12px;background:#020027;font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #dde7ff;">
        <tr>
          <td style="padding:26px 24px;background:linear-gradient(180deg,#03002b 0%,#0a1750 100%);color:#ffffff;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:middle;">${logoBlock}</td>
                <td style="vertical-align:middle;text-align:right;white-space:nowrap;">${socialButtons}</td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 24px 10px;">
            <h1 style="margin:0 0 8px;font-size:26px;line-height:1.2;color:#0f1f4d;">${title}</h1>
            <p style="margin:0 0 16px;color:#475569;font-size:14px;">${subtitle}</p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155;">${greeting}</p>
            ${contentHtml}
            ${ctaHtml}
          </td>
        </tr>

        <tr>
          <td style="padding:10px 24px 24px;">${noteHtml || ''}</td>
        </tr>

        <tr>
          <td style="padding:16px 24px;background:#03002b;border-top:1px solid rgba(255,255,255,0.14);text-align:center;color:#d6dcff;font-size:12px;line-height:1.7;">
            HubLocal • Mensagem automatica de seguranca<br />
            Se voce nao reconhece esta acao, ignore este e-mail.
          </td>
        </tr>
      </table>
    </div>
  `;
}

async function sendVerificationEmail({ email, username, token, code }) {
  const verifyUrl = `${frontendBaseUrl}/#verify-email?token=${token}`;

  return sendMail({
    to: email,
    subject: 'HubLocal: confirme seu e-mail',
    html: buildHubLocalEmailHtml({
      title: 'Confirme seu e-mail',
      subtitle: 'Validacao de acesso ao painel HubSync',
      greeting: `Ola, <strong>${username}</strong>. Falta apenas um passo para ativar sua conta.`,
      contentHtml: `
        <p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#334155;">Digite o codigo abaixo na tela de confirmacao:</p>
        <div style="display:inline-block;padding:12px 18px;border-radius:12px;background:#03002b;color:#ffffff;font-size:30px;font-weight:800;letter-spacing:6px;">${code}</div>
      `,
      ctaLabel: 'Confirmar por link',
      ctaUrl: verifyUrl,
      noteHtml: `
        <div style="padding:12px 14px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12;font-size:13px;line-height:1.6;">
          Este codigo e link expiram em 24 horas.
        </div>
      `,
    }),
  });
}

async function sendRenewalEmail(asset, recipientEmail) {
  const subject = `HubSync: renovação do tablet ${asset.name}`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="color: #2563eb; margin-bottom: 8px;">Renovação de tablet</h2>
      <p>O tablet <strong>${asset.name}</strong> precisa de atenção.</p>
      <p><strong>Status:</strong> ${asset.status === 'vencido' ? 'Vencido' : 'Próximo do vencimento'}</p>
      <p><strong>Faltam:</strong> ${asset.daysRemaining} dias</p>
      <p><strong>Vencimento:</strong> ${new Date(asset.renewalDueAt).toLocaleDateString('pt-BR')}</p>
      <p>Acesse o HubSync para renovar o ativo e manter o monitoramento atualizado.</p>
    </div>
  `;

  return sendMail({ to: recipientEmail, subject, html });
}

async function sendNewAssetEmail(user, asset) {
  const subject = `HubSync: novo tablet cadastrado (${asset.name})`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="color: #2563eb; margin-bottom: 8px;">Novo tablet monitorado</h2>
      <p>Olá, <strong>${user.username}</strong>.</p>
      <p>Um novo tablet foi cadastrado:</p>
      <ul>
        <li><strong>Nome:</strong> ${asset.name}</li>
        <li><strong>Número:</strong> ${asset.personNumber}</li>
        <li><strong>Vencimento:</strong> ${new Date(asset.renewalDueAt).toLocaleDateString('pt-BR')}</li>
      </ul>
    </div>
  `;

  return sendMail({ to: user.email, subject, html });
}

async function sendDueSoonEmail(user, asset) {
  const subject = `HubSync: tablet próximo do vencimento (${asset.name})`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="color: #d97706; margin-bottom: 8px;">Alerta de vencimento próximo</h2>
      <p>Olá, <strong>${user.username}</strong>.</p>
      <p>O tablet <strong>${asset.name}</strong> vence em <strong>${asset.daysRemaining} dia(s)</strong>.</p>
      <p>Data de vencimento: <strong>${new Date(asset.renewalDueAt).toLocaleDateString('pt-BR')}</strong>.</p>
    </div>
  `;

  return sendMail({ to: user.email, subject, html });
}

async function sendOverdueEmail(user, asset) {
  const daysExpired = Math.abs(asset.daysRemaining);
  const subject = `HubSync: tablet vencido (${asset.name})`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="color: #dc2626; margin-bottom: 8px;">Tablet vencido</h2>
      <p>Olá, <strong>${user.username}</strong>.</p>
      <p>O tablet <strong>${asset.name}</strong> está vencido há <strong>${daysExpired} dia(s)</strong>.</p>
      <p>Vencimento: <strong>${new Date(asset.renewalDueAt).toLocaleDateString('pt-BR')}</strong>.</p>
    </div>
  `;

  return sendMail({ to: user.email, subject, html });
}

async function tryCreateNotificationEvent({ userId, assetId, eventKey }) {
  const result = await query(
    `INSERT INTO notification_events (user_id, asset_id, event_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, asset_id, event_key) DO NOTHING
     RETURNING id`,
    [userId, assetId, eventKey],
  );

  return result.rowCount > 0;
}

async function notifyUsersOnNewAsset(asset) {
  const result = await query(
    `SELECT u.id, u.username, u.email
     FROM users u
     JOIN user_notification_preferences p ON p.user_id = u.id
     WHERE u.email_verified_at IS NOT NULL
       AND p.notify_new_asset = TRUE`,
  );

  for (const user of result.rows) {
    const created = await tryCreateNotificationEvent({
      userId: user.id,
      assetId: asset.id,
      eventKey: `new-asset-${asset.id}`,
    });

    if (!created) continue;
    await sendNewAssetEmail(user, asset);
  }
}

async function runDueNotifications(reason = 'scheduled') {
  if (notificationScanRunning) {
    return { skipped: true, reason: 'already-running' };
  }

  notificationScanRunning = true;
  try {
    const usersResult = await query(
      `SELECT u.id, u.username, u.email,
              p.notify_due_soon, p.notify_overdue, p.due_soon_days
       FROM users u
       JOIN user_notification_preferences p ON p.user_id = u.id
       WHERE u.email_verified_at IS NOT NULL`,
    );
    const assetsResult = await query('SELECT * FROM assets ORDER BY id ASC');

    const users = usersResult.rows;
    const assets = assetsResult.rows.map(mapAsset);
    const dateKey = new Date().toISOString().slice(0, 10);
    let dueSoonCount = 0;
    let overdueCount = 0;

    for (const user of users) {
      for (const asset of assets) {
        if (user.notify_due_soon && asset.daysRemaining > 0 && asset.daysRemaining <= user.due_soon_days) {
          const eventKey = `due-soon-${dateKey}-${asset.daysRemaining}`;
          const created = await tryCreateNotificationEvent({
            userId: user.id,
            assetId: asset.id,
            eventKey,
          });

          if (created) {
            dueSoonCount += 1;
            await sendDueSoonEmail(user, asset);
          }
        }

        if (user.notify_overdue && asset.daysRemaining < 0) {
          const eventKey = `overdue-${dateKey}`;
          const created = await tryCreateNotificationEvent({
            userId: user.id,
            assetId: asset.id,
            eventKey,
          });

          if (created) {
            overdueCount += 1;
            await sendOverdueEmail(user, asset);
          }
        }
      }
    }

    console.log('[notifications-scan]', { reason, dueSoonCount, overdueCount });
    return { dueSoonCount, overdueCount };
  } finally {
    notificationScanRunning = false;
  }
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

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  return next();
}

async function fetchAssetsForUser(user, search = '') {
  const clauses = [];
  const params = [];

  if (user.role !== 'admin') {
    clauses.push("environment = 'producao'");
  }

  if (search) {
    params.push(`%${search}%`);
    clauses.push(`LOWER(name) LIKE LOWER($${params.length})`);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return query(`SELECT * FROM assets ${whereClause} ORDER BY name ASC`, params);
}

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!username) return res.status(400).json({ error: 'username-required' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'email-invalid' });

    const passwordError = validatePasswordStrength(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const exists = await query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'email-already-registered' });

    const verifyToken = generateToken();
    const verifyCode = generateVerificationCode();
    const verifyTokenHash = hashSha256(verifyToken);
    const verifyCodeHash = hashSha256(verifyCode);
    const verifyExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

    const passwordHash = hashPassword(password);
    const result = await query(
      `INSERT INTO users (username, email, password_hash, role, email_verify_token_hash, email_verify_code_hash, email_verify_token_expires_at)
       VALUES ($1, $2, $3, 'normal', $4, $5, $6)
       RETURNING *`,
      [username, email, passwordHash, verifyTokenHash, verifyCodeHash, verifyExpiresAt.toISOString()],
    );

    const createdUser = result.rows[0];
    await ensureNotificationPreferences(createdUser.id);
    await sendVerificationEmail({ email, username, token: verifyToken, code: verifyCode });

    const emailDeliveryEnabled = Boolean(mailer);
    const message = emailDeliveryEnabled
      ? 'Conta criada. Confira seu e-mail para confirmar o cadastro.'
      : 'Conta criada, mas o envio de e-mail está desativado no servidor. Contate o administrador para configurar SMTP.';

    return res.status(201).json({
      ok: true,
      requiresEmailVerification: true,
      emailDeliveryEnabled,
      verifyEmail: email,
      message,
      verifyToken: !isProduction && !mailer ? verifyToken : undefined,
      verifyCode: !isProduction && !mailer ? verifyCode : undefined,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/verify-email', async (req, res, next) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token-required' });

    const tokenHash = hashSha256(token);
    const result = await query(
      `UPDATE users
       SET email_verified_at = NOW(),
           email_verify_token_hash = NULL,
           email_verify_code_hash = NULL,
           email_verify_token_expires_at = NULL
       WHERE email_verify_token_hash = $1
         AND email_verify_token_expires_at > NOW()
       RETURNING *`,
      [tokenHash],
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: 'token-invalid-or-expired' });
    }

    const user = result.rows[0];
    await ensureNotificationPreferences(user.id);
    return res.json({ ok: true, message: 'E-mail confirmado com sucesso.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/verify-email-code', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').replace(/\D/g, '').slice(0, 6);

    if (!isValidEmail(email)) return res.status(400).json({ error: 'email-invalid' });
    if (code.length !== 6) return res.status(400).json({ error: 'verify-code-invalid' });

    const codeHash = hashSha256(code);
    const result = await query(
      `UPDATE users
       SET email_verified_at = NOW(),
           email_verify_token_hash = NULL,
           email_verify_code_hash = NULL,
           email_verify_token_expires_at = NULL
       WHERE email = $1
         AND email_verify_code_hash = $2
         AND email_verify_token_expires_at > NOW()
       RETURNING *`,
      [email, codeHash],
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: 'verify-code-invalid-or-expired' });
    }

    const user = result.rows[0];
    await ensureNotificationPreferences(user.id);
    return res.json({ ok: true, message: 'E-mail confirmado com sucesso.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/resend-verification', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) {
      return res.status(200).json({ ok: true, message: 'Se o e-mail existir, enviaremos um novo código de confirmação.' });
    }

    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) {
      return res.status(200).json({ ok: true, message: 'Se o e-mail existir, enviaremos um novo código de confirmação.' });
    }

    const user = result.rows[0];
    if (user.email_verified_at) {
      return res.status(200).json({ ok: true, message: 'Este e-mail já foi confirmado.' });
    }

    const verifyToken = generateToken();
    const verifyCode = generateVerificationCode();
    const verifyTokenHash = hashSha256(verifyToken);
    const verifyCodeHash = hashSha256(verifyCode);
    const verifyExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

    await query(
      'UPDATE users SET email_verify_token_hash = $1, email_verify_code_hash = $2, email_verify_token_expires_at = $3 WHERE id = $4',
      [verifyTokenHash, verifyCodeHash, verifyExpiresAt.toISOString(), user.id],
    );

    await sendVerificationEmail({ email: user.email, username: user.username, token: verifyToken, code: verifyCode });

    const emailDeliveryEnabled = Boolean(mailer);
    const message = emailDeliveryEnabled
      ? 'Se o e-mail existir, enviaremos um novo código de confirmação.'
      : 'Envio de e-mail desativado no servidor. Contate o administrador para configurar SMTP.';

    return res.status(200).json({
      ok: true,
      emailDeliveryEnabled,
      message,
      verifyToken: !isProduction && !mailer ? verifyToken : undefined,
      verifyCode: !isProduction && !mailer ? verifyCode : undefined,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) {
      return res.status(200).json({ ok: true, message: 'Se o e-mail existir, enviaremos um link de redefinição.' });
    }

    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rowCount > 0) {
      const token = generateToken();
      const tokenHash = hashSha256(token);
      const expiresAt = new Date(Date.now() + 1000 * 60 * 30);

      await query(
        'UPDATE users SET reset_token_hash = $1, reset_token_expires_at = $2 WHERE email = $3',
        [tokenHash, expiresAt.toISOString(), email],
      );

      const resetUrl = `${frontendBaseUrl}/#reset-password?token=${token}`;
      await sendMail({
        to: email,
        subject: 'HubLocal: redefinicao de senha',
        html: buildHubLocalEmailHtml({
          title: 'Redefinicao de senha',
          subtitle: 'Solicitacao de seguranca da sua conta',
          greeting: 'Recebemos uma solicitacao para redefinir sua senha no HubSync.',
          contentHtml: `
            <p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#334155;">Para continuar, clique no botao abaixo e crie uma nova senha segura.</p>
          `,
          ctaLabel: 'Criar nova senha',
          ctaUrl: resetUrl,
          noteHtml: `
            <div style="padding:12px 14px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12;font-size:13px;line-height:1.6;">
              Este link expira em 30 minutos.
            </div>
          `,
        }),
      });

      if (!mailer && !isProduction) {
        return res.status(200).json({ ok: true, message: 'Link gerado para desenvolvimento.', resetToken: token });
      }

      if (!mailer && isProduction) {
        return res.status(200).json({
          ok: true,
          message: 'Envio de e-mail desativado no servidor. Contate o administrador para configurar SMTP.',
        });
      }
    }

    return res.status(200).json({ ok: true, message: 'Se o e-mail existir, enviaremos um link de redefinição.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res, next) => {
  try {
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');

    if (!token) return res.status(400).json({ error: 'token-required' });
    const passwordError = validatePasswordStrength(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const tokenHash = hashSha256(token);
    const result = await query(
      'SELECT * FROM users WHERE reset_token_hash = $1 AND reset_token_expires_at > NOW()',
      [tokenHash],
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: 'token-invalid-or-expired' });
    }

    const passwordHash = hashPassword(password);
    await query(
      'UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL WHERE id = $2',
      [passwordHash, result.rows[0].id],
    );

    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    if (!isValidEmail(email)) {
      return res.status(401).json({ error: 'invalid-credentials' });
    }

    const result = await query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'invalid-credentials' });
    }

    const userRow = result.rows[0];
    if (!verifyPassword(password, userRow.password_hash)) {
      return res.status(401).json({ error: 'invalid-credentials' });
    }

    if (!userRow.email_verified_at) {
      return res.status(403).json({ error: 'email-not-verified' });
    }

    await ensureNotificationPreferences(userRow.id);
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

app.get('/api/notifications/preferences', requireAuth, async (req, res, next) => {
  try {
    const row = await getNotificationPreferences(req.user.id);
    res.json(mapNotificationPreferences(row));
  } catch (error) {
    next(error);
  }
});

app.put('/api/notifications/preferences', requireAuth, async (req, res, next) => {
  try {
    const notifyNewAsset = req.body.notifyNewAsset !== false;
    const notifyDueSoon = req.body.notifyDueSoon !== false;
    const notifyOverdue = req.body.notifyOverdue !== false;
    const dueSoonDays = Number(req.body.dueSoonDays);

    if (!Number.isInteger(dueSoonDays) || dueSoonDays < 1 || dueSoonDays > 30) {
      return res.status(400).json({ error: 'due-soon-days-invalid' });
    }

    await ensureNotificationPreferences(req.user.id);
    const result = await query(
      `UPDATE user_notification_preferences
       SET notify_new_asset = $1,
           notify_due_soon = $2,
           notify_overdue = $3,
           due_soon_days = $4,
           updated_at = NOW()
       WHERE user_id = $5
       RETURNING *`,
      [notifyNewAsset, notifyDueSoon, notifyOverdue, dueSoonDays, req.user.id],
    );

    res.json(mapNotificationPreferences(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.get('/api/users', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const result = await query('SELECT id, username, email, role, created_at, email_verified_at FROM users ORDER BY id ASC');
    res.json(result.rows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      role: publicRole(row.role),
      createdAt: row.created_at,
      emailVerifiedAt: row.email_verified_at,
      emailVerified: Boolean(row.email_verified_at),
    })));
  } catch (error) {
    next(error);
  }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!username) return res.status(400).json({ error: 'username-required' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'email-invalid' });
    const passwordError = validatePasswordStrength(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const exists = await query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'email-already-registered' });

    const passwordHash = hashPassword(password);
    const result = await query(
      `INSERT INTO users (username, email, password_hash, role, email_verified_at)
       VALUES ($1, $2, $3, 'normal', NOW())
       RETURNING id, username, email, role, created_at, email_verified_at`,
      [username, email, passwordHash],
    );

    await ensureNotificationPreferences(result.rows[0].id);

    const row = result.rows[0];
    res.status(201).json({
      id: row.id,
      username: row.username,
      email: row.email,
      role: publicRole(row.role),
      createdAt: row.created_at,
      emailVerifiedAt: row.email_verified_at,
      emailVerified: Boolean(row.email_verified_at),
    });
  } catch (error) {
    next(error);
  }
});

app.put('/api/users/:id/role', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const targetRole = normalizeRole(req.body.role);

    if (!Number.isInteger(targetId) || targetId < 1) {
      return res.status(400).json({ error: 'user-id-invalid' });
    }

    if (!targetRole) {
      return res.status(400).json({ error: 'role-invalid' });
    }

    if (targetId === req.user.id) {
      return res.status(403).json({ error: 'self-role-change-blocked' });
    }

    const currentResult = await query('SELECT id, username, email, role FROM users WHERE id = $1', [targetId]);
    if (currentResult.rowCount === 0) {
      return res.status(404).json({ error: 'user-not-found' });
    }

    const result = await query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, email, role, created_at, email_verified_at',
      [targetRole, targetId],
    );

    const row = result.rows[0];
    res.json({
      id: row.id,
      username: row.username,
      email: row.email,
      role: publicRole(row.role),
      createdAt: row.created_at,
      emailVerifiedAt: row.email_verified_at,
      emailVerified: Boolean(row.email_verified_at),
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);

    if (!Number.isInteger(targetId) || targetId < 1) {
      return res.status(400).json({ error: 'user-id-invalid' });
    }

    if (targetId === req.user.id) {
      return res.status(403).json({ error: 'self-delete-blocked' });
    }

    const targetResult = await query('SELECT id, email, username, role FROM users WHERE id = $1', [targetId]);
    if (targetResult.rowCount === 0) {
      return res.status(404).json({ error: 'user-not-found' });
    }

    const target = targetResult.rows[0];
    const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [targetId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'user-not-found' });
    }

    await logAuditEvent({
      actorUser: req.user,
      targetUserId: target.id,
      targetEmail: target.email,
      eventType: 'user.deleted',
      payload: {
        targetUsername: target.username,
        targetRole: target.role,
      },
      req,
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get('/api/audit/events', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    const result = await query(
      `SELECT id, actor_user_id, actor_email, target_user_id, target_email, event_type, event_payload, created_at
       FROM audit_events
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );

    res.json(result.rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      actorEmail: row.actor_email,
      targetUserId: row.target_user_id,
      targetEmail: row.target_email,
      eventType: row.event_type,
      payload: row.event_payload,
      createdAt: row.created_at,
    })));
  } catch (error) {
    next(error);
  }
});

app.post('/api/notifications/run', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const result = await runDueNotifications('manual');
    res.json({ ok: true, result });
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
    const result = await fetchAssetsForUser(_req.user);
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
    const result = await fetchAssetsForUser(req.user, search);

    res.json(result.rows.map(mapAsset));
  } catch (error) {
    next(error);
  }
});

app.post('/api/assets/:id/send-renewal-email', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const bodyRecipientEmail = normalizeEmail(req.body.emailDestino || req.body.email);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'asset-id-invalid' });
    }

    const result = await query('SELECT * FROM assets WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'asset-not-found' });
    }

    const asset = mapAsset(result.rows[0]);
    const recipientEmail = bodyRecipientEmail || normalizeEmail(asset.renewalEmail);
    if (!recipientEmail.includes('@')) {
      return res.status(400).json({ error: 'recipient-email-required' });
    }

    await sendRenewalEmail(asset, recipientEmail);
    return res.json({ ok: true, recipientEmail });
  } catch (error) {
    next(error);
  }
});

app.post('/api/assets', requireAuth, async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const name = String(req.body.name || '').trim();
    const personNumber = String(req.body.personNumber || '').trim();
    const renewalEmail = normalizeEmail(req.body.renewalEmail);
    const renewalPeriodDays = 15;

    if (!name) {
      return res.status(400).json({ error: 'name-required' });
    }

    const digits = normalizePhone(personNumber);
    if (digits.length !== 10 && digits.length !== 11) {
      return res.status(400).json({ error: 'person-number-required' });
    }

    if (renewalEmail && !renewalEmail.includes('@')) {
      return res.status(400).json({ error: 'renewal-email-invalid' });
    }

    const now = new Date();
    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + renewalPeriodDays);

    const result = await query(
      `INSERT INTO assets (name, person_number, renewal_email, last_sync_at, renewal_due_at, renewal_period_days)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, formatBrazilPhone(digits), renewalEmail || null, now.toISOString(), dueDate.toISOString(), renewalPeriodDays],
    );

    const asset = mapAsset(result.rows[0]);
    await notifyUsersOnNewAsset(asset);
    res.status(201).json(asset);
  } catch (error) {
    next(error);
  }
});

app.post('/api/assets/:id/renew', requireAuth, async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

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
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    const personNumber = String(req.body.personNumber || '').trim();
    const renewalEmail = normalizeEmail(req.body.renewalEmail);
    const renewalPeriodDays = Number(req.body.renewalPeriodDays);

    if (!name) {
      return res.status(400).json({ error: 'name-required' });
    }

    const digits = normalizePhone(personNumber);
    if (digits.length !== 10 && digits.length !== 11) {
      return res.status(400).json({ error: 'person-number-required' });
    }

    if (renewalEmail && !renewalEmail.includes('@')) {
      return res.status(400).json({ error: 'renewal-email-invalid' });
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
       SET name = $1, person_number = $2, renewal_email = $3, renewal_period_days = $4, renewal_due_at = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [name, formatBrazilPhone(digits), renewalEmail || null, renewalPeriodDays, dueDate.toISOString(), id],
    );

    res.json(mapAsset(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.post('/api/assets/resolve-overdue', requireAuth, async (_req, res, next) => {
  if (_req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

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

app.get('/api/assets/export.xlsx', requireAuth, async (req, res, next) => {
  try {
    const result = await fetchAssetsForUser(req.user);
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

app.delete('/api/assets/:id', requireAuth, async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'asset-id-invalid' });
    }

    const result = await query('DELETE FROM assets WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'asset-not-found' });
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/dashboard', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const usersResult = await query('SELECT COUNT(*) as count FROM users');
    const assetsResult = await query('SELECT COUNT(*) as count FROM assets');
    const verifiedUsersResult = await query('SELECT COUNT(*) as count FROM users WHERE email_verified_at IS NOT NULL');
    const overdueAssetsResult = await query('SELECT COUNT(*) as count FROM assets WHERE renewal_due_at < NOW()');
    const dueSoonAssetsResult = await query('SELECT COUNT(*) as count FROM assets WHERE renewal_due_at >= NOW() AND renewal_due_at <= NOW() + INTERVAL \'7 days\'');
    const auditEventsResult = await query('SELECT COUNT(*) as count FROM audit_events');
    
    const recentAuditResult = await query(
      'SELECT event_type, COUNT(*) as count FROM audit_events WHERE created_at > NOW() - INTERVAL \'7 days\' GROUP BY event_type ORDER BY count DESC LIMIT 5'
    );

    res.json({
      totalUsers: parseInt(usersResult.rows[0].count),
      verifiedUsers: parseInt(verifiedUsersResult.rows[0].count),
      totalAssets: parseInt(assetsResult.rows[0].count),
      overdueAssets: parseInt(overdueAssetsResult.rows[0].count),
      dueSoonAssets: parseInt(dueSoonAssetsResult.rows[0].count),
      totalAuditEvents: parseInt(auditEventsResult.rows[0].count),
      recentEventTypes: recentAuditResult.rows.map((row) => ({
        eventType: row.event_type,
        count: parseInt(row.count),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/audit', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 500);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const eventType = String(req.query.eventType || '').trim();

    let whereClause = '';
    const params = [];

    if (eventType) {
      whereClause = 'WHERE event_type = $1';
      params.push(eventType);
    }

    const countResult = await query(
      `SELECT COUNT(*) as count FROM audit_events ${whereClause}`,
      params
    );

    const paramOffset = eventType ? 2 : 1;
    const result = await query(
      `SELECT id, actor_user_id, actor_email, target_user_id, target_email, event_type, event_payload, created_at
       FROM audit_events
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramOffset} OFFSET $${paramOffset + 1}`,
      [...params, limit, offset]
    );

    res.json({
      total: parseInt(countResult.rows[0].count),
      limit,
      offset,
      events: result.rows.map((row) => ({
        id: row.id,
        actorUserId: row.actor_user_id,
        actorEmail: row.actor_email,
        targetUserId: row.target_user_id,
        targetEmail: row.target_email,
        eventType: row.event_type,
        payload: row.event_payload,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/system-info', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    res.json({
      nodeEnv: process.env.NODE_ENV,
      port,
      smtpConfigured: Boolean(mailer),
      authSecureStatus: isAuthSecretWeak ? 'weak' : 'strong',
      corsOrigins: allowedOrigins,
      uptime: process.uptime(),
    });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, '..', 'dist')));

app.get('*', (req, res) => {
  if (isProduction) {
    // Avoid serving index.html for missing static assets (e.g. stale cached JS hash).
    if (path.extname(req.path)) {
      res.status(404).send('not-found');
      return;
    }

    // Ensure HTML entrypoint is always fresh to prevent white screens from stale asset hashes.
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(distPath, 'index.html'));
    return;
  }

  res.status(404).send('Frontend nao carregado. Rode npm run dev no ambiente de desenvolvimento.');
});

app.use((error, _req, res, _next) => {
  if (error?.message === 'cors-not-allowed') {
    return res.status(403).json({ error: 'cors-not-allowed' });
  }

  console.error(error);
  return res.status(500).json({ error: 'internal-server-error' });
});

async function start() {
  if (isProduction && isAuthSecretWeak) {
    throw new Error('AUTH_SECRET inseguro para produção. Defina uma chave forte com no mínimo 32 caracteres.');
  }

  if (isProduction && allowedOrigins.length === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS precisa ser definido em produção.');
  }

  await ensureSchema();
  await query(
    `INSERT INTO user_notification_preferences (user_id)
     SELECT id FROM users
     ON CONFLICT (user_id) DO NOTHING`,
  );

  const intervalMs = Math.max(notificationScanIntervalMinutes, 5) * 60 * 1000;
  setInterval(() => {
    runDueNotifications('interval').catch((error) => {
      console.error('[notifications-scan-error]', error);
    });
  }, intervalMs);

  runDueNotifications('startup').catch((error) => {
    console.error('[notifications-scan-error]', error);
  });

  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log(`[mail] ${mailer ? 'enabled' : 'disabled'}`);
  });
}

start().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});

// server.js
// Node.js + Express + PostgreSQL
// CORS для t.me / web.telegram.org, апсерт игрока через /api/player/sync
// и выборка через /api/player/by-tg/:tg

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

// ---- ENV ----
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL; // например, postgres://user:pass@host:5432/db
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''; // для проверки X-Telegram-Init (опционально)

// ---- DB ----
const pool = new Pool({
  connectionString: DATABASE_URL,
  // ssl нужен на Railway/Render/Neon/Heroku
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

// Инициализация таблицы (ленивая, один раз при старте)
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      callsign TEXT,
      level INTEGER DEFAULT 1,
      exp INTEGER DEFAULT 0,
      resources JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_players_telegram_id ON players(telegram_id);
  `);
}
ensureSchema().catch((e) => {
  console.error('DB schema init error:', e);
  process.exit(1);
});

// ---- CORS ----
const allowlist = [
  'https://t.me',
  'https://web.telegram.org',
  'https://telegram.org',
  'https://metaville.github.io', // твой GitHub Pages (если нужно — добавь свои домены)
];

function isAllowedOrigin(origin = '') {
  if (!origin) return true; // например, curl / сервер-2-сервер
  if (allowlist.includes(origin)) return true;
  // Разрешим *.github.io (опционально)
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin)) return true;
  return false;
}

app.use((req, res, next) => {
  // важно для корректного кеширования CORS-прослоек
  res.header('Vary', 'Origin');
  next();
});

app.use(
  cors({
    origin(origin, cb) {
      cb(null, isAllowedOrigin(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Telegram-Init', // для initData
    ],
    optionsSuccessStatus: 204,
  })
);

// Явно отвечаем на preflight для всех роутов
app.options('*', (req, res) => res.sendStatus(204));

// ---- BODY PARSER ----
app.use(express.json({ limit: '1mb' }));

// ---- HELPERS ----

/** Простейшая валидация initData из Telegram WebApp.
 *  Если заголовок X-Telegram-Init есть, проверяем. Если нет — пропускаем (для локального теста).
 *  Документация: https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
 */
function verifyTelegramInitData(initData) {
  if (!TELEGRAM_BOT_TOKEN) return true; // нет токена — не проверяем
  if (!initData) return true; // заголовок не передали — допустим для браузерного теста
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;

    // Собираем цепочку "key=value" по ключам кроме 'hash', отсортированным по алфавиту
    const dataCheckArr = [];
    for (const [key, value] of params.entries()) {
      if (key === 'hash') continue;
      dataCheckArr.push(`${key}=${value}`);
    }
    dataCheckArr.sort();
    const dataCheckString = dataCheckArr.join('\n');

    // секретный ключ = HMAC-SHA256 от 'WebAppData' с ключом SHA256(bot_token)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest())
      .digest();

    const calcHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    return calcHash === hash;
  } catch (e) {
    console.warn('verifyTelegramInitData error:', e);
    return false;
  }
}

function sanitizeInt(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function defaultResources() {
  return {
    oxygen: 200,
    energy: 600,
    mvc: 100,
    bio: 0,
    parts: 0,
    ice: 20,
    polymers: 0,
    rare: 0,
  };
}

// ---- ROUTES ----

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Получить игрока по telegram_id
app.get('/api/player/by-tg/:tg', async (req, res) => {
  try {
    const tg = sanitizeInt(req.params.tg, 0);
    if (!tg) return res.status(400).json({ error: 'bad_telegram_id' });

    const { rows } = await pool.query(
      'SELECT * FROM players WHERE telegram_id = $1 LIMIT 1',
      [tg]
    );
    const player = rows[0] || null;
    res.json({ player });
  } catch (e) {
    console.error('GET /by-tg error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Апсерт игрока
app.post('/api/player/sync', async (req, res) => {
  const origin = req.get('Origin') || '';
  const initData = req.get('X-Telegram-Init') || '';

  // Если пришло из Telegram (или заголовок есть), проверим подпись
  if ((/t\.me|telegram\.org/i.test(origin) || initData) && !verifyTelegramInitData(initData)) {
    return res.status(401).json({ error: 'bad_telegram_signature' });
  }

  try {
    const tgParam = sanitizeInt(req.query.tg || req.body.telegram_id, 0);
    if (!tgParam) return res.status(400).json({ error: 'bad_telegram_id' });

    // Собираем данные
    const body = Object(req.body || {});
    const callsign = (body.callsign || '').toString().slice(0, 64) || 'Citizen';
    const level = sanitizeInt(body.level, 1);
    const exp = sanitizeInt(body.exp, 0);
    const incomingRes = body.resources && typeof body.resources === 'object' ? body.resources : {};
    const resources = {
      ...defaultResources(),
      ...incomingRes,
    };

    // Апсерт по telegram_id
    const { rows } = await pool.query(
      `
      INSERT INTO players (telegram_id, callsign, level, exp, resources, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, now())
      ON CONFLICT (telegram_id) DO UPDATE
      SET
        callsign = COALESCE(EXCLUDED.callsign, players.callsign),
        level    = COALESCE(EXCLUDED.level, players.level),
        exp      = COALESCE(EXCLUDED.exp, players.exp),
        resources= COALESCE(EXCLUDED.resources, players.resources),
        updated_at = now()
      RETURNING *;
      `,
      [tgParam, callsign, level, exp, JSON.stringify(resources)]
    );

    const player = rows[0];
    res.json({ player });
  } catch (e) {
    console.error('POST /sync error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---- START ----
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log('CORS allowlist:', allowlist.join(', '));
  if (!DATABASE_URL) {
    console.warn('DATABASE_URL не задан — подключение к БД может не работать.');
  }
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN не задан — подпись Telegram не проверяется.');
  }
});

// API/server.js (ESM)
import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;

/* ================= ENV ================= */
const PORT = process.env.PORT || 8080;
const DB_URL = process.env.DATABASE_URL || '';

// CORS: список доменов через запятую (без завершающего /).
// Поддерживаем оба варианта переменных: FRONT_ORIGIN и FRONT_ORIGINS.
const FRONT_ORIGINS = [
  ...(process.env.FRONT_ORIGINS || '').split(','),
  ...(process.env.FRONT_ORIGIN  || '').split(','),
]
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => s.replace(/\/$/, ''));

// URL фронта для кнопки в Телеграме
const FRONT_URL = (process.env.FRONT_URL || '').replace(/\/$/, '');

// Телеграм (опционально)
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_SECRET    = process.env.TG_SECRET || '';
const TG_API       = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : null;

/* ================= DB ================= */
const isInternal = DB_URL.includes('railway.internal');
const pool = new Pool({
  connectionString: DB_URL,
  ssl: isInternal ? false : { rejectUnauthorized: false }
});
pool.on('error', (e) => console.error('PG pool error:', e));

/** Маленькая миграция, чтобы таблица точно подходила под код. */
async function ensureSchema() {
  // players: id, telegram_id (unique, not null), text/int, jsonb, created_at, last_login
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id           BIGSERIAL PRIMARY KEY,
      telegram_id  BIGINT UNIQUE NOT NULL,
      callsign     TEXT,
      level        INT  NOT NULL DEFAULT 1,
      exp          INT  NOT NULL DEFAULT 0,
      resources    JSONB NOT NULL DEFAULT '{}'::jsonb,
      progress     JSONB NOT NULL DEFAULT '{}'::jsonb,
      stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login   TIMESTAMPTZ
    );
  `);

  // На случай, если таблица была, но типы/поля отличались:
  await pool.query(`
    ALTER TABLE players
      ALTER COLUMN resources TYPE jsonb USING resources::jsonb,
      ALTER COLUMN progress  TYPE jsonb USING progress::jsonb,
      ALTER COLUMN stats     TYPE jsonb USING stats::jsonb;

    ALTER TABLE players
      ALTER COLUMN level SET DEFAULT 1,
      ALTER COLUMN exp   SET DEFAULT 0;

    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;

    CREATE UNIQUE INDEX IF NOT EXISTS players_telegram_id_uq ON players(telegram_id);
  `);

  // events (необязательно; если хочешь логировать события)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id         BIGSERIAL PRIMARY KEY,
      player_id  BIGINT,
      type       TEXT NOT NULL,
      payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/* ================= APP & CORS ================= */
const app = express();
app.use(express.json({ limit: '1mb' }));

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);            // curl/health/webhook
    const clean = origin.replace(/\/$/, '');
    if (!FRONT_ORIGINS.length || FRONT_ORIGINS.includes(clean)) return cb(null, true);
    return cb(new Error('CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With','X-Telegram-Init-Data']
};

app.use((req, _res, next) => {
  if (req.method === 'OPTIONS') {
    console.log('CORS preflight:', req.path, 'origin=', req.headers.origin);
  }
  next();
});
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use((err, _req, res, next) => {
  if (err && err.message === 'CORS') return res.status(403).json({ ok:false, error:'CORS' });
  return next(err);
});

/* ================= HELPERS ================= */
const toInt = (v, d = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/* ================= ROUTES ================= */

// Health
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok:true }); }
  catch (e) { console.error('health db:', e); res.status(500).json({ ok:false }); }
});

// GET /api/player?tg=123 — получить игрока по telegram_id
app.get('/api/player', async (req, res) => {
  try {
    const tg = toInt(req.query.tg);
    if (!tg) return res.status(400).json({ ok:false, error:'telegramId_required' });

    const q = await pool.query(
      `SELECT id, telegram_id, callsign, level, exp, resources, progress, stats, created_at, last_login
         FROM players WHERE telegram_id = $1 LIMIT 1`,
      [tg]
    );
    res.json({ ok:true, player: q.rows[0] || null });
  } catch (e) {
    console.error('get player error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// POST /api/player/sync — UPSERT по telegram_id
app.post('/api/player/sync', async (req, res) => {
  try {
    console.log('sync:', { origin: req.headers.origin, ua: req.headers['user-agent'] });

    // Берём telegramId из body, query (?tg) или из заголовка X-Telegram-Init-Data
    let telegramId = null;

    if (req.body && req.body.telegramId != null) {
      const n = toInt(req.body.telegramId);
      if (n) telegramId = n;
    }
    if (!telegramId && req.query && req.query.tg) {
      const n = toInt(req.query.tg);
      if (n) telegramId = n;
    }
    if (!telegramId) {
      const init = req.get('x-telegram-init-data');
      if (init) {
        try {
          const p = new URLSearchParams(init);
          const userStr = p.get('user');
          if (userStr) {
            const user = JSON.parse(userStr);
            const n = toInt(user?.id);
            if (n) telegramId = n;
          }
        } catch (_) {}
      }
    }

    if (!telegramId) {
      return res.status(400).json({ ok:false, error:'telegramId_required' });
    }

    const {
      callsign  = 'Citizen',
      level     = 1,
      exp       = 0,
      resources = {},
      progress  = {},
      stats     = {}
    } = req.body || {};

    // UPSERT (jsonb; stats мерджим через ||)
    const q = await pool.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, now())
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign   = COALESCE(EXCLUDED.callsign, players.callsign),
        level      = GREATEST(players.level, EXCLUDED.level),
        exp        = GREATEST(players.exp,   EXCLUDED.exp),
        resources  = EXCLUDED.resources,
        progress   = EXCLUDED.progress,
        stats      = players.stats || EXCLUDED.stats,
        last_login = now()
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, created_at, last_login;
      `,
      [telegramId, callsign, level, exp, resources, progress, stats]
    );

    res.json({ ok:true, player: q.rows[0] });
  } catch (e) {
    console.error('sync error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// (Опционально) лог событий, если таблица events есть
app.post('/api/events', async (req, res) => {
  try {
    const { playerId, type, payload = {} } = req.body || {};
    if (!playerId || !type) return res.status(400).json({ ok:false, error:'bad_request' });

    const q = await pool.query(
      `INSERT INTO events (player_id, type, payload) VALUES ($1,$2,$3::jsonb)
       RETURNING id, created_at`,
      [playerId, String(type), payload]
    );
    res.json({ ok:true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (e) {
    if (String(e?.message || '').includes('relation "events" does not exist')) {
      return res.status(501).json({ ok:false, error:'events_table_missing' });
    }
    console.error('events error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// Telegram webhook: /api/tg/webhook (для кнопки /start)
app.post('/api/tg/webhook', async (req, res) => {
  try {
    if (TG_SECRET) {
      const hdr = req.get('X-Telegram-Bot-Api-Secret-Token');
      if (hdr !== TG_SECRET) return res.sendStatus(401);
    }

    const u = req.body;
    if (u?.message && TG_API) {
      const chatId = u.message.chat.id;
      const text = (u.message.text || '').trim();
      if (text.startsWith('/start') && FRONT_URL) {
        try {
          const r = await fetch(`${TG_API}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: 'Открыть игру 👇',
              reply_markup: { inline_keyboard: [[{ text: 'Metaville', web_app: { url: FRONT_URL } }]] }
            })
          });
          const t = await r.text();
          if (!r.ok) console.error('TG sendMessage failed:', r.status, t);
          else       console.log('TG sendMessage ok');
        } catch (e) {
          console.error('TG send error:', e);
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('tg webhook error:', e);
    res.sendStatus(200);
  }
});

// Корень — просто текст
app.get('/', (_req, res) => res.type('text/plain').send('Metaville API is running'));

/* ================= START ================= */
ensureSchema()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('API on:', PORT);
      console.log('Allowed origins:', FRONT_ORIGINS.length ? FRONT_ORIGINS.join(', ') : '(any)');
      if (FRONT_URL) console.log('Front URL for TG:', FRONT_URL);
    });
  })
  .catch((e) => {
    console.error('ensureSchema failed:', e);
    process.exit(1);
  });

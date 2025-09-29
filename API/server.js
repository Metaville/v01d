// API/server.js (ESM)
// -------------------
import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;

/* ========= ENV ========= */
const PORT = process.env.PORT || 8080;
const DB_URL = process.env.DATABASE_URL;
// домены фронта через запятую, БЕЗ завершающего /
const FRONT_ORIGINS = (process.env.FRONT_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

// для кнопки в Telegram
const FRONT_URL = (process.env.FRONT_URL || '').replace(/\/$/, '') || 'https://example.com';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';     // если не задан — просто не шлём ответ
const TG_SECRET    = process.env.TG_SECRET || '';         // X-Telegram-Bot-Api-Secret-Token
const TG_API       = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : null;

/* ========= DB ========= */
const pool = new Pool({
  connectionString: DB_URL,
  // для Railway обычно нужно SSL без проверки сертификата
  ssl: DB_URL && DB_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});
pool.on('error', (e) => console.error('PG pool error:', e));

/* ========= HELPERS ========= */
const toInt = (v, d = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/* ========= CORS ========= */
const corsOptions = {
  origin(origin, cb) {
    // Без Origin (curl, webhooks) — пропускаем
    if (!origin) return cb(null, true);
    const clean = origin.replace(/\/$/, '');
    // Если список пуст — разрешаем всех (на ваше усмотрение)
    if (!FRONT_ORIGINS.length || FRONT_ORIGINS.includes(clean)) return cb(null, true);
    return cb(new Error('CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Telegram-Init-Data'],
};

/* ========= APP ========= */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  if (req.method === 'OPTIONS') {
    console.log('CORS preflight:', req.path, 'origin=', req.headers.origin);
  }
  next();
});
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// аккуратная обработка CORS-ошибки
app.use((err, _req, res, next) => {
  if (err && err.message === 'CORS') return res.status(403).json({ ok: false, error: 'CORS' });
  return next(err);
});

/* ========= ROUTES ========= */

// health
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    console.error('health db:', e);
    res.status(500).json({ ok: false });
  }
});

/**
 * GET /api/player?tg=123
 * Возвращает игрока по telegram_id (или null, если нет).
 */
app.get('/api/player', async (req, res) => {
  try {
    const tg = toInt(req.query.tg);
    if (!tg) return res.status(400).json({ ok: false, error: 'telegramId_required' });

    const q = await pool.query(
      `SELECT id, telegram_id, callsign, level, exp, resources, progress, stats
       FROM players WHERE telegram_id = $1`,
      [tg]
    );

    res.json({ ok: true, player: q.rows[0] || null });
  } catch (e) {
    console.error('get player error:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * POST /api/player/sync
 * Сохраняет/обновляет игрока (UPSERT по telegram_id).
 * Текущая схема таблицы players:
 *   id BIGSERIAL PK,
 *   telegram_id BIGINT UNIQUE NOT NULL,
 *   callsign TEXT,
 *   level INT NOT NULL DEFAULT 1,
 *   exp INT NOT NULL DEFAULT 0,
 *   resources JSONB NOT NULL DEFAULT '{}'::jsonb,
 *   progress  JSONB NOT NULL DEFAULT '{}'::jsonb,
 *   stats     JSONB NOT NULL DEFAULT '{}'::jsonb
 */
app.post('/api/player/sync', async (req, res) => {
  try {
    console.log('sync:', { origin: req.headers.origin, ua: req.headers['user-agent'] });

    // Объявляем ОДИН РАЗ и далее только присваиваем
    let telegramId = null;

    // 1) из body
    if (req.body && req.body.telegramId != null) {
      const n = toInt(req.body.telegramId);
      if (n) telegramId = n;
    }

    // 2) из query ?tg=
    if (!telegramId && req.query && req.query.tg) {
      const n = toInt(req.query.tg);
      if (n) telegramId = n;
    }

    // 3) из заголовка x-telegram-init-data (если клиент его шлёт)
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
      return res.status(400).json({ ok: false, error: 'telegramId_required' });
    }

    const {
      callsign = 'Citizen',
      level = 1,
      exp = 0,
      resources = {},
      progress = {},
      stats = {},
    } = req.body || {};

    const q = await pool.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign  = COALESCE(EXCLUDED.callsign, players.callsign),
        level     = GREATEST(players.level, EXCLUDED.level),
        exp       = GREATEST(players.exp,   EXCLUDED.exp),
        resources = EXCLUDED.resources,
        progress  = EXCLUDED.progress,
        stats     = players.stats || EXCLUDED.stats
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats;
      `,
      [telegramId, callsign, level, exp, resources, progress, stats]
    );

    res.json({ ok: true, player: q.rows[0] });
  } catch (e) {
    console.error('sync error:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * (НЕобязательно) Сохранение событий, если таблица events существует:
 *   events(id bigserial, player_id bigint, type text, payload jsonb, created_at timestamptz default now())
 */
app.post('/api/events', async (req, res) => {
  try {
    const { playerId, type, payload = {} } = req.body || {};
    if (!playerId || !type) return res.status(400).json({ ok: false, error: 'bad_request' });

    const q = await pool.query(
      `INSERT INTO events (player_id, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, created_at`,
      [playerId, type, payload]
    );
    res.json({ ok: true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (e) {
    // если таблицы нет — просто сообщим
    if (String(e?.message || '').includes('relation "events" does not exist')) {
      return res.status(501).json({ ok: false, error: 'events_table_missing' });
    }
    console.error('events error:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * Telegram webhook: POST /api/tg/webhook
 * В ответ на /start шлём кнопку с web_app.
 */
app.post('/api/tg/webhook', async (req, res) => {
  try {
    // проверка секрета (если задан)
    if (TG_SECRET) {
      const hdr = req.get('X-Telegram-Bot-Api-Secret-Token');
      if (hdr !== TG_SECRET) return res.sendStatus(401);
    }

    const u = req.body;
    if (u?.message && TG_API) {
      const chatId = u.message.chat.id;
      const text = (u.message.text || '').trim();
      if (text.startsWith('/start')) {
        try {
          const r = await fetch(`${TG_API}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: 'Открыть игру 👇',
              reply_markup: {
                inline_keyboard: [[{
                  text: 'Metaville',
                  web_app: { url: FRONT_URL }
                }]],
              },
            }),
          });
          const t = await r.text();
          if (!r.ok) console.error('TG sendMessage failed:', r.status, t);
          else console.log('TG sendMessage ok');
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

// корень
app.get('/', (_req, res) => res.type('text/plain').send('Metaville API is running'));

/* ========= START ========= */
app.listen(PORT, '0.0.0.0', () => {
  console.log('API on:', PORT);
  console.log('Allowed origins:', FRONT_ORIGINS.length ? FRONT_ORIGINS.join(', ') : '(any)');
  if (FRONT_URL) console.log('Front URL for TG:', FRONT_URL);
});

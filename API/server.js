// API/server.js  (ESM)
import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;

/* ========= ENV ========= */
const PORT = process.env.PORT || 8080;
const DB_URL = process.env.DATABASE_URL;

// таблицы
const PLAYERS_TABLE = 'v01dsql';
const EVENTS_TABLE  = 'events'; // можно не использовать, если таблицы нет

// CORS: список доменов через запятую, БЕЗ завершающего /
const ALLOWED_ORIGINS = (process.env.FRONT_ORIGIN || '')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

// Telegram Webhook
const TG_BOT_TOKEN     = process.env.TG_BOT_TOKEN || '';
const TG_SECRET        = process.env.TG_SECRET || '';
const FRONT_URL_FOR_TG = process.env.FRONT_URL || 'https://v01d-production.up.railway.app';
const TG_API           = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : null;

/* ========= DB ========= */
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false } // для Railway PG обычно нужно
});

/* ========= APP (ВАЖНЫЙ ПОРЯДОК!) ========= */
const app = express();              // 1) создаём app
app.use(express.json());            // 2) парсим json

// 3) CORS
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/health/webhook
    const o = origin.replace(/\/$/, '');
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(o)) return cb(null, true);
    return cb(new Error('CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With']
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight
// логируем префлайт, чтобы увидеть точный Origin
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    console.log('CORS preflight:', req.method, req.path, 'origin=', req.headers.origin);
  }
  next();
});

// Явно разрешим префлайт для всех API-роутов
app.options('/api/*', cors(corsOptions));

// (аккуратная обработка ошибки CORS)
app.use((err, req, res, next) => {
  if (err && err.message === 'CORS') return res.status(403).json({ ok:false, error:'CORS' });
  return next(err);
});

/* ========= ROUTES ========= */

// health
app.get('/api/health', async (_, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok:true }); }
  catch (e) { console.error('health db:', e); res.status(500).json({ ok:false }); }
});

// сохранить/обновить прогресс
app.post('/api/player/sync', async (req, res) => {
  try {
    const {
      telegramId,
      solAddress,
      callsign,
      level = 1,
      exp = 0,
      resources = {},
      progress = {},
      stats = {}
    } = req.body || {};

    if (!telegramId && !solAddress) {
      return res.status(400).json({ ok:false, error:'Need telegramId or solAddress' });
    }

    let q;
    if (telegramId) {
      q = await pool.query(
        `
        INSERT INTO ${PLAYERS_TABLE}
          (telegram_id, sol_address, callsign, level, exp, resources, progress, stats)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)
        ON CONFLICT (telegram_id) DO UPDATE SET
          sol_address = COALESCE(EXCLUDED.sol_address, ${PLAYERS_TABLE}.sol_address),
          callsign    = COALESCE(EXCLUDED.callsign, ${PLAYERS_TABLE}.callsign),
          level       = GREATEST(${PLAYERS_TABLE}.level, EXCLUDED.level),
          exp         = GREATEST(${PLAYERS_TABLE}.exp, EXCLUDED.exp),
          resources   = EXCLUDED.resources,
          progress    = EXCLUDED.progress,
          stats       = ${PLAYERS_TABLE}.stats || EXCLUDED.stats
        RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats;
        `,
        [telegramId, solAddress ?? null, callsign ?? null, level, exp, resources, progress, stats]
      );
    } else {
      q = await pool.query(
        `
        INSERT INTO ${PLAYERS_TABLE}
          (sol_address, callsign, level, exp, resources, progress, stats)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)
        ON CONFLICT (sol_address) DO UPDATE SET
          callsign    = COALESCE(EXCLUDED.callsign, ${PLAYERS_TABLE}.callsign),
          level       = GREATEСТ(${PLAYERS_TABLE}.level, EXCLUDED.level),
          exp         = GREATEСТ(${PLAYERS_TABLE}.exp, EXCLUDED.exp),
          resources   = EXCLUDED.resources,
          progress    = EXCLUDED.progress,
          stats       = ${PLAYERS_TABLE}.stats || EXCLUDED.stats
        RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats;
        `,
        [solAddress, callsign ?? null, level, exp, resources, progress, stats]
      );
    }

    res.json({ ok:true, player: q.rows[0] });
  } catch (e) {
    console.error('sync error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// (опц.) события — если создашь таблицу events
app.post('/api/events', async (req, res) => {
  try {
    const { playerId, type, payload = {} } = req.body || {};
    if (!playerId || !type) return res.status(400).json({ ok:false, error:'bad_request' });

    const q = await pool.query(
      `INSERT INTO ${EVENTS_TABLE} (player_id, type, payload) VALUES ($1,$2,$3::jsonb)
       RETURNING id, created_at`,
      [playerId, type, payload]
    );
    res.json({ ok:true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (e) {
    console.error('events error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// Telegram webhook (единственный)
app.post('/api/tg/webhook', async (req, res) => {
  try {
    const hdr = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (process.env.TG_SECRET && hdr !== process.env.TG_SECRET) return res.sendStatus(401);

    const u = req.body;
    if (u?.message && process.env.TG_BOT_TOKEN) {
      const chatId = u.message.chat.id;
      const text = (u.message.text || '').trim();

      if (text === '/start' || text.startsWith('/start')) {
        const resp = await fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: 'Открыть игру 👇',
            reply_markup: {
              inline_keyboard: [[{ text: 'Metaville', web_app: { url: process.env.FRONT_URL || 'https://v01d-production.up.railway.app' } }]]
            }
          })
        });
        const body = await resp.text();
        if (!resp.ok) console.error('TG sendMessage failed:', resp.status, body);
        else          console.log('TG sendMessage ok');
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('tg webhook error:', e);
    res.sendStatus(200);
  }
});


// корень для проверки
app.get('/', (_, res) => res.type('text/plain').send('Metaville API is running'));

/* ========= START (один раз) ========= */
app.listen(PORT, '0.0.0.0', () => console.log('API on :', PORT));



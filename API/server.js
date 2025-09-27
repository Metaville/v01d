// API/server.js (ESM)
import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;

// --------- ENV / CONFIG ----------
const PORT = process.env.PORT || 3000;

// DB
const DB_URL = process.env.DATABASE_URL;
const SSL = DB_URL && DB_URL.includes('sslmode=require')
  ? { rejectUnauthorized: false }
  : undefined;
const pool = new Pool({ connectionString: DB_URL, ssl: SSL });

// Таблицы
const PLAYERS_TABLE = 'v01dsql';    // твоя таблица прогресса
const EVENTS_TABLE  = 'events';     // создашь позже — можно оставить

// CORS: белый список из FRONT_ORIGIN, нормализуем хвостовой слэш
const ALLOWED_ORIGINS = (process.env.FRONT_ORIGIN || '')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))   // убираем завершающий /
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);   // curl/health/webhook
    const o = origin.replace(/\/$/, '');
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(o)) {
      return cb(null, true);
    }
    return cb(new Error('CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));       // обязательный preflight handler

// (необязательно, но красиво вернуть 403 вместо 500 при запрете)
app.use((err, req, res, next) => {
  if (err && err.message === 'CORS') {
    return res.status(403).json({ ok:false, error:'CORS' });
  }
  return next(err);
});

// Telegram (название переменной изменено, чтобы не конфликтовало)
const TG_BOT_TOKEN      = process.env.TG_BOT_TOKEN || '';
const TG_SECRET         = process.env.TG_SECRET || '';
const FRONT_URL_FOR_TG  = process.env.FRONT_URL || 'https://v01d-production.up.railway.app';
const TG_API            = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : null;

// --------- APP ----------
const app = express();
app.use(express.json());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);         // curl/health
    if (!ALLOWED_ORIGINS.length) return cb(null, true);
    return ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error('CORS'));
  }
}));

// health
app.get('/api/health', async (_, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { console.error('health db:', e); res.status(500).json({ ok: false }); }
});

// --------- API: sync прогресса игрока ----------
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
      return res.status(400).json({ ok: false, error: 'Need telegramId or solAddress' });
    }

    let q;
    if (telegramId) {
      // UPSERT по telegram_id (на нём должен стоять UNIQUE)
      q = await pool.query(
        `
        INSERT INTO ${PLAYERS_TABLE}
          (telegram_id, sol_address, callsign, level, exp, resources, progress, stats)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
      // UPSERT по sol_address (на нём тоже должен быть UNIQUE)
      q = await pool.query(
        `
        INSERT INTO ${PLAYERS_TABLE}
          (sol_address, callsign, level, exp, resources, progress, stats)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
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

    res.json({ ok: true, player: q.rows[0] });
  } catch (e) {
    console.error('sync error:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --------- API: журнал событий (создай таблицу events прежде чем пользоваться) ----------
app.post('/api/events', async (req, res) => {
  try {
    const { playerId, type, payload = {} } = req.body || {};
    if (!playerId || !type) return res.status(400).json({ ok: false, error: 'bad_request' });

    const q = await pool.query(
      `INSERT INTO ${EVENTS_TABLE} (player_id, type, payload) VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [playerId, type, payload]
    );
    res.json({ ok: true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (e) {
    console.error('events error:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Telegram webhook (диагностический) ---
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_SECRET    = process.env.TG_SECRET || '';
const FRONT_URL_FOR_TG = process.env.FRONT_URL || 'https://v01d-production.up.railway.app';
const TG_API = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : null;

app.post('/api/tg/webhook', async (req, res) => {
  try {
    // 1) проверка секрета
    const hdr = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (TG_SECRET && hdr !== TG_SECRET) {
      console.error('TG: bad secret header:', hdr);
      return res.sendStatus(401);
    }

    // 2) лог апдейта
    console.log('TG update:', JSON.stringify(req.body));

    // 3) обработка
    const u = req.body;
    if (u?.message && TG_API) {
      const chatId = u.message.chat.id;
      const text = (u.message.text || '').trim();

      if (text === '/start' || text.startsWith('/start')) {
        const payload = {
          chat_id: chatId,
          text: 'Открыть игру 👇',
          reply_markup: {
            inline_keyboard: [[{ text: 'Metaville', web_app: { url: FRONT_URL_FOR_TG } }]]
          }
        };

        const resp = await fetch(`${TG_API}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const body = await resp.text(); // чтобы увидеть ошибку, если будет
        if (!resp.ok) {
          console.error('TG sendMessage failed:', resp.status, body);
        } else {
          console.log('TG sendMessage ok:', body);
        }
      }
    }

    // 4) Telegram ждёт только 200 OK
    res.sendStatus(200);
  } catch (e) {
    console.error('TG webhook error:', e);
    res.sendStatus(200);
  }
});


// корень API для проверки
app.get('/', (_, res) => res.type('text/plain').send('Metaville API is running'));

// --------- START (единственный) ----------
app.listen(PORT, '0.0.0.0', () => console.log('API on :', PORT));


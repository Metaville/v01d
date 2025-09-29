// API/server.js  (ESM, Node 18+)
import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;

/* ========= ENV ========= */
const PORT          = process.env.PORT || 8080;
const DATABASE_URL  = process.env.DATABASE_URL;

// таблицы
const PLAYERS_TABLE = 'v01dsql';
const EVENTS_TABLE  = 'events'; // используйте, если эта таблица создана

// список доменов фронта для CORS (через запятую, без завершающих "/")
const ALLOWED_ORIGINS = (process.env.FRONT_ORIGIN || '')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

// URL игры для кнопки WebApp в Телеграме (ОДИН url)
const FRONT_URL_FOR_TG = (
  process.env.FRONT_URL || 'https://v01d-production.up.railway.app'
)
  .split(',')[0]                        // если по ошибке список — возьмём первый
  .trim()
  .replace(/^FRONT_ORIGIN\s*=\s*/i, ''); // если по ошибке вставили "FRONT_ORIGIN = ..."

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_SECRET    = process.env.TG_SECRET || '';
const TG_API       = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : null;

/* ========= DB ========= */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Railway PG
});

/* ========= APP ========= */
const app = express();

// --- парсеры тела запроса ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));      // поддержка x-www-form-urlencoded
app.use(express.text({ type: 'text/*' }));            // на случай text/plain

// если body — строка, попробуем распарсить JSON вручную
app.use((req, _res, next) => {
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch {}
  }
  next();
});

/* ========= CORS ========= */
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/health/webhook без Origin
    const o = origin.replace(/\/$/, '');
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(o)) {
      return cb(null, true);
    }
    return cb(new Error('CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
};

app.use(cors(corsOptions));

// логируем префлайт — удобная диагностика
app.use((req, _res, next) => {
  if (req.method === 'OPTIONS') {
    console.log('CORS preflight:', req.method, req.path, 'origin=', req.headers.origin);
  }
  next();
});

// явный префлайт для API
app.options('/api/*', cors(corsOptions));

// аккуратный ответ при ошибке CORS
app.use((err, _req, res, next) => {
  if (err && err.message === 'CORS') {
    return res.status(403).json({ ok: false, error: 'CORS' });
  }
  next(err);
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

// сохранить/обновить прогресс игрока
// ВАЖНО: колонки resources/progress/stats в таблице должны быть JSONB,
// т.к. ниже используется ::jsonb и оператор объединения "||".
app.post('/api/player/sync', async (req, res) => {
  try {
    const raw = req.body || {};

    // поддерживаем разные названия ключей
    const telegramId =
      raw.telegramId ?? raw.telegram_id ?? raw.tgId ?? raw.tg_id ??
      raw.userId ?? raw.user_id ?? null;

    const solAddress =
      raw.solAddress ?? raw.sol_address ?? raw.address ?? raw.wallet ??
      raw.phantom ?? raw.solanaAddress ?? null;

    const callsign  = raw.callsign ?? raw.nickname ?? raw.name ?? null;
    const level     = Number(raw.level ?? 1);
    const exp       = Number(raw.exp ?? 0);
    const resources = raw.resources ?? {};
    const progress  = raw.progress ?? {};
    const stats     = raw.stats ?? {};

    if (!telegramId && !solAddress) {
      console.warn('sync 400: bad body', req.headers['content-type'], req.body);
      return res.status(400).json({ ok:false, error:'Need telegramId or solAddress' });
    }

    let q;

    if (telegramId) {
      q = await pool.query(
        `
        INSERT INTO ${PLAYERS_TABLE}
          (telegram_id, sol_address, callsign, level, exp, resources, progress, stats)
        VALUES ($1,$2,$3,$4,$5,$6::json,$7::json,$8::json)
        ON CONFLICT (telegram_id) DO UPDATE SET
          sol_address = COALESCE(EXCLUDED.sol_address, ${PLAYERS_TABLE}.sol_address),
          callsign    = COALESCE(EXCLUDED.callsign,    ${PLAYERS_TABLE}.callsign),
          level       = GREATEST(${PLAYERS_TABLE}.level, EXCLUDED.level),
          exp         = GREATEST(${PLAYERS_TABLE}.exp,   EXCLUDED.exp),
         stats       = COALESCE(EXCLUDED.stats, ${PLAYERS_TABLE}.stats),
         resources   = COALESCE(EXCLUDED.resources, ${PLAYERS_TABLE}.resources),
         progress    = COALESCE(EXCLUDED.progress, ${PLAYERS_TABLE}.progress)
        RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats;
        `,
        [telegramId, solAddress ?? null, callsign, level, exp, resources, progress, stats]
      );
    } else {
      q = await pool.query(
        `
        INSERT INTO ${PLAYERS_TABLE}
          (sol_address, callsign, level, exp, resources, progress, stats)
        VALUES ($1,$2,$3,$4,$5::json,$6::json,$7::json)
        ON CONFLICT (sol_address) DO UPDATE SET
          callsign    = COALESCE(EXCLUDED.callsign,    ${PLAYERS_TABLE}.callsign),
          level       = GREATEST(${PLAYERS_TABLE}.level, EXCLUDED.level),
          exp         = GREATEST(${PLAYERS_TABLE}.exp,   EXCLUDED.exp),
          resources   = COALESCE(EXCLUDED.resources, ${PLAYERS_TABLE}.resources),
          progress    = COALESCE(EXCLUDED.progress,  ${PLAYERS_TABLE}.progress),
          stats = (COALESCE(${PLAYERS_TABLE}.stats, '{}'::json)::jsonb || COALESCE(EXCLUDED.stats,'{}'::json)::jsonb )::json
        RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats;
        `,
        [solAddress, callsign, level, exp, resources, progress, stats]
      );
    }

    res.json({ ok:true, player: q.rows[0] });
  } catch (e) {
    console.error('sync error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// (опц.) события — если есть таблица events (player_id -> players.id)
app.post('/api/events', async (req, res) => {
  try {
    const { playerId, type, payload = {} } = req.body || {};
    if (!playerId || !type) return res.status(400).json({ ok:false, error:'bad_request' });

    const q = await pool.query(
      `INSERT INTO ${EVENTS_TABLE} (player_id, type, payload)
       VALUES ($1,$2,$3::json)
       RETURNING id, created_at`,
      [playerId, type, payload]
    );

    res.json({ ok:true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (e) {
    console.error('events error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// Telegram webhook (единственный обработчик)
app.post('/api/tg/webhook', async (req, res) => {
  try {
    const hdr = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (TG_SECRET && hdr !== TG_SECRET) {
      return res.sendStatus(401);
    }

    const u = req.body;

    if (u?.message && TG_API) {
      const chatId = u.message.chat.id;
      const text = String(u.message.text || '').trim();

      if (text === '/start' || text.startsWith('/start')) {
        const resp = await fetch(`${TG_API}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: 'Открыть игру 👇',
            reply_markup: {
              inline_keyboard: [[
                { text: 'Metaville', web_app: { url: FRONT_URL_FOR_TG } }
              ]]
            }
          })
        });

        const body = await resp.text();
        if (!resp.ok) {
          console.error('TG sendMessage failed:', resp.status, body);
        } else {
          console.log('TG sendMessage ok');
        }
      }
    }

    // Телеграм ожидает 200 даже при наших ошибках, чтобы не ретраить
    res.sendStatus(200);
  } catch (e) {
    console.error('tg webhook error:', e);
    res.sendStatus(200);
  }
});

// корень для быстрой проверки
app.get('/', (_req, res) => {
  res.type('text/plain').send('Metaville API is running');
});

/* ========= START ========= */
app.listen(PORT, '0.0.0.0', () => {
  console.log('API on :', PORT);
});




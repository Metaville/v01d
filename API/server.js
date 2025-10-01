// API/server.js (ESM)
import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;

/* ===== ENV ===== */
const PORT   = process.env.PORT || 8080;
const DB_URL = process.env.DATABASE_URL;

// домены фронта через запятую (без завершающего /)
const ALLOWED_ORIGINS = (process.env.FRONT_ORIGIN || '')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

// Telegram (по желанию)
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_SECRET    = process.env.TG_SECRET || '';
const FRONT_URL    = process.env.FRONT_URL || 'https://v01d-production.up.railway.app';

/* ===== DB ===== */
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
});

/* ===== APP ===== */
const app = express();

// CORS (сначала объявляем опции, потом используем)
const corsOptions = {
  origin(origin, cb) {
    // для health, curl и TG-webhook origin может быть пустым
    if (!origin) return cb(null, true);
    const o = origin.replace(/\/$/, '');
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(o)) return cb(null, true);
    return cb(new Error('CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With','x-telegram-init-data'],
};

app.use(express.json());
app.use(cors(corsOptions));
app.options('/api/*', cors(corsOptions));

// лог префлайтов (удобно для отладки)
app.use((req, _res, next) => {
  if (req.method === 'OPTIONS') {
    console.log('CORS preflight:', req.path, 'origin=', req.headers.origin);
  }
  next();
});

// обработчик ошибки CORS
app.use((err, _req, res, next) => {
  if (err && err.message === 'CORS') return res.status(403).json({ ok:false, error:'CORS' });
  return next(err);
});

/* ===== helpers ===== */
function toInt(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function pickTelegramId(req) {
  // 1) body.telegramId
  if (req.body?.telegramId != null) {
    const n = Number(req.body.telegramId);
    if (!Number.isNaN(n)) return n;
  }
  // 2) ?tg=...
  if (req.query?.tg) {
    const n = Number(req.query.tg);
    if (!Number.isNaN(n)) return n;
  }
  // 3) x-telegram-init-data
  const init = req.get('x-telegram-init-data');
  if (init) {
    try {
      const p = new URLSearchParams(init);
      const userStr = p.get('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        const n = Number(user?.id);
        if (!Number.isNaN(n)) return n;
      }
    } catch (_) {}
  }
  return null;
}

/* ===== ROUTES ===== */

// health
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok:true }); }
  catch (e) { console.error('health db:', e); res.status(500).json({ ok:false }); }
});

// UPSERT игрока по telegram_id
app.post('/api/player/sync', async (req, res) => {
  try {
    console.log('sync hit:', { origin: req.headers.origin, ua: req.headers['user-agent'] });

    const telegramId = pickTelegramId(req);
    if (!telegramId) return res.status(400).json({ ok:false, error:'telegramId_required' });

    const {
      callsign  = 'Citizen',
      level     = 1,
      exp       = 0,
      resources = {},
      progress  = {},
      stats     = {},
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
        -- если пришёл пустой {}, оставляем старые значения
        resources = CASE
                      WHEN EXCLUDED.resources::text = '{}' THEN players.resources
                      ELSE EXCLUDED.resources
                    END,
        progress  = CASE
                      WHEN EXCLUDED.progress::text = '{}' THEN players.progress
                      ELSE EXCLUDED.progress
                    END,
        -- stats сливаем: старые || новые
        stats     = (players.stats || EXCLUDED.stats)
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats;
      `,
      [telegramId, callsign, toInt(level, 1), toInt(exp, 0), resources, progress, stats]
    );

    return res.json({ ok:true, player: q.rows[0] });
  } catch (e) {
    console.error('sync error:', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// Получить игрока по telegram_id
app.get('/api/player/by-tg/:tg', async (req, res) => {
  try {
    const tg = Number(req.params.tg);
    if (!Number.isFinite(tg)) return res.status(400).json({ ok:false, error:'bad_tg' });

    const q = await pool.query(
      `SELECT id, telegram_id, callsign, level, exp, resources, progress, stats
       FROM players WHERE telegram_id = $1 LIMIT 1`,
      [tg]
    );
    if (!q.rows.length) return res.status(404).json({ ok:false, error:'not_found' });

    return res.json({ ok:true, player: q.rows[0] });
  } catch (e) {
    console.error('get by tg error:', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// (опционально) Telegram webhook
app.post('/api/tg/webhook', async (req, res) => {
  try {
    const hdr = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (TG_SECRET && hdr !== TG_SECRET) return res.sendStatus(401);

    const u = req.body;
    if (u?.message && TG_BOT_TOKEN) {
      const chatId = u.message.chat.id;
      const text = (u.message.text || '').trim();

      if (text === '/start' || text.startsWith('/start')) {
        const resp = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: 'Открыть игру 👇',
            reply_markup: {
              inline_keyboard: [[{ text: 'Metaville', web_app: { url: FRONT_URL } }]]
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

// корень
app.get('/', (_req, res) => res.type('text/plain').send('Metaville API is running'));

/* ===== START ===== */
app.listen(PORT, '0.0.0.0', () => console.log('API on :', PORT));

// API/server.js
import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;

// ==== конфиг ====
const PORT = process.env.PORT || 3000;
const FRONT_URL = process.env.FRONT_ORIGIN || 'https://v01d-production.up.railway.app';
const TABLE = 'v01dsql';         // <— имя твоей таблицы игроков
const EVENTS_TABLE = 'events';    // если у тебя другое имя — поменяй тут

// SSL только если оно требуется в DATABASE_URL
const conn = process.env.DATABASE_URL;
const ssl = conn && conn.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString: conn, ssl });

// ==== app ====
const app = express();
app.use(express.json());

// CORS: белый список из FRONT_ORIGIN (можно несколько через запятую)
const allowed = (process.env.FRONT_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!allowed.length) return cb(null, true);
    return allowed.includes(origin) ? cb(null, true) : cb(new Error('CORS'));
  }
}));

// health
app.get('/api/health', async (_, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

// ====== API: сохранить прогресс игрока ======
/**
 * Ожидает JSON:
 * {
 *   telegramId?: number,
 *   solAddress?: string,
 *   callsign?: string,
 *   level?: number,
 *   exp?: number,
 *   resources?: object,
 *   progress?: object,
 *   stats?: object
 * }
 *
 * Требуется хотя бы telegramId ИЛИ solAddress. Поля json — кладём в jsonb.
 * Для UPSERT используем уникальные ключи (Unique) на telegram_id / sol_address.
 */
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
      q = await pool.query(
        `
        INSERT INTO ${TABLE} (telegram_id, sol_address, callsign, level, exp, resources, progress, stats, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, now())
        ON CONFLICT (telegram_id) DO UPDATE SET
          sol_address = COALESCE(EXCLUDED.sol_address, ${TABLE}.sol_address),
          callsign    = COALESCE(EXCLUDED.callsign, ${TABLE}.callsign),
          level       = GREATEST(${TABLE}.level, EXCLUDED.level),
          exp         = GREATEST(${TABLE}.exp, EXCLUDED.exp),
          resources   = EXCLUDED.resources,
          progress    = EXCLUDED.progress,
          stats       = ${TABLE}.stats || EXCLUDED.stats,
          updated_at  = now()
        RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, updated_at;
        `,
        [telegramId, solAddress ?? null, callsign ?? null, level, exp, resources, progress, stats]
      );
    } else {
      q = await pool.query(
        `
        INSERT INTO ${TABLE} (sol_address, callsign, level, exp, resources, progress, stats, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, now())
        ON CONFLICT (sol_address) DO UPDATE SET
          callsign    = COALESCE(EXCLUDED.callsign, ${TABLE}.callsign),
          level       = GREATEST(${TABLE}.level, EXCLUDED.level),
          exp         = GREATEST(${TABLE}.exp, EXCLUDED.exp),
          resources   = EXCLUDED.resources,
          progress    = EXCLUDED.progress,
          stats       = ${TABLE}.stats || EXCLUDED.stats,
          updated_at  = now()
        RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, updated_at;
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

// ====== API: записать событие ======
/**
 * Ожидает JSON: { playerId: <UUID из v01dsql.id>, type: "harvest"|"quest"|..., payload?: object }
 * Таблица events должна существовать (id bigserial, player_id uuid, type text, payload jsonb, created_at timestamptz default now()).
 */
app.post('/api/events', async (req, res) => {
  try {
    const { playerId, type, payload = {} } = req.body || {};
    if (!playerId || !type) return res.status(400).json({ ok: false, error: 'bad_request' });

    const q = await pool.query(
      `INSERT INTO ${EVENTS_TABLE} (player_id, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, created_at`,
      [playerId, type, payload]
    );
    res.json({ ok: true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (e) {
    console.error('events error:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// корень API — чтобы не путался с фронтом
app.get('/', (_, res) => res.type('text/plain').send('Metaville API is running'));

// любые не /api/* запросы можно увести на фронт (по желанию):
// app.use((req, res, next) => {
//   if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
//   return res.redirect(302, FRONT_URL + req.originalUrl);
// });

// ==== запуск ====
app.listen(PORT, '0.0.0.0', () => console.log('API on :', PORT));
